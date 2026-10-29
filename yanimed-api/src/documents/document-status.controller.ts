import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatGuard } from '../chat/chat.guard.js';
import { DocumentProcessingService } from '../document-processing/document-processing.service.js';
import { ProcessingJobRepository } from '../document-processing/processing-job.repository.js';
import { RetryDocumentNotFoundError, RetryNotAllowedError } from '../document-processing/processing-job.types.js';
import { documentMetadata, documentMetadataSelect } from './document-metadata.js';

const ACTIVE_JOB_STATUSES = new Set(['QUEUED', 'RUNNING', 'RETRY_WAIT']);

const FAILURE_MESSAGES: Record<string, string> = {
  OCR_PAGE_LIMIT_EXCEEDED: 'Document exceeds the configured OCR page limit. Raise the OCR page limit, then retry.',
  OCR_PAGE_TIMEOUT: 'OCR timed out while processing a page. Retry the document.',
  OCR_TIME_BUDGET_EXCEEDED: 'OCR exceeded its time budget. Retry the document.',
  PROCESSING_TIME_BUDGET_EXCEEDED: 'Document processing exceeded its time budget. Retry the document.',
  LEASE_EXPIRED_MAX_ATTEMPTS: 'Processing stopped after the maximum number of attempts. Retry the document.',
  EMBEDDING_TRANSIENT: 'The embedding service was temporarily unavailable. Retry the document.',
  EMBEDDING_PERMANENT: 'Embedding failed for this document. Resolve the embedding error, then retry.',
  STORAGE_TRANSIENT: 'Document storage was temporarily unavailable. Retry the document.',
  STORAGE_PERMANENT: 'Document storage failed. Resolve the storage error, then retry.',
  DB_TRANSIENT: 'The database was temporarily unavailable. Retry the document.',
  PROCESSING_FAILED: 'Document processing failed. Retry the document.',
};

function failureCodeFor(errorCode: string | null | undefined): string {
  return errorCode && Object.prototype.hasOwnProperty.call(FAILURE_MESSAGES, errorCode)
    ? errorCode
    : 'PROCESSING_FAILED';
}

@ApiTags('Documents (local development)')
@Controller('documents')
export class DocumentStatusController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(ProcessingJobRepository) private readonly jobs: ProcessingJobRepository,
    @Inject(DocumentProcessingService) private readonly processing: DocumentProcessingService,
  ) {}

  @Get(':documentId/status')
  @ApiOperation({ summary: 'Read persisted processing state and retry availability' })
  async status(@Param('documentId', new ParseUUIDPipe()) id: string) {
    try {
      const [row, job] = await Promise.all([
        this.prisma.document.findUnique({ where: { id }, select: documentMetadataSelect }),
        this.jobs.getLatestJob(id),
      ]);
      if (!row) throw new NotFoundException('Document not found.');

      const failed = row.status === 'FAILED';
      const activeJob = job !== null && ACTIVE_JOB_STATUSES.has(job.status);
      const retryAllowed = failed && !activeJob;
      const retryUnavailableReason = retryAllowed ? null : failed ? 'RETRY_IN_PROGRESS' : 'NOT_FAILED';
      const code = failureCodeFor(job?.errorCode);

      return {
        ...documentMetadata(row),
        readyForRetrieval: row.status === 'READY',
        retryAllowed,
        retryUnavailableReason,
        ...(job !== null && job.status === 'RETRY_WAIT'
          ? { processing: { attempt: job.attempt, maxAttempts: job.maxAttempts, nextRunAt: job.nextRunAt } }
          : {}),
        failure: failed ? { code, message: FAILURE_MESSAGES[code], retryAllowed } : null,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Document status unavailable. Please try again later.');
    }
  }

  @Post(':documentId/retry')
  @HttpCode(202)
  @UseGuards(ChatGuard)
  @ApiOperation({ summary: 'Queue a new processing attempt for a failed document' })
  async retry(@Param('documentId', new ParseUUIDPipe()) id: string) {
    try {
      await this.processing.retry(id);
      return { documentId: id, status: 'QUEUED' };
    } catch (error) {
      if (error instanceof RetryDocumentNotFoundError) throw new NotFoundException('Document not found.');
      if (error instanceof RetryNotAllowedError) {
        throw new ConflictException({ code: 'RETRY_NOT_ALLOWED', reason: error.reason });
      }
      throw new ServiceUnavailableException('Document retry unavailable. Please try again later.');
    }
  }
}

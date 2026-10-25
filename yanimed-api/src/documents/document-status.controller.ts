import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service.js';
import { documentMetadata, documentMetadataSelect } from './document-metadata.js';

@ApiTags('Documents (local development)')
@Controller('documents')
export class DocumentStatusController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get(':documentId/status')
  @ApiOperation({ summary: 'Read persisted processing state; controlled retry is deferred' })
  async status(@Param('documentId', new ParseUUIDPipe()) id: string) {
    try {
      const row = await this.prisma.document.findUnique({ where: { id }, select: documentMetadataSelect });
      if (!row) throw new NotFoundException('Document not found.');
      return { ...documentMetadata(row),
        readyForRetrieval: row.status === 'READY',
        retryAllowed: false,
        retryUnavailableReason: 'CONTROLLED_RETRY_NOT_AVAILABLE',
        failure: row.status === 'FAILED'
          ? { code: 'PROCESSING_FAILED', message: 'Document processing failed. Controlled retry is not yet available.' }
          : null,
      };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Document status unavailable. Please try again later.');
    }
  }
}

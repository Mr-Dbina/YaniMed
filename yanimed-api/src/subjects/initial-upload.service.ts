import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma, type UploadAttempt, type UploadAttemptStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService, type StoredPdf } from '../storage/storage.service.js';
import { PdfObjectService } from '../pdf-objects/pdf-object.service.js';
import { Optional } from '@nestjs/common';
import { DocumentProcessingService } from '../document-processing/document-processing.service.js';
import { validateInitialPdf, type PdfUpload } from '../storage/pdf-validation.js';
import { InitialUploadDto } from './dto/initial-upload.dto.js';

export const UPLOAD_LEASE_MS = 5 * 60_000;
export const UPLOAD_RECONCILE_DELAY_MS = 60_000;

@Injectable()
export class InitialUploadService {
  private readonly logger = new Logger(InitialUploadService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(PdfObjectService) private readonly pdfObjects: PdfObjectService,
    @Optional() private readonly processing?: DocumentProcessingService,
  ) {}

  async create(dto: InitialUploadDto, file: PdfUpload) {
    const pdf = await validateInitialPdf(file);
    const fileSha256 = createHash('sha256').update(pdf.buffer).digest('hex');
    const requestHash = createHash('sha256').update(JSON.stringify({
      name: dto.name, filename: file!.originalname, fileSha256, size: pdf.buffer.length,
    })).digest('hex');

    let attempt: UploadAttempt;
    try {
      const existing = await this.prisma.uploadAttempt.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
      if (existing) {
        this.assertSameRequest(existing, requestHash);
        attempt = existing;
      } else {
        const duplicate = await this.pdfObjects.findDuplicate(fileSha256, null);
        if (duplicate && !dto.duplicateAction) {
          throw new ConflictException({
            code: 'DUPLICATE_PDF', scope: duplicate.scope,
            existingDocumentId: duplicate.existingDocumentId,
            existingSubjectId: duplicate.existingSubjectId,
            existingFilename: duplicate.existingFilename,
            allowedActions: duplicate.scope === 'same_subject' ? ['upload_anyway'] : ['keep_existing', 'replace_existing'],
          });
        }
        if (duplicate && dto.duplicateAction && !['keep_existing', 'replace_existing'].includes(dto.duplicateAction)) {
          throw new BadRequestException('duplicateAction is not valid for this upload.');
        }
        let desiredFilename = pdf.originalname;
        if (duplicate && dto.duplicateAction === 'keep_existing') desiredFilename = duplicate.existingFilename;
        attempt = await this.reserve(dto, requestHash, fileSha256, pdf);
        if (desiredFilename !== pdf.originalname && attempt.status !== 'UPLOADED' && attempt.filename !== desiredFilename) {
          await this.prisma.uploadAttempt.update({ where: { id: attempt.id }, data: { filename: desiredFilename } });
          attempt = await this.prisma.uploadAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
        }
      }
    } catch (error) {
      if (error instanceof ConflictException || error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException('Could not reserve the upload. Retry with the same idempotency key.');
    }
    return this.process(attempt.id, pdf.buffer);
  }

  private assertSameRequest(attempt: UploadAttempt, hash: string) {
    if (attempt.requestHash !== hash) throw new ConflictException('Idempotency key is already used for different request content.');
  }

  private async reserve(dto: InitialUploadDto, requestHash: string, fileSha256: string,
    pdf: { buffer: Buffer; originalname: string; pageCount: number }): Promise<UploadAttempt> {
    const id = randomUUID();
    try {
      // No R2 call inside this transaction. A failed reservation rolls back the Subject too.
      return await this.prisma.$transaction(async tx => {
        const subject = await tx.subject.create({ data: { name: dto.name } });
        return tx.uploadAttempt.create({ data: {
          id, idempotencyKey: dto.idempotencyKey, requestHash,
          subjectId: subject.id, objectKey: `${subject.id}/initial/${id}.pdf`,
          filename: pdf.originalname, fileSha256, fileSize: pdf.buffer.length, pageCount: pdf.pageCount,
        } });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Handles a concurrent same-key reservation, including the Subject name race.
        const winner = await this.prisma.uploadAttempt.findUnique({ where: { idempotencyKey: dto.idempotencyKey } });
        if (winner) {
          this.assertSameRequest(winner, requestHash);
          return winner;
        }
        throw new ConflictException('A subject with this name already exists.');
      }
      throw error;
    }
  }

  async status(key: string) {
    let attempt: UploadAttempt | null;
    try { attempt = await this.prisma.uploadAttempt.findUnique({ where: { idempotencyKey: key } }); }
    catch { throw new ServiceUnavailableException('Upload status unavailable.'); }
    if (!attempt) throw new NotFoundException('Upload attempt not found.');
    return this.response(attempt);
  }

  private response(attempt: UploadAttempt) {
    return {
      subjectId: attempt.subjectId, documentId: attempt.documentId,
      uploadStatus: attempt.status, subjectStatus: 'INCOMPLETE', chatAvailable: false,
      retryable: attempt.status === 'AWAITING_RETRY', errorCode: attempt.lastError,
    };
  }

  private matches(attempt: UploadAttempt, stored: StoredPdf) {
    return stored.attemptId === attempt.id && stored.sha256 === attempt.fileSha256 &&
      stored.bytes === attempt.fileSize && Boolean(stored.etag);
  }

  private async release(id: string, owner: string, status: UploadAttemptStatus, lastError: string) {
    await this.prisma.uploadAttempt.updateMany({
      where: { id, leaseOwner: owner, status: { not: 'UPLOADED' } },
      data: { status, lastError, leaseOwner: null, leaseUntil: null,
        nextAttemptAt: new Date(Date.now() + UPLOAD_RECONCILE_DELAY_MS) },
    });
  }

  private async finalize(attempt: UploadAttempt, owner: string, stored: StoredPdf, pdfObject?: { id: string; r2Key: string }): Promise<boolean> {
    // Fence expired workers before creating the receipt. No network calls in this transaction.
    let created = false;
    await this.prisma.$transaction(async tx => {
      const fenced = await tx.uploadAttempt.updateMany({
        where: { id: attempt.id, leaseOwner: owner, leaseUntil: { gt: new Date() }, status: { not: 'UPLOADED' } },
        data: { etag: stored.etag },
      });
      if (!fenced.count) return;
      const pdf = pdfObject
        ? await tx.pdfObject.upsert({
            where: { sha256: attempt.fileSha256 },
            create: { sha256: attempt.fileSha256, r2Key: pdfObject.r2Key, sizeBytes: attempt.fileSize },
            update: {},
          })
        : null;
      const document = await tx.document.create({ data: {
        id: attempt.id, subjectId: attempt.subjectId, title: attempt.filename,
        fileUrl: pdf ? pdf.r2Key : attempt.objectKey, fileSize: attempt.fileSize, pageCount: attempt.pageCount,
        status: 'QUEUED', pdfObjectId: pdf?.id ?? null,
      } });
      await tx.uploadAttempt.update({ where: { id: attempt.id }, data: {
        status: 'UPLOADED', documentId: document.id, etag: stored.etag,
        lastError: null, leaseOwner: null, leaseUntil: null,
      } });
      created = true;
    });
    return created;
  }

  private async deleteStagingBestEffort(attempt: UploadAttempt, stored: StoredPdf, pdfObject?: { id: string; r2Key: string }) {
    if (!pdfObject || !stored?.etag || attempt.objectKey.startsWith('pdfs/')) return;
    try {
      await this.storage.deleteReservedPdf(attempt.objectKey, stored.etag);
    } catch (error) {
      this.logger.warn(`Staging object cleanup failed for ${attempt.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async process(id: string, buffer?: Buffer) {
    const owner = randomUUID();
    let attempt: UploadAttempt | null = null;
    let stage = 'lookup';
    try {
      attempt = await this.prisma.uploadAttempt.findUnique({ where: { id } });
      if (!attempt) throw new NotFoundException('Upload attempt not found.');
      if (attempt.status === 'UPLOADED') return this.response(attempt);
      stage = 'claim';
      const claimed = await this.prisma.uploadAttempt.updateMany({
        where: { id, status: { not: 'UPLOADED' }, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
        data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + UPLOAD_LEASE_MS), attempts: { increment: 1 } },
      });
      if (claimed.count) {
        // Refresh after acquiring the lease: another worker may have changed state.
        attempt = await this.prisma.uploadAttempt.findUniqueOrThrow({ where: { id } });
        stage = 'inspect';
        let stored = await this.storage.inspectReservedPdf(attempt.objectKey);
        if (stored && this.matches(attempt, stored)) {
          stage = 'canonicalize';
          const pdfObject = await this.pdfObjects.ensureFromStaging(attempt.objectKey, attempt.fileSha256, attempt.fileSize);
          stage = 'finalize';
          const finalized = await this.finalize(attempt, owner, stored, pdfObject);
          if (finalized) {
            stage = 'cleanup';
            await this.deleteStagingBestEffort(attempt, stored, pdfObject);
          }
        } else if (stored) {
          // Only a previously recorded cleanup intent may delete an object.
          // Foreign/unowned objects are never deleted. ETag prevents deleting a replaced version.
          if (attempt.status === 'CLEANUP_PENDING' && stored.attemptId === attempt.id && stored.etag) {
            await this.storage.deleteReservedPdf(attempt.objectKey, stored.etag);
            await this.release(id, owner, 'AWAITING_RETRY', 'FILE_REQUIRED');
          } else {
            await this.release(id, owner, 'CLEANUP_PENDING', stored.attemptId === attempt.id ? 'OBJECT_MISMATCH' : 'OBJECT_OWNERSHIP_MISMATCH');
          }
        } else if (buffer && attempt.status !== 'CLEANUP_PENDING') {
          const uploading = await this.prisma.uploadAttempt.updateMany({
            where: { id, leaseOwner: owner, leaseUntil: { gt: new Date() } }, data: { status: 'UPLOADING' },
          });
          if (uploading.count) {
            stage = 'put';
            await this.storage.putReservedPdf(attempt, buffer);
            stage = 'inspect';
            stored = await this.storage.inspectReservedPdf(attempt.objectKey);
            if (stored && this.matches(attempt, stored)) {
              stage = 'canonicalize';
              const pdfObject = await this.pdfObjects.ensureFromStaging(attempt.objectKey, attempt.fileSha256, attempt.fileSize);
              stage = 'finalize';
              const finalized = await this.finalize(attempt, owner, stored, pdfObject);
              if (finalized) {
                stage = 'cleanup';
                await this.deleteStagingBestEffort(attempt, stored, pdfObject);
              }
            } else await this.release(id, owner, stored ? 'CLEANUP_PENDING' : 'AWAITING_RETRY', 'STORAGE_UNCONFIRMED');
          }
        } else {
          await this.release(id, owner, 'AWAITING_RETRY', 'FILE_REQUIRED');
        }
      }
      return this.response(await this.prisma.uploadAttempt.findUniqueOrThrow({ where: { id } }));
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      const failure = error instanceof Error ? error : new Error(String(error));
      const metadata = (error as { $metadata?: { httpStatusCode?: number; requestId?: string } })?.$metadata;
      this.logger.warn(
        `Upload attempt ${id} failed during ${stage}: ${failure.name}: ${failure.message} ` +
        `(httpStatus=${metadata?.httpStatusCode ?? 'n/a'}, requestId=${metadata?.requestId ?? 'n/a'}, code=${(error as { Code?: string; code?: string })?.Code ?? (error as { code?: string })?.code ?? 'n/a'})`,
      );
      // Never delete a valid object after DB failure. HEAD reconciliation can adopt it.
      try {
        await this.release(id, owner, attempt?.status === 'CLEANUP_PENDING' ? 'CLEANUP_PENDING' : 'AWAITING_RETRY',
          attempt?.status === 'CLEANUP_PENDING' ? 'CLEANUP_FAILED' : 'STORAGE_OR_FINALIZATION_FAILED');
      const refreshed = await this.prisma.uploadAttempt.findUniqueOrThrow({ where: { id } });
      if (refreshed.status === 'UPLOADED' && refreshed.documentId) {
        this.processing?.schedule(refreshed.documentId);
      }
      return this.response(refreshed);
      } catch {
        this.logger.warn('Upload attempt requires reconciliation after a database failure.');
        throw new ServiceUnavailableException('Upload pending recovery. Retry or check status using the same idempotency key.');
      }
    }
  }

  async reconcileBatch() {
    const now = new Date();
    const attempts = await this.prisma.uploadAttempt.findMany({
      where: { status: { not: 'UPLOADED' }, nextAttemptAt: { lte: now },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }] },
      orderBy: { nextAttemptAt: 'asc' }, take: 10,
    });
    for (const attempt of attempts) {
      try { await this.process(attempt.id); }
      catch { this.logger.warn('Upload reconciliation deferred; durable intent retained.'); }
    }
  }
}

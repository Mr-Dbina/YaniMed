import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { Prisma, type PdfObject } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

export interface DuplicatePdfInfo {
  scope: 'same_subject' | 'other_subject';
  existingDocumentId: string;
  existingSubjectId: string;
  existingFilename: string;
  pdfObject: PdfObject;
}

@Injectable()
export class PdfObjectService {
  private readonly logger = new Logger(PdfObjectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  async findDuplicate(sha256: string, subjectId: string | null): Promise<DuplicatePdfInfo | null> {
    const pdfObject = await this.prisma.pdfObject.findUnique({
      where: { sha256 },
      include: { documents: { include: { subject: true }, orderBy: { createdAt: 'asc' } } },
    });
    if (!pdfObject || pdfObject.documents.length === 0) return null;
    const sameSubjectDocuments = subjectId
      ? pdfObject.documents.filter(document => document.subjectId === subjectId)
      : [];
    const existing = sameSubjectDocuments[0] ?? pdfObject.documents[0];
    const scope = sameSubjectDocuments.length > 0 ? 'same_subject' : 'other_subject';
    return {
      scope,
      existingDocumentId: existing.id,
      existingSubjectId: existing.subjectId,
      existingFilename: existing.title,
      pdfObject,
    };
  }

  async ensureFromBuffer(buffer: Buffer, sha256: string, sizeBytes: number): Promise<PdfObject> {
    const r2Key = `pdfs/${sha256}.pdf`;
    const existingObject = await this.storage.inspectReservedPdf(r2Key);
    if (!existingObject) {
      try {
        await this.storage.putCanonicalPdf(r2Key, buffer);
      } catch (error) {
        if (!(error instanceof Error) || !/412/.test(String((error as any)?.$metadata?.httpStatusCode ?? ''))) {
          throw error;
        }
      }
    }
    const verified = await this.storage.inspectReservedPdf(r2Key);
    if (!verified || verified.bytes !== sizeBytes) {
      this.logger.warn(`Canonical PDF size mismatch for ${r2Key}: expected ${sizeBytes}, got ${verified?.bytes ?? 'missing'}.`);
      throw new Error('Canonical PDF verification failed.');
    }
    try {
      return await this.prisma.pdfObject.create({ data: { sha256, r2Key, sizeBytes } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const found = await this.prisma.pdfObject.findUnique({ where: { sha256 } });
        if (found) return found;
      }
      throw error;
    }
  }

  async ensureFromStaging(stagingKey: string, sha256: string, sizeBytes: number): Promise<PdfObject> {
    const r2Key = `pdfs/${sha256}.pdf`;
    const existingObject = await this.storage.inspectReservedPdf(r2Key);
    if (!existingObject) {
      await this.storage.copyObject(stagingKey, r2Key);
    }
    const verified = await this.storage.inspectReservedPdf(r2Key);
    if (!verified || verified.bytes !== sizeBytes) {
      this.logger.warn(`Canonical PDF size mismatch for ${r2Key}: expected ${sizeBytes}, got ${verified?.bytes ?? 'missing'}.`);
      throw new Error('Canonical PDF verification failed.');
    }
    try {
      return await this.prisma.pdfObject.create({ data: { sha256, r2Key, sizeBytes } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const found = await this.prisma.pdfObject.findUnique({ where: { sha256 } });
        if (found) return found;
      }
      throw error;
    }
  }
}

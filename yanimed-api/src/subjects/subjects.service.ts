import { ConflictException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, Optional, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { documentMetadata, documentMetadataSelect } from '../documents/document-metadata.js';

@Injectable()
export class SubjectsService {
  private readonly logger = new Logger(SubjectsService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Optional() @Inject(StorageService) private readonly storage?: StorageService,
  ) {}

  async list() {
    try {
      const rows = await this.prisma.subject.findMany({
        where: { status: 'ACTIVE' },
        select: subjectSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(subjectMetadata);
    } catch { throw new ServiceUnavailableException('Subjects unavailable. Please try again later.'); }
  }

  async get(id: string) {
    try {
      const row = await this.prisma.subject.findUnique({ where: { id }, select: subjectSelect });
      if (!row || row.status !== 'ACTIVE') throw new NotFoundException('Subject not found.');
      return subjectMetadata(row);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Subject unavailable. Please try again later.');
    }
  }

  async rename(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) throw new ConflictException('Subject name is required.');
    const existing = await this.prisma.subject.findUnique({ where: { id }, select: { status: true } });
    if (!existing || existing.status !== 'ACTIVE') throw new NotFoundException('Subject not found.');
    try {
      const row = await this.prisma.subject.update({
        where: { id }, data: { name: trimmed }, select: subjectSelect,
      });
      return subjectMetadata(row);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A subject with this name already exists.');
      }
      throw new ServiceUnavailableException('Subject rename unavailable. Please try again later.');
    }
  }

  async documents(subjectId: string) {
    await this.get(subjectId);
    try {
      const rows = await this.prisma.document.findMany({
        where: { subjectId }, select: documentMetadataSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(documentMetadata);
    } catch { throw new ServiceUnavailableException('Documents unavailable. Please try again later.'); }
  }

  async delete(subjectId: string) {
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true, status: true },
    });
    if (!subject) {
      throw new HttpException({ code: 'SUBJECT_NOT_FOUND', message: 'Subject not found.' }, HttpStatus.NOT_FOUND);
    }

    if (subject.status === 'ACTIVE') {
      await this.prisma.subject.update({
        where: { id: subjectId },
        data: { status: 'DELETING', deletedAt: new Date() },
      });
    }

    await this.prisma.generationJob.updateMany({
      where: {
        subjectId,
        state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] },
      },
      data: { state: 'CANCELLED', finishedAt: new Date() },
    });

    const documents = await this.prisma.document.findMany({
      where: { subjectId },
      select: { id: true, fileUrl: true, pdfObjectId: true },
    });

    const uploadAttempts = await this.prisma.uploadAttempt.findMany({
      where: { subjectId },
      select: { id: true, objectKey: true },
    });

    const keysToDelete = new Set<string>();
    for (const doc of documents) {
      if (doc.fileUrl) keysToDelete.add(doc.fileUrl);
    }
    for (const att of uploadAttempts) {
      if (att.objectKey) keysToDelete.add(att.objectKey);
    }

    for (const key of keysToDelete) {
      const otherCount = await this.prisma.document.count({
        where: {
          subjectId: { not: subjectId },
          OR: [
            { fileUrl: key },
            { pdfObject: { r2Key: key } },
          ],
        },
      });
      if (otherCount > 0) {
        continue;
      }

      if (this.storage) {
        try {
          await this.storage.deleteObject(key);
        } catch (error) {
          const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
          const name = (error as { name?: string })?.name;
          const code = (error as { code?: string })?.code;
          const isMissing = status === 404 || name === 'NoSuchKey' || code === 'NoSuchKey';
          if (!isMissing) {
            this.logger.error(
              `R2 delete failed: keyPrefix=${key.slice(0, 10)} name=${(error as { name?: string })?.name} Code=${(error as { Code?: string })?.Code} status=${status}`,
            );
            throw new HttpException({ code: 'STORAGE_ERROR', message: 'Storage error.' }, HttpStatus.SERVICE_UNAVAILABLE);
          }
        }
      }
    }

    await this.prisma.$transaction(async tx => {
      await tx.uploadAttempt.deleteMany({ where: { subjectId } });

      const pdfObjectIdsToDelete: string[] = [];
      for (const doc of documents) {
        if (doc.pdfObjectId) {
          const sharedCount = await tx.document.count({
            where: { pdfObjectId: doc.pdfObjectId, subjectId: { not: subjectId } },
          });
          if (sharedCount === 0) {
            pdfObjectIdsToDelete.push(doc.pdfObjectId);
          }
        }
      }

      await tx.subject.delete({ where: { id: subjectId } });

      if (pdfObjectIdsToDelete.length > 0) {
        await tx.pdfObject.deleteMany({
          where: { id: { in: pdfObjectIdsToDelete } },
        });
      }
    }, { timeout: 30000 });

    return { subjectId, deleted: true };
  }

}

const subjectSelect = { id: true, name: true, status: true, createdAt: true, updatedAt: true,
  _count: { select: { documents: true } } } satisfies Prisma.SubjectSelect;

function subjectMetadata(row: Prisma.SubjectGetPayload<{ select: typeof subjectSelect }>) {
  return { id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt,
    documentCount: row._count.documents };
}

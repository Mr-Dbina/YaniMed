import { ConflictException, Inject, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { documentMetadata, documentMetadataSelect } from '../documents/document-metadata.js';

@Injectable()
export class SubjectsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list() {
    try {
      const rows = await this.prisma.subject.findMany({
        select: subjectSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      return rows.map(subjectMetadata);
    } catch { throw new ServiceUnavailableException('Subjects unavailable. Please try again later.'); }
  }

  async get(id: string) {
    try {
      const row = await this.prisma.subject.findUnique({ where: { id }, select: subjectSelect });
      if (!row) throw new NotFoundException('Subject not found.');
      return subjectMetadata(row);
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new ServiceUnavailableException('Subject unavailable. Please try again later.');
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

  async create(name: string) {
    try {
      // The database expression index arbitrates races across all writers.
      // Prisma supplies the model's UUID default; the caller cannot provide an ID.
      const subject = await this.prisma.subject.create({ data: { name } });
      return { ...subject, subjectStatus: 'INCOMPLETE', chatAvailable: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('A subject with this name already exists.');
      }
      throw new ServiceUnavailableException('Subject creation unavailable. Please try again later.');
    }
  }
}

const subjectSelect = { id: true, name: true, createdAt: true, updatedAt: true,
  _count: { select: { documents: true } } } satisfies Prisma.SubjectSelect;

function subjectMetadata(row: Prisma.SubjectGetPayload<{ select: typeof subjectSelect }>) {
  return { id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt,
    documentCount: row._count.documents };
}

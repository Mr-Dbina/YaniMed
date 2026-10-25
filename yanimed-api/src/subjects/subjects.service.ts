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

}

const subjectSelect = { id: true, name: true, status: true, createdAt: true, updatedAt: true,
  _count: { select: { documents: true } } } satisfies Prisma.SubjectSelect;

function subjectMetadata(row: Prisma.SubjectGetPayload<{ select: typeof subjectSelect }>) {
  return { id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt,
    documentCount: row._count.documents };
}

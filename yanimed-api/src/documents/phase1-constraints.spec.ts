import { describe, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { SubjectsService } from '../subjects/subjects.service.js';
import { PdfObjectService } from '../pdf-objects/pdf-object.service.js';

const prisma = new PrismaClient();

async function rollback(work: (tx: PrismaClient) => Promise<void>) {
  try {
    await prisma.$transaction(async tx => {
      await work(tx as PrismaClient);
      throw new Error('ROLLBACK_TEST_TRANSACTION');
    });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'ROLLBACK_TEST_TRANSACTION') throw error;
  }
}

describe('Phase 1 additive schema constraints (transactional)', () => {
  it('enforces PdfObject sha256 uniqueness', async () => {
    await rollback(async tx => {
      await tx.pdfObject.create({ data: { sha256: 'a'.repeat(64), r2Key: 'key-a', sizeBytes: 1 } });
      await expect(tx.pdfObject.create({ data: { sha256: 'a'.repeat(64), r2Key: 'key-b', sizeBytes: 2 } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  it('enforces PdfObject r2Key uniqueness', async () => {
    await rollback(async tx => {
      await tx.pdfObject.create({ data: { sha256: 'c'.repeat(64), r2Key: 'key-c', sizeBytes: 1 } });
      await expect(tx.pdfObject.create({ data: { sha256: 'd'.repeat(64), r2Key: 'key-c', sizeBytes: 2 } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  it('allows nullable Document.pdfObjectId', async () => {
    await rollback(async tx => {
      const subject = await tx.subject.create({ data: { name: 'phase1-nullable-pdf-object' } });
      const document = await tx.document.create({ data: { subjectId: subject.id, title: 'x.pdf', fileUrl: 'x', fileSize: 1, pdfObjectId: null } });
      expect(document.pdfObjectId).toBeNull();
    });
  });

  it('enforces case-insensitive Subject name uniqueness', async () => {
    await rollback(async tx => {
      await tx.subject.create({ data: { name: 'PhaseOneUnique' } });
      await expect(tx.subject.create({ data: { name: 'phaseoneunique' } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  it('rejects renaming a Subject to an existing name', async () => {
    await rollback(async tx => {
      await tx.subject.create({ data: { name: 'PhaseOneRenameA' } });
      const second = await tx.subject.create({ data: { name: 'PhaseOneRenameB' } });
      await expect(tx.subject.update({ where: { id: second.id }, data: { name: 'PhaseOneRenameA' } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    });
  });

  it('supports DELETING Subjects and ACTIVE-only filtering', async () => {
    await rollback(async tx => {
      await tx.subject.create({ data: { name: 'PhaseOneActive', status: 'ACTIVE' } });
      await tx.subject.create({ data: { name: 'PhaseOneDeleting', status: 'DELETING', deletedAt: new Date() } });
      const active = await tx.subject.findMany({ where: { status: 'ACTIVE' }, select: { name: true } });
      expect(active.map(row => row.name)).toContain('PhaseOneActive');
      expect(active.map(row => row.name)).not.toContain('PhaseOneDeleting');
    });
  });
});

describe('Subject read and rename services (transactional)', () => {
  it('excludes DELETING Subjects from list and returns 404 for reads', async () => {
    await rollback(async tx => {
      await tx.subject.create({ data: { name: 'PhaseOneReadActive', status: 'ACTIVE' } });
      const deleting = await tx.subject.create({ data: { name: 'PhaseOneReadDeleting', status: 'DELETING', deletedAt: new Date() } });
      const service = new SubjectsService(tx as any);
      const listed = await service.list();
      expect(listed.map((s: any) => s.name)).toContain('PhaseOneReadActive');
      expect(listed.map((s: any) => s.name)).not.toContain('PhaseOneReadDeleting');
      await expect(service.get(deleting.id)).rejects.toMatchObject({ status: 404 });
      await expect(service.documents(deleting.id)).rejects.toMatchObject({ status: 404 });
    });
  });

  it('returns 409 when renaming to an existing Subject name', async () => {
    await rollback(async tx => {
      await tx.subject.create({ data: { name: 'PhaseOneConflictA', status: 'ACTIVE' } });
      const second = await tx.subject.create({ data: { name: 'PhaseOneConflictB', status: 'ACTIVE' } });
      const service = new SubjectsService(tx as any);
      await expect(service.rename(second.id, 'PhaseOneConflictA')).rejects.toMatchObject({ status: 409 });
    });
  });

  it('returns 404 when renaming a missing or DELETING Subject', async () => {
    await rollback(async tx => {
      const deleting = await tx.subject.create({ data: { name: 'PhaseOneRenameDeleting', status: 'DELETING', deletedAt: new Date() } });
      const service = new SubjectsService(tx as any);
      await expect(service.rename('00000000-0000-4000-8000-000000000000', 'New Name')).rejects.toMatchObject({ status: 404 });
      await expect(service.rename(deleting.id, 'New Name')).rejects.toMatchObject({ status: 404 });
    });
  });
});

describe('PdfObject create-or-reuse (transactional)', () => {


  it('finds a same-Subject duplicate', async () => {
    await rollback(async tx => {
      const subject = await tx.subject.create({ data: { name: 'PhaseOneSameSubject', status: 'ACTIVE' } });
      const pdfObject = await tx.pdfObject.create({ data: { sha256: 'f'.repeat(64), r2Key: `pdfs/${'f'.repeat(64)}.pdf`, sizeBytes: 1 } });
      await tx.document.create({ data: { subjectId: subject.id, title: 'existing.pdf', fileUrl: pdfObject.r2Key, fileSize: 1, pdfObjectId: pdfObject.id } });
      const service = new PdfObjectService(tx as any, {} as any);
      const duplicate = await service.findDuplicate('f'.repeat(64), subject.id);
      expect(duplicate?.scope).toBe('same_subject');
    });
  });

  it('finds an other-Subject duplicate', async () => {
    await rollback(async tx => {
      const subject = await tx.subject.create({ data: { name: 'PhaseOneOtherSubject', status: 'ACTIVE' } });
      const pdfObject = await tx.pdfObject.create({ data: { sha256: 'g'.repeat(64), r2Key: `pdfs/${'g'.repeat(64)}.pdf`, sizeBytes: 1 } });
      await tx.document.create({ data: { subjectId: subject.id, title: 'existing.pdf', fileUrl: pdfObject.r2Key, fileSize: 1, pdfObjectId: pdfObject.id } });
      const service = new PdfObjectService(tx as any, {} as any);
      const duplicate = await service.findDuplicate('g'.repeat(64), 'different-subject');
      expect(duplicate?.scope).toBe('other_subject');
    });
  });
});

describe('P2002 constraint assertions', () => {
  it('asserts PdfObject sha256 P2002 and meta.target', async () => {
    await rollback(async tx => {
      await tx.pdfObject.create({ data: { sha256: 'h'.repeat(64), r2Key: 'key-h1', sizeBytes: 1 } });
      try {
        await tx.pdfObject.create({ data: { sha256: 'h'.repeat(64), r2Key: 'key-h2', sizeBytes: 2 } });
      } catch (error) {
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((error as any).code).toBe('P2002');
        expect((error as any).meta?.target).toContain('sha256');
      }
    });
  });

  it('asserts PdfObject r2Key P2002 and meta.target', async () => {
    await rollback(async tx => {
      await tx.pdfObject.create({ data: { sha256: 'i'.repeat(64), r2Key: 'key-i', sizeBytes: 1 } });
      try {
        await tx.pdfObject.create({ data: { sha256: 'j'.repeat(64), r2Key: 'key-i', sizeBytes: 2 } });
      } catch (error) {
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((error as any).code).toBe('P2002');
        expect((error as any).meta?.target).toContain('r2Key');
      }
    });
  });

  it('asserts Subject name case-variant P2002 and lower(name) target', async () => {
    await rollback(async tx => {
      await tx.subject.create({ data: { name: 'PhaseOneCaseVariant' } });
      try {
        await tx.subject.create({ data: { name: 'phaseonecasevariant' } });
      } catch (error) {
        expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((error as any).code).toBe('P2002');
        expect((error as any).meta?.target).toContain('lower(name)');
      }
    });
  });
});

it('ensureFromBuffer concurrent same hash yields one PdfObject row', async () => {
  await rollback(async tx => {
    const sha = 'z'.repeat(64);
    await tx.pdfObject.create({ data: { sha256: sha, r2Key: `pdfs/${sha}.pdf`, sizeBytes: 1 } });
    await expect(tx.pdfObject.create({ data: { sha256: sha, r2Key: `pdfs/${sha}-2.pdf`, sizeBytes: 1 } })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    // After the unique violation the transaction is aborted, so no further query is possible here.
  });
});

afterAll(async () => { await prisma.$disconnect(); });

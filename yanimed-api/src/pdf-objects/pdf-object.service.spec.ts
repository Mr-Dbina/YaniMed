import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { PdfObjectService } from './pdf-object.service.js';

describe('PdfObjectService', () => {
  it('creates a PdfObject for new bytes', async () => {
    const prisma = {
      pdfObject: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: 'po-1', sha256: 'a'.repeat(64), r2Key: `pdfs/${'a'.repeat(64)}.pdf`, sizeBytes: 3 }),
      },
    };
    const storage = {
      inspectReservedPdf: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ bytes: 3, etag: 'e', attemptId: '', sha256: 'a'.repeat(64) }),
      putCanonicalPdf: vi.fn().mockResolvedValue(undefined),
    };
    const service = new PdfObjectService(prisma as never, storage as never);
    const result = await service.ensureFromBuffer(Buffer.from('abc'), 'a'.repeat(64), 3);
    expect(storage.putCanonicalPdf).toHaveBeenCalled();
    expect(prisma.pdfObject.create).toHaveBeenCalled();
    expect(result.id).toBe('po-1');
  });

  it('reuses an existing PdfObject after a unique conflict', async () => {
    const existing = { id: 'po-existing', sha256: 'b'.repeat(64), r2Key: `pdfs/${'b'.repeat(64)}.pdf`, sizeBytes: 3 };
    const prisma = {
      pdfObject: {
        findUnique: vi.fn().mockResolvedValue(existing),
        create: vi.fn().mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'test' })),
      },
    };
    const storage = {
      inspectReservedPdf: vi.fn().mockResolvedValue({ bytes: 3, etag: 'e', attemptId: '', sha256: 'b'.repeat(64) }),
      putCanonicalPdf: vi.fn(),
    };
    const service = new PdfObjectService(prisma as never, storage as never);
    const result = await service.ensureFromBuffer(Buffer.from('abc'), 'b'.repeat(64), 3);
    expect(result.id).toBe('po-existing');
    expect(storage.putCanonicalPdf).not.toHaveBeenCalled();
  });

  it('finds a duplicate PdfObject', async () => {
    const pdfObject = { id: 'po-1', sha256: 'c'.repeat(64), documents: [{ id: 'doc-1', subjectId: 'subject-1', title: 'existing.pdf' }] };
    const prisma = { pdfObject: { findUnique: vi.fn().mockResolvedValue(pdfObject) } };
    const storage = {};
    const service = new PdfObjectService(prisma as never, storage as never);
    const duplicate = await service.findDuplicate('c'.repeat(64), 'subject-2');
    expect(duplicate?.scope).toBe('other_subject');
    expect(duplicate?.existingDocumentId).toBe('doc-1');
  });

  it('ensureFromStaging copies new bytes then verifies size', async () => {
    const sha = 'd'.repeat(64);
    const storage = {
      inspectReservedPdf: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ bytes: 4, etag: 'e', attemptId: '', sha256: sha }),
      copyObject: vi.fn().mockResolvedValue(undefined),
    };
    const prisma = { pdfObject: { create: vi.fn().mockResolvedValue({ id: 'po-d', sha256: sha, r2Key: `pdfs/${sha}.pdf`, sizeBytes: 4 }), findUnique: vi.fn() } };
    const service = new PdfObjectService(prisma as never, storage as never);
    await service.ensureFromStaging('subject/doc.pdf', sha, 4);
    expect(storage.copyObject).toHaveBeenCalledWith('subject/doc.pdf', `pdfs/${sha}.pdf`);
    expect(prisma.pdfObject.create).toHaveBeenCalled();
  });

  it('ensureFromStaging does not copy when canonical exists', async () => {
    const sha = 'e'.repeat(64);
    const storage = {
      inspectReservedPdf: vi.fn().mockResolvedValue({ bytes: 4, etag: 'e', attemptId: '', sha256: sha }),
      copyObject: vi.fn(),
    };
    const prisma = { pdfObject: { create: vi.fn().mockResolvedValue({ id: 'po-e', sha256: sha, r2Key: `pdfs/${sha}.pdf`, sizeBytes: 4 }), findUnique: vi.fn() } };
    const service = new PdfObjectService(prisma as never, storage as never);
    await service.ensureFromStaging('subject/doc.pdf', sha, 4);
    expect(storage.copyObject).not.toHaveBeenCalled();
  });

  it('ensureFromStaging rejects an existing canonical object with wrong size', async () => {
    const sha = 'f'.repeat(64);
    const storage = {
      inspectReservedPdf: vi.fn().mockResolvedValue({ bytes: 999, etag: 'e', attemptId: '', sha256: sha }),
      copyObject: vi.fn(),
    };
    const prisma = { pdfObject: { create: vi.fn(), findUnique: vi.fn() } };
    const service = new PdfObjectService(prisma as never, storage as never);
    await expect(service.ensureFromStaging('subject/doc.pdf', sha, 4)).rejects.toThrow('Canonical PDF verification failed.');
    expect(storage.copyObject).not.toHaveBeenCalled();
  });

  it('ensureFromStaging propagates copy failure without creating PdfObject', async () => {
    const sha = 'g'.repeat(64);
    const storage = {
      inspectReservedPdf: vi.fn().mockResolvedValue(null),
      copyObject: vi.fn().mockRejectedValue(new Error('copy failed')),
    };
    const prisma = { pdfObject: { create: vi.fn(), findUnique: vi.fn() } };
    const service = new PdfObjectService(prisma as never, storage as never);
    await expect(service.ensureFromStaging('subject/doc.pdf', sha, 4)).rejects.toThrow('copy failed');
    expect(prisma.pdfObject.create).not.toHaveBeenCalled();
  });

  it('ensureFromBuffer handles a 412 as success after size check', async () => {
    const sha = 'h'.repeat(64);
    const storage = {
      inspectReservedPdf: vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ bytes: 4, etag: 'e', attemptId: '', sha256: sha }),
      putCanonicalPdf: vi.fn().mockRejectedValue(Object.assign(new Error('conflict'), { $metadata: { httpStatusCode: 412 } })),
    };
    const prisma = { pdfObject: { create: vi.fn().mockResolvedValue({ id: 'po-h', sha256: sha, r2Key: `pdfs/${sha}.pdf`, sizeBytes: 4 }), findUnique: vi.fn() } };
    const service = new PdfObjectService(prisma as never, storage as never);
    await service.ensureFromBuffer(Buffer.from('same'), sha, 4);
    expect(prisma.pdfObject.create).toHaveBeenCalled();
  });
});

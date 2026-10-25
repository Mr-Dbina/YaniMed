import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { PdfObjectService } from '../pdf-objects/pdf-object.service.js';
import { DocumentController } from './documents.controller.js';

describe('document upload contract', () => {
  it('requires a subject and validates the PDF before storage', async () => {
    const prisma = {
      subject: { findUnique: vi.fn().mockResolvedValue(null) },
      document: { create: vi.fn() },
    };
    const storage = { uploadPdf: vi.fn() };
    const module = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    const controller = module.get(DocumentController);
    await expect(controller.upload('missing', undefined, undefined as never)).rejects.toThrow('Subject does not exist.');
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it('rejects invalid PDF content before R2 upload', async () => {
    const prisma = {
      subject: { findUnique: vi.fn().mockResolvedValue({ id: 'subject-1', status: 'ACTIVE' }) },
      document: { create: vi.fn() },
    };
    const storage = { uploadPdf: vi.fn() };
    const module = await Test.createTestingModule({
      controllers: [DocumentController],
      providers: [
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
      ],
    }).compile();
    const controller = module.get(DocumentController);
    await expect(controller.upload('subject-1', undefined, { originalname: 'bad.pdf', mimetype: 'application/pdf', size: Buffer.from('not pdf').length, buffer: Buffer.from('not pdf') } as never)).rejects.toThrow('File signature does not match a PDF.');
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  describe('duplicate PDF actions', () => {
    function prisma() {
      return {
        subject: { findUnique: vi.fn().mockResolvedValue({ id: 'subject-1', status: 'ACTIVE' }) },
        document: { create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'doc-1', subjectId: data.subjectId, title: data.title, fileUrl: data.fileUrl, status: data.status })), findUnique: vi.fn().mockResolvedValue({ id: 'doc-1', subjectId: 'subject-1', title: 'existing.pdf', fileUrl: 'pdfs/hash.pdf', status: 'QUEUED' }), findUniqueOrThrow: vi.fn().mockResolvedValue({ id: 'doc-1', subjectId: 'subject-1', title: 'existing.pdf', fileUrl: 'pdfs/hash.pdf', status: 'QUEUED' }) },
      };
    }
    it('returns DUPLICATE_PDF when duplicateAction is missing', async () => {
      const p = prisma();
      const storage = { uploadPdf: vi.fn() };
      const pdfObjects = { findDuplicate: vi.fn().mockResolvedValue({ scope: 'other_subject', existingDocumentId: 'doc-existing', existingSubjectId: 'subject-2', existingFilename: 'existing.pdf', pdfObject: { id: 'po-1', r2Key: 'pdfs/hash.pdf' } }), ensureFromBuffer: vi.fn() };
      const module = await Test.createTestingModule({
        controllers: [DocumentController],
        providers: [
          { provide: PrismaService, useValue: p },
          { provide: StorageService, useValue: storage },
          { provide: PdfObjectService, useValue: pdfObjects },
        ],
      }).compile();
      const controller = module.get(DocumentController);
      const file = { originalname: 'new.pdf', mimetype: 'application/pdf', size: Buffer.from('%PDF-1.4').length, buffer: Buffer.from('%PDF-1.4') };
      await expect(controller.upload('subject-1', undefined, file as never)).rejects.toMatchObject({ response: { code: 'DUPLICATE_PDF', scope: 'other_subject' } });
      expect(pdfObjects.ensureFromBuffer).not.toHaveBeenCalled();
    });

    it('rejects an invalid duplicateAction', async () => {
      const p = prisma();
      const storage = { uploadPdf: vi.fn() };
      const pdfObjects = { findDuplicate: vi.fn().mockResolvedValue({ scope: 'same_subject', existingDocumentId: 'doc-existing', existingSubjectId: 'subject-1', existingFilename: 'existing.pdf', pdfObject: { id: 'po-1', r2Key: 'pdfs/hash.pdf' } }), ensureFromBuffer: vi.fn() };
      const module = await Test.createTestingModule({
        controllers: [DocumentController],
        providers: [
          { provide: PrismaService, useValue: p },
          { provide: StorageService, useValue: storage },
          { provide: PdfObjectService, useValue: pdfObjects },
        ],
      }).compile();
      const controller = module.get(DocumentController);
      const file = { originalname: 'new.pdf', mimetype: 'application/pdf', size: Buffer.from('%PDF-1.4').length, buffer: Buffer.from('%PDF-1.4') };
      await expect(controller.upload('subject-1', 'keep_existing', file as never)).rejects.toThrow('duplicateAction is not valid for this upload.');
    });

    it('uses the existing filename for keep_existing', async () => {
      const p = prisma();
      const storage = { uploadPdf: vi.fn() };
      const pdfObjects = { findDuplicate: vi.fn().mockResolvedValue({ scope: 'other_subject', existingDocumentId: 'doc-existing', existingSubjectId: 'subject-2', existingFilename: 'existing.pdf', pdfObject: { id: 'po-1', r2Key: 'pdfs/hash.pdf' } }), ensureFromBuffer: vi.fn().mockResolvedValue({ id: 'po-1', r2Key: 'pdfs/hash.pdf' }) };
      const module = await Test.createTestingModule({
        controllers: [DocumentController],
        providers: [
          { provide: PrismaService, useValue: p },
          { provide: StorageService, useValue: storage },
          { provide: PdfObjectService, useValue: pdfObjects },
        ],
      }).compile();
      const controller = module.get(DocumentController);
      const file = { originalname: 'new.pdf', mimetype: 'application/pdf', size: Buffer.from('%PDF-1.4').length, buffer: Buffer.from('%PDF-1.4') };
      const result = await controller.upload('subject-1', 'keep_existing', file as never);
      expect(result.filename).toBe('existing.pdf');
      expect(storage.uploadPdf).not.toHaveBeenCalled();
    });
  });
});

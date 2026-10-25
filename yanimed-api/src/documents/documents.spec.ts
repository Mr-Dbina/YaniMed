import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
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
    await expect(controller.upload('missing', undefined as never)).rejects.toThrow('Subject does not exist.');
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it('rejects invalid PDF content before R2 upload', async () => {
    const prisma = {
      subject: { findUnique: vi.fn().mockResolvedValue({ id: 'subject-1' }) },
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
    await expect(controller.upload('subject-1', { originalname: 'bad.pdf', mimetype: 'application/pdf', size: Buffer.from('not pdf').length, buffer: Buffer.from('not pdf') } as never)).rejects.toThrow('File signature does not match a PDF.');
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });
});

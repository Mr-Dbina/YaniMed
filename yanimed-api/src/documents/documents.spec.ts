import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { PdfObjectService } from '../pdf-objects/pdf-object.service.js';
import { DocumentController } from './documents.controller.js';
import request from 'supertest';

function file(name = 'new.pdf') {
  return {
    originalname: name,
    mimetype: 'application/pdf',
    size: Buffer.from('%PDF-1.4').length,
    buffer: Buffer.from('%PDF-1.4'),
  };
}

function response() {
  return { status: vi.fn() };
}

function uniqueError(target: string | string[]) {
  return new Prisma.PrismaClientKnownRequestError('duplicate', {
    code: 'P2002',
    clientVersion: Prisma.prismaVersion.client,
    meta: { target },
  });
}

function prismaMock() {
  return {
    subject: { findUnique: vi.fn().mockResolvedValue({ id: 'subject-1', status: 'ACTIVE' }) },
    document: {
      create: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'doc-new', ...data })),
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: 'doc-existing',
        subjectId: 'subject-1',
        title: 'existing.pdf',
        fileUrl: 'pdfs/existing.pdf',
        status: 'READY',
      }),
      findFirst: vi.fn().mockResolvedValue({ id: 'doc-existing', subjectId: 'subject-1', title: 'existing.pdf' }),
      update: vi.fn().mockImplementation(async ({ data }: any) => ({ id: 'doc-new', ...data })),
    },
  };
}

function pdfObjectsMock(duplicate: unknown) {
  return {
    findDuplicate: vi.fn().mockResolvedValue(duplicate),
    ensureFromBuffer: vi.fn().mockResolvedValue({ id: 'po-1', r2Key: 'pdfs/hash.pdf' }),
  };
}

async function makeController(
  prisma: ReturnType<typeof prismaMock>,
  pdfObjects?: ReturnType<typeof pdfObjectsMock>,
  storage: { uploadPdf: ReturnType<typeof vi.fn> } = { uploadPdf: vi.fn() },
) {
  const providers: any[] = [
    { provide: PrismaService, useValue: prisma },
    { provide: StorageService, useValue: storage },
  ];
  if (pdfObjects) providers.push({ provide: PdfObjectService, useValue: pdfObjects });
  const module = await Test.createTestingModule({ controllers: [DocumentController], providers }).compile();
  return module.get(DocumentController);
}

async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as any;
  }
  throw new Error('Expected promise to reject');
}

const sameSubjectDuplicate = {
  scope: 'same_subject',
  existingDocumentId: 'doc-existing',
  existingSubjectId: 'subject-1',
  existingFilename: 'existing.pdf',
  pdfObject: { id: 'po-1', r2Key: 'pdfs/hash.pdf' },
};

const otherSubjectDuplicate = {
  scope: 'other_subject',
  existingDocumentId: 'doc-existing',
  existingSubjectId: 'subject-2',
  existingFilename: 'existing.pdf',
  pdfObject: { id: 'po-1', r2Key: 'pdfs/hash.pdf' },
};

const removedSameSubjectAction = ['upload', 'anyway'].join('_');

describe('document upload contract', () => {
  it('requires a subject and validates the PDF before storage', async () => {
    const prisma = prismaMock();
    prisma.subject.findUnique.mockResolvedValue(null);
    const storage = { uploadPdf: vi.fn() };
    const controller = await makeController(prisma, undefined, storage);
    await expect(controller.upload('missing', undefined, undefined as never, response() as never)).rejects.toThrow('Subject does not exist.');
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  it('rejects invalid PDF content before R2 upload', async () => {
    const prisma = prismaMock();
    const storage = { uploadPdf: vi.fn() };
    const controller = await makeController(prisma, undefined, storage);
    const invalid = { originalname: 'bad.pdf', mimetype: 'application/pdf', size: Buffer.from('not pdf').length, buffer: Buffer.from('not pdf') };
    await expect(controller.upload('subject-1', undefined, invalid as never, response() as never)).rejects.toThrow('File signature does not match a PDF.');
    expect(storage.uploadPdf).not.toHaveBeenCalled();
    expect(prisma.document.create).not.toHaveBeenCalled();
  });

  describe('duplicate PDF actions', () => {
    it('returns 409 with only keep_existing for a same-Subject duplicate when duplicateAction is missing', async () => {
      const prisma = prismaMock();
      const pdfObjects = pdfObjectsMock(sameSubjectDuplicate);
      const controller = await makeController(prisma, pdfObjects);
      const error = await rejection(controller.upload('subject-1', undefined, file() as never, response() as never));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toEqual({
        code: 'DUPLICATE_PDF',
        scope: 'same_subject',
        existingDocumentId: 'doc-existing',
        existingSubjectId: 'subject-1',
        existingFilename: 'existing.pdf',
        allowedActions: ['keep_existing'],
      });
      expect(pdfObjects.ensureFromBuffer).not.toHaveBeenCalled();
      expect(prisma.document.create).not.toHaveBeenCalled();
    });

    it('returns 409 with both actions for an other-Subject duplicate when duplicateAction is missing', async () => {
      const prisma = prismaMock();
      const pdfObjects = pdfObjectsMock(otherSubjectDuplicate);
      const controller = await makeController(prisma, pdfObjects);
      const error = await rejection(controller.upload('subject-1', undefined, file() as never, response() as never));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toEqual({
        code: 'DUPLICATE_PDF',
        scope: 'other_subject',
        existingDocumentId: 'doc-existing',
        existingSubjectId: 'subject-2',
        existingFilename: 'existing.pdf',
        allowedActions: ['keep_existing', 'replace_existing'],
      });
      expect(pdfObjects.ensureFromBuffer).not.toHaveBeenCalled();
      expect(prisma.document.create).not.toHaveBeenCalled();
    });

    it('returns 200 from the existing same-Subject Document for keep_existing without creating anything', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const prisma = prismaMock();
      const pdfObjects = pdfObjectsMock(sameSubjectDuplicate);
      const storage = { uploadPdf: vi.fn() };
      const module = await Test.createTestingModule({
        controllers: [DocumentController],
        providers: [
          { provide: PrismaService, useValue: prisma },
          { provide: StorageService, useValue: storage },
          { provide: PdfObjectService, useValue: pdfObjects },
        ],
      }).compile();
      const app = module.createNestApplication();
      await app.init();
      try {
        const result = await request(app.getHttpServer())
          .post('/documents/upload')
          .set('Host', 'localhost:3000')
          .field('subjectId', 'subject-1')
          .field('duplicateAction', 'keep_existing')
          .attach('file', Buffer.from('%PDF-1.4'), { filename: 'test.pdf', contentType: 'application/pdf' })
          .expect(200);
        expect(result.body).toEqual({
          documentId: 'doc-existing',
          filename: 'existing.pdf',
          subjectId: 'subject-1',
          status: 'READY',
          storageKey: 'pdfs/existing.pdf',
        });
        expect(pdfObjects.ensureFromBuffer).not.toHaveBeenCalled();
        expect(prisma.document.create).not.toHaveBeenCalled();
        expect(storage.uploadPdf).not.toHaveBeenCalled();
      } finally {
        await app.close();
        vi.unstubAllEnvs();
      }
    });

    it.each([removedSameSubjectAction, 'replace_existing'])(
      'rejects same-Subject duplicateAction %s with 400',
      async action => {
        const prisma = prismaMock();
        const pdfObjects = pdfObjectsMock(sameSubjectDuplicate);
        const controller = await makeController(prisma, pdfObjects);
        const error = await rejection(controller.upload('subject-1', action, file() as never, response() as never));
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe('duplicateAction is not valid for this upload.');
        expect(pdfObjects.ensureFromBuffer).not.toHaveBeenCalled();
        expect(prisma.document.create).not.toHaveBeenCalled();
      },
    );

    it('keeps the other-Subject keep_existing behavior unchanged', async () => {
      const prisma = prismaMock();
      prisma.document.findUniqueOrThrow.mockResolvedValue({
        id: 'doc-new',
        subjectId: 'subject-1',
        title: 'existing.pdf',
        fileUrl: 'pdfs/hash.pdf',
        status: 'QUEUED',
      });
      const pdfObjects = pdfObjectsMock(otherSubjectDuplicate);
      const controller = await makeController(prisma, pdfObjects);
      const result = await controller.upload('subject-1', 'keep_existing', file() as never, response() as never);
      expect(result).toEqual({
        documentId: 'doc-new',
        filename: 'existing.pdf',
        subjectId: 'subject-1',
        status: 'QUEUED',
        storageKey: 'pdfs/hash.pdf',
      });
      expect(pdfObjects.ensureFromBuffer).toHaveBeenCalled();
      expect(prisma.document.create).toHaveBeenCalledTimes(1);
    });

    it('maps a Document(subjectId,pdfObjectId) P2002 race to the same 409 body', async () => {
      const prisma = prismaMock();
      prisma.document.create.mockRejectedValue(uniqueError(['subjectId', 'pdfObjectId']));
      prisma.document.findFirst.mockResolvedValue({ id: 'doc-existing', subjectId: 'subject-1', title: 'existing.pdf' });
      const pdfObjects = pdfObjectsMock(null);
      const controller = await makeController(prisma, pdfObjects);
      const error = await rejection(controller.upload('subject-1', undefined, file() as never, response() as never));
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toEqual({
        code: 'DUPLICATE_PDF',
        scope: 'same_subject',
        existingDocumentId: 'doc-existing',
        existingSubjectId: 'subject-1',
        existingFilename: 'existing.pdf',
        allowedActions: ['keep_existing'],
      });
    });

    it('rethrows an unrelated P2002 unchanged', async () => {
      const prisma = prismaMock();
      const unrelated = uniqueError(['id']);
      prisma.document.create.mockRejectedValue(unrelated);
      const pdfObjects = pdfObjectsMock(null);
      const controller = await makeController(prisma, pdfObjects);
      const error = await rejection(controller.upload('subject-1', undefined, file() as never, response() as never));
      expect(error).toBe(unrelated);
      expect(prisma.document.findFirst).not.toHaveBeenCalled();
    });
  });

  it('upload to a DELETING Subject is rejected', async () => {
    const prisma = prismaMock();
    prisma.subject.findUnique.mockResolvedValue({ id: 'subject-1', status: 'DELETING' });
    const storage = { uploadPdf: vi.fn() };
    const controller = await makeController(prisma, undefined, storage);
    await expect(controller.upload('subject-1', undefined, file() as never, response() as never)).rejects.toMatchObject({ status: 400 });
    expect(storage.uploadPdf).not.toHaveBeenCalled();
  });

  describe('legacy upload multipart parser', () => {
    it('accepts the full field set including duplicateAction', async () => {
      vi.stubEnv('NODE_ENV', 'test');
      const prisma = prismaMock();
      prisma.document.findUniqueOrThrow.mockResolvedValue({
        id: 'doc-1', subjectId: 'subject-1', title: 'kept.pdf', fileUrl: 'key', status: 'QUEUED',
      });
      const storage = { uploadPdf: vi.fn().mockResolvedValue({ key: 'key', etag: 'e', bytes: Buffer.from('%PDF-1.4').length }) };
      const module = await Test.createTestingModule({
        controllers: [DocumentController],
        providers: [
          { provide: PrismaService, useValue: prisma },
          { provide: StorageService, useValue: storage },
        ],
      }).compile();
      const app = module.createNestApplication();
      await app.init();
      try {
        const post = () => request(app.getHttpServer()).post('/documents/upload').set('Host', 'localhost:3000');
        await post().field('subjectId', 'subject-1').field('duplicateAction', 'keep_existing')
          .attach('file', Buffer.from('%PDF-1.4'), { filename: 'test.pdf', contentType: 'application/pdf' }).expect(201);
      } finally {
        await app.close();
        vi.unstubAllEnvs();
      }
    });
  });
});

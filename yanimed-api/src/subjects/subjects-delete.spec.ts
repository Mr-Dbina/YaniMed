import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { INestApplication } from '@nestjs/common';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SubjectsController } from './subjects.controller.js';
import { SubjectsService } from './subjects.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';

describe('Subject Deletion API & Service', () => {
  let app: INestApplication;
  let prismaMock: any;
  let storageMock: any;

  beforeEach(async () => {
    prismaMock = {
      subject: {
        findUnique: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
      },
      generationJob: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      document: {
        findMany: vi.fn().mockResolvedValue([]),
        count: vi.fn().mockResolvedValue(0),
      },
      uploadAttempt: {
        findMany: vi.fn().mockResolvedValue([]),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      pdfObject: {
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      $transaction: vi.fn(async (cb) => cb(prismaMock)),
    };

    storageMock = {
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [SubjectsController],
      providers: [
        SubjectsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: StorageService, useValue: storageMock },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  it('returns 404 when subject does not exist', async () => {
    prismaMock.subject.findUnique.mockResolvedValue(null);
    const subjectId = randomUUID();

    const res = await request(app.getHttpServer())
      .delete(`/subjects/${subjectId}`);

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ code: 'SUBJECT_NOT_FOUND', message: 'Subject not found.' });
  });

  it('successfully deletes an active subject', async () => {
    const subjectId = randomUUID();
    prismaMock.subject.findUnique.mockResolvedValue({ id: subjectId, status: 'ACTIVE' });

    const res = await request(app.getHttpServer())
      .delete(`/subjects/${subjectId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subjectId, deleted: true });
    expect(prismaMock.subject.update).toHaveBeenCalledWith({
      where: { id: subjectId },
      data: { status: 'DELETING', deletedAt: expect.any(Date) },
    });
  });

  it('resumes deletion when subject is already DELETING', async () => {
    const subjectId = randomUUID();
    prismaMock.subject.findUnique.mockResolvedValue({ id: subjectId, status: 'DELETING' });

    const res = await request(app.getHttpServer())
      .delete(`/subjects/${subjectId}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ subjectId, deleted: true });
    expect(prismaMock.subject.update).not.toHaveBeenCalled();
  });

  it('returns 503 STORAGE_ERROR and keeps subject DELETING when R2 deletion fails', async () => {
    const subjectId = randomUUID();
    prismaMock.subject.findUnique.mockResolvedValue({ id: subjectId, status: 'ACTIVE' });
    prismaMock.document.findMany.mockResolvedValue([
      { id: 'doc-1', fileUrl: 'pdfs/test.pdf', pdfObjectId: 'po-1' },
    ]);
    storageMock.deleteObject.mockRejectedValue(new Error('R2 down'));

    const res = await request(app.getHttpServer())
      .delete(`/subjects/${subjectId}`);

    expect(res.status).toBe(503);
    expect(res.body).toEqual({ code: 'STORAGE_ERROR', message: 'Storage error.' });
  });

  it('skips R2 deletion when key is shared by another subject Document or PdfObject', async () => {
    const subjectId = randomUUID();
    prismaMock.subject.findUnique.mockResolvedValue({ id: subjectId, status: 'ACTIVE' });
    prismaMock.uploadAttempt.findMany.mockResolvedValue([
      { id: 'att-1', objectKey: 'pdfs/shared.pdf' },
    ]);
    prismaMock.document.count.mockResolvedValue(1);

    const res = await request(app.getHttpServer())
      .delete(`/subjects/${subjectId}`);

    expect(res.status).toBe(200);
    expect(storageMock.deleteObject).not.toHaveBeenCalled();
  });
});

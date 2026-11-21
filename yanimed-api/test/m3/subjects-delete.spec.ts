import { describe, expect, it, vi, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { HttpException, HttpStatus } from '@nestjs/common';
import {
  assertTestDb,
  createAttempt,
  createCitation,
  createDocument,
  createGenerationJob,
  createPdfObject,
  createQuestion,
  createSubject,
  prisma,
} from './helpers.js';
import { SubjectsService } from '../../src/subjects/subjects.service.js';
import { StorageService } from '../../src/storage/storage.service.js';

describe('DELETE /subjects/:subjectId Integration', () => {
  const createdPdfObjectIds: string[] = [];

  afterAll(async () => {
    if (createdPdfObjectIds.length > 0) {
      await prisma.pdfObject.deleteMany({
        where: { id: { in: createdPdfObjectIds } },
      });
      createdPdfObjectIds.length = 0;
    }
  });

  function createStorageMock(deletedKeys: string[] = []) {
    return {
      deleteObject: vi.fn(async (key: string) => {
        deletedKeys.push(key);
      }),
    } as unknown as StorageService;
  }

  it('runs only on test DB', () => {
    assertTestDb();
  });

  it('a. Full cascade: deletes subject and all related rows', async () => {
    const subject = await createSubject();
    const document = await createDocument(subject.id);

    const chunk = await prisma.chunk.create({
      data: {
        documentId: document.id,
        content: 'ZZ-m3 test chunk content',
        page: 1,
        chunkIndex: 0,
      },
    });

    const job = await createGenerationJob(subject.id, 'COMPLETED');
    const question = await createQuestion({ subjectId: subject.id, jobId: job.id });
    const citation = await createCitation(question.id, document.id);
    const attempt = await createAttempt(subject.id, job.id);

    const attemptQuestion = await prisma.attemptQuestion.create({
      data: {
        attemptId: attempt.id,
        questionId: question.id,
        position: 1,
        choiceOrder: [1, 2, 3, 4],
      },
    });

    const choice = question.choices[0];
    const answer = await prisma.attemptAnswer.create({
      data: {
        attemptQuestionId: attemptQuestion.id,
        choiceId: choice.id,
        revision: 1,
        idempotencyKey: `ZZ-m3-ans-${randomUUID()}`,
      },
    });

    const result = await prisma.attemptResult.create({
      data: {
        attemptId: attempt.id,
        score: 20,
        total: 25,
        snapshot: {},
      },
    });

    const uploadAttempt = await prisma.uploadAttempt.create({
      data: {
        idempotencyKey: `ZZ-m3-ua-${randomUUID()}`,
        requestHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        subjectId: subject.id,
        documentId: document.id,
        objectKey: `ZZ-m3/ua-${randomUUID()}`,
        filename: 'test.pdf',
        fileSize: 1,
        fileSha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
        pageCount: 1,
        status: 'UPLOADED',
      },
    });

    const deletedKeys: string[] = [];
    const service = new SubjectsService(prisma as any, createStorageMock(deletedKeys));

    const res = await service.delete(subject.id);
    expect(res).toEqual({ subjectId: subject.id, deleted: true });

    expect(await prisma.subject.findUnique({ where: { id: subject.id } })).toBeNull();
    expect(await prisma.document.count({ where: { subjectId: subject.id } })).toBe(0);
    expect(await prisma.chunk.findUnique({ where: { id: chunk.id } })).toBeNull();
    expect(await prisma.mockQuestion.count({ where: { subjectId: subject.id } })).toBe(0);
    expect(await prisma.mockChoice.findUnique({ where: { id: choice.id } })).toBeNull();
    expect(await prisma.questionCitation.findUnique({ where: { id: citation.id } })).toBeNull();
    expect(await prisma.mockAttempt.count({ where: { subjectId: subject.id } })).toBe(0);
    expect(await prisma.attemptQuestion.findUnique({ where: { id: attemptQuestion.id } })).toBeNull();
    expect(await prisma.attemptAnswer.findUnique({ where: { id: answer.id } })).toBeNull();
    expect(await prisma.attemptResult.findUnique({ where: { id: result.id } })).toBeNull();
    expect(await prisma.generationJob.count({ where: { subjectId: subject.id } })).toBe(0);
    expect(await prisma.uploadAttempt.findUnique({ where: { id: uploadAttempt.id } })).toBeNull();
  });

  it('b. Resume: subject already status DELETING with its rows', async () => {
    const subject = await createSubject();
    await prisma.subject.update({
      where: { id: subject.id },
      data: { status: 'DELETING', deletedAt: new Date() },
    });
    const document = await createDocument(subject.id);

    const service = new SubjectsService(prisma as any, createStorageMock());
    const res = await service.delete(subject.id);

    expect(res).toEqual({ subjectId: subject.id, deleted: true });
    expect(await prisma.subject.findUnique({ where: { id: subject.id } })).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: document.id } })).toBeNull();
  });

  it('c. Missing R2 object (NoSuchKey) counts as success', async () => {
    const subject = await createSubject();
    await createDocument(subject.id);

    const storageMock = {
      deleteObject: vi.fn().mockRejectedValue({ name: 'NoSuchKey', message: 'Key not found' }),
    } as unknown as StorageService;

    const service = new SubjectsService(prisma as any, storageMock);
    const res = await service.delete(subject.id);

    expect(res).toEqual({ subjectId: subject.id, deleted: true });
    expect(await prisma.subject.findUnique({ where: { id: subject.id } })).toBeNull();
  });

  it('d. Other R2 error returns 503 STORAGE_ERROR and subject stays DELETING', async () => {
    const subject = await createSubject();
    await createDocument(subject.id);

    const storageMock = {
      deleteObject: vi.fn().mockRejectedValue(new Error('R2 connectivity failure')),
    } as unknown as StorageService;

    const service = new SubjectsService(prisma as any, storageMock);

    let thrownErr: any;
    try {
      await service.delete(subject.id);
    } catch (err) {
      thrownErr = err;
    }

    expect(thrownErr).toBeInstanceOf(HttpException);
    expect(thrownErr.getStatus()).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    expect(thrownErr.getResponse()).toEqual({
      code: 'STORAGE_ERROR',
      message: 'Storage error.',
    });

    const subjectAfter = await prisma.subject.findUnique({ where: { id: subject.id } });
    expect(subjectAfter).not.toBeNull();
    expect(subjectAfter?.status).toBe('DELETING');
  });

  it('e. Shared key: two subjects, Document in subject B with the same fileUrl. Delete subject A. Assert key NOT deleted and subject B intact', async () => {
    const subjectA = await createSubject();
    const subjectB = await createSubject();

    const sharedKey = `ZZ-m3/shared-${randomUUID()}`;
    const pdfObj = await createPdfObject();
    createdPdfObjectIds.push(pdfObj.id);

    const docA = await prisma.document.create({
      data: {
        subjectId: subjectA.id,
        pdfObjectId: pdfObj.id,
        title: 'Doc A',
        fileUrl: sharedKey,
        fileSize: 10,
      },
    });

    const docB = await prisma.document.create({
      data: {
        subjectId: subjectB.id,
        pdfObjectId: pdfObj.id,
        title: 'Doc B',
        fileUrl: sharedKey,
        fileSize: 10,
      },
    });

    const deletedKeys: string[] = [];
    const storageMock = createStorageMock(deletedKeys);

    const service = new SubjectsService(prisma as any, storageMock);
    const res = await service.delete(subjectA.id);

    expect(res).toEqual({ subjectId: subjectA.id, deleted: true });
    expect(deletedKeys).not.toContain(sharedKey);
    expect(await prisma.subject.findUnique({ where: { id: subjectA.id } })).toBeNull();
    expect(await prisma.document.findUnique({ where: { id: docA.id } })).toBeNull();

    const subjectBAfter = await prisma.subject.findUnique({ where: { id: subjectB.id } });
    expect(subjectBAfter).not.toBeNull();
    const docBAfter = await prisma.document.findUnique({ where: { id: docB.id } });
    expect(docBAfter).not.toBeNull();
  });

  it('f. Nonexistent id returns 404 SUBJECT_NOT_FOUND', async () => {
    const nonExistentId = randomUUID();
    const service = new SubjectsService(prisma as any, createStorageMock());

    let thrownErr: any;
    try {
      await service.delete(nonExistentId);
    } catch (err) {
      thrownErr = err;
    }

    expect(thrownErr).toBeInstanceOf(HttpException);
    expect(thrownErr.getStatus()).toBe(HttpStatus.NOT_FOUND);
    expect(thrownErr.getResponse()).toEqual({
      code: 'SUBJECT_NOT_FOUND',
      message: 'Subject not found.',
    });
  });
});

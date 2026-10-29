import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChatGuard } from '../chat/chat.guard.js';
import { DocumentProcessingService } from '../document-processing/document-processing.service.js';
import { ProcessingJobRepository } from '../document-processing/processing-job.repository.js';
import { RetryDocumentNotFoundError, RetryNotAllowedError } from '../document-processing/processing-job.types.js';
import { SubjectsController } from '../subjects/subjects.controller.js';
import { SubjectsService } from '../subjects/subjects.service.js';
import { DocumentStatusController } from './document-status.controller.js';

const subjectId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const date = new Date('2026-10-24T00:00:00Z');
const subject = { id: subjectId, name: 'Example', status: 'ACTIVE', createdAt: date, updatedAt: date,
  instructions: 'private', _count: { documents: 1 } };
const document = { id: documentId, subjectId, title: 'example.pdf', status: 'PROCESSING',
  createdAt: date, updatedAt: date, pageCount: 10, processedPages: 2, embeddedChunks: 1,
  ocrPages: 1, fileUrl: 'private/key.pdf', errorMessage: 'secret upstream details' };

const failureMessages = {
  PROCESSING_FAILED: 'Document processing failed. Retry the document.',
  OCR_PAGE_LIMIT_EXCEEDED: 'Document exceeds the configured OCR page limit. Raise the OCR page limit, then retry.',
  DB_TRANSIENT: 'The database was temporarily unavailable. Retry the document.',
};

describe('Read-only Subject and processing-status HTTP contracts', () => {
  let app: INestApplication;
  let db: ReturnType<typeof database>;
  let jobs: { getLatestJob: ReturnType<typeof vi.fn> };
  let processing: { retry: ReturnType<typeof vi.fn> };
  function database() {
    return {
      subject: { findMany: vi.fn().mockResolvedValue([subject]), findUnique: vi.fn().mockResolvedValue(subject) },
      document: { findMany: vi.fn().mockImplementation(async ({ where }: { where: { subjectId: string } }) =>
        [document, { ...document, id: otherId, subjectId: otherId }].filter(d => d.subjectId === where.subjectId)),
      findUnique: vi.fn().mockResolvedValue(document) },
    };
  }
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CORS_ORIGINS', 'http://localhost:3001');
    db = database();
    jobs = { getLatestJob: vi.fn().mockResolvedValue(null) };
    processing = { retry: vi.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({
      controllers: [SubjectsController, DocumentStatusController],
      providers: [
        SubjectsService,
        ChatGuard,
        { provide: PrismaService, useValue: db },
        { provide: ProcessingJobRepository, useValue: jobs },
        { provide: DocumentProcessingService, useValue: processing },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });
  const get = (path: string) => request(app.getHttpServer()).get(path).set('Host', 'localhost:3000');
  const post = (path: string) => request(app.getHttpServer()).post(path).set('Host', 'localhost:3000');

  it('lists safe Subject metadata with deterministic ordering', async () => {
    const { body } = await get('/subjects').expect(200);
    expect(body).toEqual([{ id: subjectId, name: 'Example', createdAt: date.toISOString(), updatedAt: date.toISOString(), documentCount: 1 }]);
    expect(db.subject.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
  });
  it('returns an empty Subject list', async () => {
    db.subject.findMany.mockResolvedValue([]);
    expect((await get('/subjects').expect(200)).body).toEqual([]);
  });
  it('returns the selected Subject', async () => {
    expect((await get(`/subjects/${subjectId}`).expect(200)).body.id).toBe(subjectId);
    expect(db.subject.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: subjectId } }));
  });
  it.each([`/subjects/${subjectId}`, `/subjects/${subjectId}/documents`])('404 for unknown Subject: %s', async path => {
    db.subject.findUnique.mockResolvedValue(null);
    await get(path).expect(404);
    expect(db.document.findMany).not.toHaveBeenCalled();
  });
  it('scopes documents and excludes internal metadata', async () => {
    const { body } = await get(`/subjects/${subjectId}/documents`).expect(200);
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ documentId, subjectId, filename: 'example.pdf' });
    expect(JSON.stringify(body)).not.toMatch(/private|secret|fileUrl|errorMessage/);
    expect(db.document.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { subjectId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }));
  });
  it('returns no documents for an existing empty Subject', async () => {
    db.document.findMany.mockResolvedValue([]);
    expect((await get(`/subjects/${subjectId}/documents`).expect(200)).body).toEqual([]);
  });
  it.each(['QUEUED', 'PROCESSING', 'READY', 'FAILED'])('reports persisted %s without mutating records', async status => {
    const row = { ...document, status };
    db.document.findUnique.mockResolvedValue(row);
    const snapshot = structuredClone(row);
    const { body } = await get(`/documents/${documentId}/status`).expect(200);
    const failed = status === 'FAILED';
    expect(body).toMatchObject({ documentId, subjectId, status, readyForRetrieval: status === 'READY',
      retryAllowed: failed, retryUnavailableReason: failed ? null : 'NOT_FAILED' });
    expect(body.failure).toEqual(failed
      ? { code: 'PROCESSING_FAILED', message: failureMessages.PROCESSING_FAILED, retryAllowed: true }
      : null);
    expect(body).not.toHaveProperty('processing');
    expect(JSON.stringify(body)).not.toMatch(/secret|private|fileUrl|errorMessage/);
    expect(row).toEqual(snapshot);
    // DB double deliberately exposes only read methods; any mutation would fail.
    expect(db.document.findUnique).toHaveBeenCalledTimes(1);
    expect(jobs.getLatestJob).toHaveBeenCalledWith(documentId);
  });
  it('allows retry with the whitelisted code and a fixed message', async () => {
    db.document.findUnique.mockResolvedValue({ ...document, status: 'FAILED' });
    jobs.getLatestJob.mockResolvedValue({ status: 'FAILED', attempt: 4, maxAttempts: 4, nextRunAt: date,
      errorCode: 'OCR_PAGE_LIMIT_EXCEEDED', errorMessage: 'provider secret details' });
    const { body } = await get(`/documents/${documentId}/status`).expect(200);
    expect(body).toMatchObject({
      retryAllowed: true,
      retryUnavailableReason: null,
      failure: { code: 'OCR_PAGE_LIMIT_EXCEEDED', message: failureMessages.OCR_PAGE_LIMIT_EXCEEDED, retryAllowed: true },
    });
    expect(JSON.stringify(body)).not.toMatch(/provider secret details|secret upstream details/);
  });
  it('falls back to PROCESSING_FAILED for an unknown job error code', async () => {
    db.document.findUnique.mockResolvedValue({ ...document, status: 'FAILED' });
    jobs.getLatestJob.mockResolvedValue({ status: 'FAILED', attempt: 1, maxAttempts: 4, nextRunAt: date,
      errorCode: 'PROVIDER_SECRET_CODE', errorMessage: 'provider secret details' });
    const { body } = await get(`/documents/${documentId}/status`).expect(200);
    expect(body.failure).toEqual({
      code: 'PROCESSING_FAILED',
      message: failureMessages.PROCESSING_FAILED,
      retryAllowed: true,
    });
    expect(JSON.stringify(body)).not.toMatch(/provider secret details|PROVIDER_SECRET_CODE|secret upstream details/);
  });
  it('disallows retry while RETRY_WAIT is active and reports progress', async () => {
    const nextRunAt = new Date('2026-10-24T00:05:00Z');
    db.document.findUnique.mockResolvedValue({ ...document, status: 'FAILED' });
    jobs.getLatestJob.mockResolvedValue({ status: 'RETRY_WAIT', attempt: 2, maxAttempts: 4, nextRunAt,
      errorCode: 'DB_TRANSIENT' });
    const { body } = await get(`/documents/${documentId}/status`).expect(200);
    expect(body).toMatchObject({
      retryAllowed: false,
      retryUnavailableReason: 'RETRY_IN_PROGRESS',
      processing: { attempt: 2, maxAttempts: 4, nextRunAt: nextRunAt.toISOString() },
      failure: { code: 'DB_TRANSIENT', message: failureMessages.DB_TRANSIENT, retryAllowed: false },
    });
  });
  it.each(['QUEUED', 'RUNNING'])('disallows retry while a %s job is active', async status => {
    db.document.findUnique.mockResolvedValue({ ...document, status: 'FAILED' });
    jobs.getLatestJob.mockResolvedValue({ status, attempt: 1, maxAttempts: 4, nextRunAt: date, errorCode: null });
    const { body } = await get(`/documents/${documentId}/status`).expect(200);
    expect(body).toMatchObject({ retryAllowed: false, retryUnavailableReason: 'RETRY_IN_PROGRESS' });
    expect(body).not.toHaveProperty('processing');
  });
  it('returns 404 for an unknown document', async () => {
    db.document.findUnique.mockResolvedValue(null);
    await get(`/documents/${documentId}/status`).expect(404);
  });
  it.each(['/subjects/not-a-uuid', '/subjects/not-a-uuid/documents', '/documents/not-a-uuid/status'])('validates UUID path: %s', async path => {
    await get(path).expect(400);
    expect(db.subject.findUnique).not.toHaveBeenCalled();
    expect(db.document.findUnique).not.toHaveBeenCalled();
  });
  it.each(['/subjects', `/subjects/${subjectId}`, `/subjects/${subjectId}/documents`, `/documents/${documentId}/status`])('sanitizes database errors: %s', async path => {
    db.subject.findMany.mockRejectedValue(new Error('credential-bearing error'));
    db.subject.findUnique.mockRejectedValue(new Error('credential-bearing error'));
    db.document.findUnique.mockRejectedValue(new Error('credential-bearing error'));
    const { body } = await get(path).expect(503);
    expect(JSON.stringify(body)).not.toContain('credential-bearing');
  });
  it('sanitizes document-list failures after Subject lookup', async () => {
    db.document.findMany.mockRejectedValue(new Error('private query'));
    const { body } = await get(`/subjects/${subjectId}/documents`).expect(503);
    expect(JSON.stringify(body)).not.toContain('private query');
  });
  it('sanitizes latest-job lookup failures', async () => {
    jobs.getLatestJob.mockRejectedValue(new Error('private query'));
    const { body } = await get(`/documents/${documentId}/status`).expect(503);
    expect(JSON.stringify(body)).not.toContain('private query');
  });
  it('retries a failed document and returns 202', async () => {
    const { body } = await post(`/documents/${documentId}/retry`).expect(202);
    expect(body).toEqual({ documentId, status: 'QUEUED' });
    expect(processing.retry).toHaveBeenCalledWith(documentId);
  });
  it('returns 404 when retry reports an unknown document', async () => {
    processing.retry.mockRejectedValue(new RetryDocumentNotFoundError());
    await post(`/documents/${documentId}/retry`).expect(404);
  });
  it.each(['NOT_FAILED', 'RETRY_IN_PROGRESS'] as const)('returns 409 RETRY_NOT_ALLOWED with reason %s', async reason => {
    processing.retry.mockRejectedValue(new RetryNotAllowedError(reason));
    const { body } = await post(`/documents/${documentId}/retry`).expect(409);
    expect(body).toMatchObject({ code: 'RETRY_NOT_ALLOWED', reason });
  });
  it('sanitizes retry database errors', async () => {
    processing.retry.mockRejectedValue(new Error('credential-bearing error'));
    const { body } = await post(`/documents/${documentId}/retry`).expect(503);
    expect(JSON.stringify(body)).not.toContain('credential-bearing');
  });
  it('validates the retry document id', async () => {
    await post('/documents/not-a-uuid/retry').expect(400);
    expect(processing.retry).not.toHaveBeenCalled();
  });
  it('applies the chat guard to the retry route', async () => {
    await post(`/documents/${documentId}/retry`).set('Host', 'remote.example').expect(403);
    expect(processing.retry).not.toHaveBeenCalled();
  });
  it('does not apply the chat guard to read-only GET routes', async () => {
    const { status } = await get('/subjects');
    expect(status).toBe(200);
  });
});

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { SubjectsController } from '../subjects/subjects.controller.js';
import { SubjectsService } from '../subjects/subjects.service.js';
import { DocumentStatusController } from './document-status.controller.js';

const subjectId = '11111111-1111-4111-8111-111111111111';
const documentId = '22222222-2222-4222-8222-222222222222';
const otherId = '33333333-3333-4333-8333-333333333333';
const date = new Date('2026-10-24T00:00:00Z');
const subject = { id: subjectId, name: 'Example', createdAt: date, updatedAt: date,
  instructions: 'private', _count: { documents: 1 } };
const document = { id: documentId, subjectId, title: 'example.pdf', status: 'PROCESSING',
  createdAt: date, updatedAt: date, pageCount: 10, processedPages: 2, embeddedChunks: 1,
  ocrPages: 1, fileUrl: 'private/key.pdf', errorMessage: 'secret upstream details' };

describe('Read-only Subject and processing-status HTTP contracts', () => {
  let app: INestApplication;
  let db: ReturnType<typeof database>;
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
    const module = await Test.createTestingModule({
      controllers: [SubjectsController, DocumentStatusController],
      providers: [SubjectsService, { provide: PrismaService, useValue: db }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => { await app?.close(); vi.unstubAllEnvs(); });
  const get = (path: string) => request(app.getHttpServer()).get(path).set('Host', 'localhost:3000');

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
  it.each(['UPLOADED', 'PROCESSING', 'READY', 'FAILED'])('reports persisted %s without mutating records', async status => {
    const row = { ...document, status };
    db.document.findUnique.mockResolvedValue(row);
    const snapshot = structuredClone(row);
    const { body } = await get(`/documents/${documentId}/status`).expect(200);
    expect(body).toMatchObject({ documentId, subjectId, status, readyForRetrieval: status === 'READY', retryAllowed: false });
    expect(body.failure).toEqual(status === 'FAILED'
      ? { code: 'PROCESSING_FAILED', message: 'Document processing failed. Controlled retry is not yet available.' } : null);
    expect(JSON.stringify(body)).not.toMatch(/secret|private|fileUrl|errorMessage/);
    expect(row).toEqual(snapshot);
    // DB double deliberately exposes only read methods; any mutation would fail.
    expect(db.document.findUnique).toHaveBeenCalledTimes(1);
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
  it('does not expose a retry route', async () => {
    await request(app.getHttpServer()).post(`/documents/${documentId}/retry`).set('Host', 'localhost:3000').expect(404);
  });
  it.each(['/subjects', `/subjects/${subjectId}`, `/subjects/${subjectId}/documents`, `/documents/${documentId}/status`])('preserves production/local boundaries: %s', async path => {
    await get(path).set('Origin', 'https://untrusted.invalid').expect(403);
    await get(path).set('X-Forwarded-For', '127.0.0.1').expect(403);
    vi.stubEnv('NODE_ENV', 'production');
    await get(path).expect(404);
    expect(db.subject.findUnique).not.toHaveBeenCalled();
    expect(db.document.findUnique).not.toHaveBeenCalled();
  });
});

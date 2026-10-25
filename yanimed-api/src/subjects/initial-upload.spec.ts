import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PDFDocument } from 'pdf-lib';
import { Prisma, type UploadAttempt } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { InitialUploadService } from './initial-upload.service.js';
import { InitialUploadController } from './initial-upload.controller.js';
import { UploadReconciler } from './upload-reconciler.service.js';
import { validateInitialPdf } from '../storage/pdf-validation.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { StorageService, StoredPdf } from '../storage/storage.service.js';

const uniqueError = () => new Prisma.PrismaClientKnownRequestError('private details', {
  code: 'P2002', clientVersion: Prisma.prismaVersion.client,
});

// Stateful transactional DB + object-store doubles: no live Supabase or R2 access.
function harness() {
  let rows: UploadAttempt[] = [];
  let subjects: { id: string; name: string }[] = [];
  let documents: { id: string; subjectId: string; fileUrl: string; status: string }[] = [];
  let inTransaction = false;
  let writes: Promise<unknown> = Promise.resolve();
  const objects = new Map<string, StoredPdf>();
  const db = {
    subject: { create: vi.fn(async ({ data }: { data: { name: string } }) => {
      if (subjects.some(s => s.name.toLowerCase() === data.name.toLowerCase())) throw uniqueError();
      const row = { id: randomUUID(), ...data }; subjects.push(row); return row;
    }) },
    document: { create: vi.fn(async ({ data }: { data: typeof documents[number] }) => {
      if (documents.some(d => d.id === data.id)) throw uniqueError();
      documents.push(data); return data;
    }) },
    uploadAttempt: {
      create: vi.fn(async ({ data }: { data: Partial<UploadAttempt> }) => {
        if (rows.some(r => r.idempotencyKey === data.idempotencyKey)) throw uniqueError();
        const row = { documentId: null, status: 'PENDING', etag: null, lastError: null,
          leaseOwner: null, leaseUntil: null, attempts: 0, nextAttemptAt: new Date(),
          createdAt: new Date(), updatedAt: new Date(), ...data } as UploadAttempt;
        rows.push(row); return structuredClone(row);
      }),
      findUnique: vi.fn(async ({ where }: { where: { id?: string; idempotencyKey?: string } }) => {
        const row = rows.find(r => where.id ? r.id === where.id : r.idempotencyKey === where.idempotencyKey);
        return row ? structuredClone(row) : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => {
        const row = rows.find(r => r.id === where.id); if (!row) throw new Error('missing');
        return structuredClone(row);
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
        const row = rows.find(r => r.id === where.id);
        if (!row || (where.leaseOwner && row.leaseOwner !== where.leaseOwner) ||
          (where.status?.not && row.status === where.status.not) ||
          (where.OR && row.leaseUntil && row.leaseUntil >= new Date()) ||
          (where.leaseUntil?.gt && (!row.leaseUntil || row.leaseUntil <= where.leaseUntil.gt))) return { count: 0 };
        const patch = { ...data };
        if (patch.attempts) patch.attempts = row.attempts + patch.attempts.increment;
        Object.assign(row, patch); return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<UploadAttempt> }) => {
        const row = rows.find(r => r.id === where.id)!; Object.assign(row, data); return structuredClone(row);
      }),
      findMany: vi.fn(async () => rows.filter(r => r.status !== 'UPLOADED' &&
        (!r.leaseUntil || r.leaseUntil < new Date())).map(r => structuredClone(r))),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const next = writes.then(async () => {
        const snapshot = structuredClone({ rows, subjects, documents });
        inTransaction = true;
        try { return await work(db); }
        catch (error) { ({ rows, subjects, documents } = snapshot); throw error; }
        finally { inTransaction = false; }
      });
      writes = next.catch(() => undefined); return next;
    }),
  };
  const storage = {
    putReservedPdf: vi.fn(async (attempt: UploadAttempt) => {
      expect(inTransaction).toBe(false);
      if (!objects.has(attempt.objectKey)) objects.set(attempt.objectKey, {
        bytes: attempt.fileSize, sha256: attempt.fileSha256, attemptId: attempt.id, etag: 'etag',
      });
    }),
    inspectReservedPdf: vi.fn(async (key: string) => {
      expect(inTransaction).toBe(false); return objects.get(key) ?? null;
    }),
    deleteReservedPdf: vi.fn(async (key: string) => { expect(inTransaction).toBe(false); objects.delete(key); }),
  };
  const service = new InitialUploadService(db as unknown as PrismaService, storage as unknown as StorageService);
  return { db, storage, service, objects, rows: () => rows, subjects: () => subjects, documents: () => documents };
}

describe('Initial Subject/PDF workflow', () => {
  let h: ReturnType<typeof harness>;
  let file: { buffer: Buffer; size: number; mimetype: string; originalname: string };
  const dto = { name: 'Pediatrics', idempotencyKey: 'test-initial-0001' };
  beforeEach(async () => {
    const pdf = await PDFDocument.create(); pdf.addPage();
    const buffer = Buffer.from(await pdf.save());
    file = { buffer, size: buffer.length, mimetype: 'application/pdf', originalname: 'test.pdf' };
    h = harness();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('reserves first, uploads outside transactions, creates an UPLOADED receipt and replays a lost response', async () => {
    const first = await h.service.create(dto, file);
    expect(first).toMatchObject({ uploadStatus: 'UPLOADED', chatAvailable: false, subjectStatus: 'INCOMPLETE' });
    expect(first.documentId).toBeTruthy();
    expect(await h.service.create(dto, file)).toEqual(first);
    expect(h.subjects()).toHaveLength(1); expect(h.documents()).toHaveLength(1);
    expect(h.storage.putReservedPdf).toHaveBeenCalledTimes(1);
    expect(h.documents()[0].fileUrl).toBe(h.rows()[0].objectKey);
    expect(await h.service.status(dto.idempotencyKey)).toEqual(first);
  });
  it('detects conflicting key reuse with a different name or PDF bytes', async () => {
    await h.service.create(dto, file);
    await expect(h.service.create({ ...dto, name: 'Anatomy' }, file)).rejects.toMatchObject({ status: 409 });
    const different = await PDFDocument.create(); different.addPage([100, 200]);
    const buffer = Buffer.from(await different.save());
    await expect(h.service.create(dto, { ...file, buffer, size: buffer.length })).rejects.toMatchObject({ status: 409 });
    expect(h.objects.size).toBe(1);
  });
  it('coalesces concurrent identical submissions and rejects concurrent duplicate names under different keys', async () => {
    await Promise.all([h.service.create(dto, file), h.service.create(dto, file)]);
    expect(h.subjects()).toHaveLength(1); expect(h.documents()).toHaveLength(1); expect(h.objects.size).toBe(1);
    await expect(h.service.create({ name: 'pediatrics', idempotencyKey: 'different-key' }, file)).rejects.toMatchObject({ status: 409 });
    expect(h.subjects()).toHaveLength(1);
  });
  it('retains a retryable attempt after R2 failure and reuses the reserved key', async () => {
    h.storage.putReservedPdf.mockRejectedValueOnce(new Error('private R2 details'));
    const result = await h.service.create(dto, file);
    expect(result).toMatchObject({ uploadStatus: 'AWAITING_RETRY', documentId: null, chatAvailable: false });
    expect(h.documents()).toHaveLength(0);
    const key = h.rows()[0].objectKey;
    await h.service.create(dto, file);
    expect(h.rows()[0].objectKey).toBe(key); expect(h.documents()).toHaveLength(1);
  });
  it('recovers a successful R2 write followed by a database failure without deleting or uploading again', async () => {
    h.db.document.create.mockRejectedValueOnce(new Error('private DB details'));
    const result = await h.service.create(dto, file);
    expect(result.uploadStatus).toBe('AWAITING_RETRY'); expect(h.objects.size).toBe(1);
    expect(h.documents()).toHaveLength(0);
    await h.service.reconcileBatch();
    expect(h.rows()[0].status).toBe('UPLOADED'); expect(h.documents()).toHaveLength(1);
    expect(h.storage.putReservedPdf).toHaveBeenCalledTimes(1);
    expect(h.storage.deleteReservedPdf).not.toHaveBeenCalled();
  });
  it('adopts a stored object after an interrupted response', async () => {
    const original = h.storage.putReservedPdf.getMockImplementation()!;
    h.storage.putReservedPdf.mockImplementationOnce(async attempt => { await original(attempt); throw new Error('timeout after write'); });
    await h.service.create(dto, file);
    await h.service.reconcileBatch();
    expect(h.rows()[0].status).toBe('UPLOADED'); expect(h.documents()).toHaveLength(1);
    expect(h.storage.putReservedPdf).toHaveBeenCalledTimes(1);
  });
  it('does not steal an active lease, and recovers an expired one without inventing a successful upload', async () => {
    h.storage.putReservedPdf.mockRejectedValueOnce(new Error('not stored'));
    await h.service.create(dto, file);
    Object.assign(h.rows()[0], { status: 'UPLOADING', leaseOwner: 'old-worker', leaseUntil: new Date(Date.now() + 300000) });
    await h.service.create(dto, file);
    expect(h.storage.putReservedPdf).toHaveBeenCalledTimes(1);
    h.rows()[0].leaseUntil = new Date(0);
    await h.service.reconcileBatch();
    expect(h.rows()[0]).toMatchObject({ status: 'AWAITING_RETRY', lastError: 'FILE_REQUIRED' });
    expect(h.documents()).toHaveLength(0);
    await h.service.create(dto, file); expect(h.documents()).toHaveLength(1);
  });
  it('records cleanup intent, retains it on cleanup failure, and only deletes the owned mismatched object', async () => {
    h.storage.putReservedPdf.mockRejectedValueOnce(new Error('failed'));
    await h.service.create(dto, file);
    const row = h.rows()[0];
    h.objects.set(row.objectKey, { bytes: 1, sha256: 'wrong', attemptId: row.id, etag: 'version' });
    await h.service.reconcileBatch(); expect(h.rows()[0].status).toBe('CLEANUP_PENDING');
    expect(h.storage.deleteReservedPdf).not.toHaveBeenCalled();
    h.storage.deleteReservedPdf.mockRejectedValueOnce(new Error('cleanup offline'));
    await h.service.reconcileBatch();
    expect(h.rows()[0]).toMatchObject({ status: 'CLEANUP_PENDING', lastError: 'CLEANUP_FAILED' });
    await h.service.reconcileBatch();
    expect(h.rows()[0].status).toBe('AWAITING_RETRY'); expect(h.objects.size).toBe(0);
    expect(h.storage.deleteReservedPdf).toHaveBeenLastCalledWith(row.objectKey, 'version');
  });
  it('never deletes an unowned object', async () => {
    h.storage.putReservedPdf.mockRejectedValueOnce(new Error('failed'));
    await h.service.create(dto, file);
    const row = h.rows()[0];
    h.objects.set(row.objectKey, { bytes: 1, sha256: 'wrong', attemptId: 'somebody-else', etag: 'version' });
    await h.service.reconcileBatch(); await h.service.reconcileBatch();
    expect(h.rows()[0].status).toBe('CLEANUP_PENDING');
    expect(h.storage.deleteReservedPdf).not.toHaveBeenCalled();
  });
  it('fences a stale worker before document creation', async () => {
    const original = h.storage.putReservedPdf.getMockImplementation()!;
    h.storage.putReservedPdf.mockImplementationOnce(async attempt => {
      await original(attempt); h.rows()[0].leaseOwner = 'new-worker';
    });
    await h.service.create(dto, file); expect(h.documents()).toHaveLength(0);
    h.rows()[0].leaseUntil = new Date(0);
    await h.service.reconcileBatch(); expect(h.documents()).toHaveLength(1);
  });
  it('rolls back the Subject if upload-intent creation fails', async () => {
    h.db.uploadAttempt.create.mockRejectedValueOnce(new Error('DB down'));
    await expect(h.service.create(dto, file)).rejects.toMatchObject({ status: 503 });
    expect(h.subjects()).toHaveLength(0); expect(h.storage.putReservedPdf).not.toHaveBeenCalled();
  });
  it.each(['extension', 'mime', 'empty', 'signature', 'parseability', 'pages', 'encrypted'])('rejects invalid PDF %s before reservation', async kind => {
    if (kind === 'extension') file.originalname = 'test.txt';
    if (kind === 'mime') file.mimetype = 'text/plain';
    if (kind === 'empty') file.buffer = Buffer.alloc(0);
    if (kind === 'signature') file.buffer = Buffer.from('not a PDF');
    if (kind === 'parseability') file.buffer = Buffer.from('%PDF-1.7\n%%EOF');
    if (kind === 'pages') file.buffer = Buffer.from(await (await PDFDocument.create()).save({ addDefaultPage: false }));
    if (kind === 'encrypted') {
      const pdf = await PDFDocument.create(); pdf.addPage();
      pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: 'Standard' }));
      file.buffer = Buffer.from(await pdf.save());
    }
    file.size = file.buffer.length;
    await expect(h.service.create(dto, file)).rejects.toMatchObject({ status: 400 });
    expect(h.db.$transaction).not.toHaveBeenCalled();
  });
  it('rejects inconsistent/oversized sizes and a missing PDF', async () => {
    await expect(validateInitialPdf({ ...file, size: 256 * 1024 * 1024 + 1 })).rejects.toMatchObject({ status: 400 });
    await expect(validateInitialPdf(undefined)).rejects.toMatchObject({ status: 400 });
  });
  it('serves multipart creation and status, validates input, and returns incomplete readiness', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const module = await Test.createTestingModule({ controllers: [InitialUploadController],
      providers: [{ provide: InitialUploadService, useValue: h.service }] }).compile();
    const app = module.createNestApplication(); await app.init();
    try {
      const post = () => request(app.getHttpServer()).post('/subjects/initial-upload').set('Host', 'localhost:3000');
      const created = await post().field('name', ' Pediatrics ').field('idempotencyKey', dto.idempotencyKey)
        .attach('file', file.buffer, { filename: 'test.pdf', contentType: 'application/pdf' }).expect(202);
      expect(created.body).toMatchObject({ uploadStatus: 'UPLOADED', chatAvailable: false });
      const status = await request(app.getHttpServer()).get(`/subjects/initial-upload/${dto.idempotencyKey}`)
        .set('Host', 'localhost:3000').expect(200);
      expect(status.body).toEqual(created.body);
      await post().field('name', ' ').field('idempotencyKey', 'short').attach('file', file.buffer, 'test.pdf').expect(400);
      await post().field('name', 'Other').field('idempotencyKey', 'different-key').expect(400);
      await request(app.getHttpServer()).get('/subjects/initial-upload/unknown-key').set('Host', 'localhost:3000').expect(404);
    } finally { await app.close(); }
  });
  it('returns a conflict for a case-variant duplicate upload when no action is supplied', async () => {
    const h = harness();
    const fileBuffer = file.buffer;
    const pdfObjects = { findDuplicate: vi.fn().mockResolvedValue({
      scope: 'other_subject', existingDocumentId: 'doc-existing', existingSubjectId: 'subject-existing',
      existingFilename: 'existing.pdf', pdfObject: { id: 'po-1', r2Key: 'pdfs/hash.pdf' },
    }), ensureFromStaging: vi.fn() };
    const service = new InitialUploadService(h.db as unknown as PrismaService, h.storage as unknown as StorageService, undefined, pdfObjects as never);
    await expect(service.create(dto, file)).rejects.toMatchObject({ status: 409, response: { code: 'DUPLICATE_PDF' } });
    expect(h.subjects()).toHaveLength(0);
  });

  it('does not overlap reconciliation sweeps', async () => {
    let finish!: () => void;
    const reconcileBatch = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const worker = new UploadReconciler({ reconcileBatch } as unknown as InitialUploadService);
    const one = worker.tick(); const two = worker.tick();
    expect(reconcileBatch).toHaveBeenCalledTimes(1); finish(); await Promise.all([one, two]);
    await worker.onModuleDestroy();
  });
});

/** Opt-in database integration test after deployment. R2 is an in-memory double.
 * All database fixtures are rolled back; no production objects are uploaded/deleted.
 * Run: npx tsx scripts/verify-initial-upload.ts
 */
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { PrismaClient, type UploadAttempt } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { ConflictException } from '@nestjs/common';
import { InitialUploadService } from '../src/subjects/initial-upload.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import type { StorageService, StoredPdf } from '../src/storage/storage.service.js';

function check(condition: unknown, label: string): asserts condition {
  if (!condition) throw new Error(label);
}

async function main() {
  const env = parseEnv(readFileSync('.env', 'utf8'));
  check(env.DIRECT_URL, 'Missing target');
  const url = new URL(env.DIRECT_URL);
  check(env.DATABASE_URL === env.DIRECT_URL && url.hostname === 'aws-0-ap-northeast-1.pooler.supabase.com' &&
    decodeURIComponent(url.username) === 'postgres.fzpiddbndhuiimhgcbmu' && url.port === '5432' &&
    url.pathname === '/postgres' && url.searchParams.get('sslmode') === 'require', 'Target verification failed');
  const prisma = new PrismaClient({ datasources: { db: { url: env.DIRECT_URL } } });
  const prefix = `Upload-integration-${randomUUID()}`;
  const rollback = new Error('Intentional fixture rollback');
  try {
    const history = await prisma.$queryRaw<{ checksum: string; finished_at: Date | null; rolled_back_at: Date | null }[]>`
      SELECT checksum, finished_at, rolled_back_at FROM public._prisma_migrations
      WHERE migration_name = '20261023170000_initial_upload_attempts'
    `;
    const checksum = createHash('sha256').update(readFileSync(
      'prisma/migrations/20261023170000_initial_upload_attempts/migration.sql',
    )).digest('hex');
    check(history.length === 1 && history[0].finished_at && !history[0].rolled_back_at &&
      history[0].checksum === checksum, 'Migration history mismatch');
    try {
      await prisma.$transaction(async tx => {
        // Savepoint adapter allows production service transactions to run in this
        // outer rollback-only test transaction. All storage calls below are local mocks.
        let sequence = 0;
        const adapter = {
          subject: tx.subject, document: tx.document, uploadAttempt: tx.uploadAttempt,
          $transaction: async (work: (client: typeof tx) => Promise<unknown>) => {
            const savepoint = `fixture_${++sequence}`;
            await tx.$executeRawUnsafe(`SAVEPOINT ${savepoint}`);
            try { return await work(tx); }
            catch (error) { await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`); throw error; }
            finally { await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${savepoint}`); }
          },
        };
        const objects = new Map<string, StoredPdf>();
        let loseResponse = false;
        let putCount = 0;
        const puts = () => putCount;
        const storage = {
          inspectReservedPdf: async (key: string) => objects.get(key) ?? null,
          putReservedPdf: async (attempt: UploadAttempt) => {
            ++putCount;
            objects.set(attempt.objectKey, { bytes: attempt.fileSize, sha256: attempt.fileSha256,
              attemptId: attempt.id, etag: 'fixture-etag' });
            if (loseResponse) { loseResponse = false; throw new Error('Simulated lost storage response'); }
          },
          deleteReservedPdf: async () => { throw new Error('Cleanup should not delete a valid receipt'); },
        };
        const service = new InitialUploadService(adapter as unknown as PrismaService, storage as unknown as StorageService);
        const pdf = await PDFDocument.create(); pdf.addPage();
        const buffer = Buffer.from(await pdf.save());
        const file = { buffer, size: buffer.length, mimetype: 'application/pdf', originalname: 'fixture.pdf' };
        const dto = { name: prefix, idempotencyKey: `${prefix}-key` };
        const created = await service.create(dto, file);
        check(created.uploadStatus === 'UPLOADED' && created.documentId && created.chatAvailable === false,
          'Initial upload failed');
        const document = await tx.document.findUnique({ where: { id: created.documentId } });
        check(document?.status === 'QUEUED' && document.subjectId === created.subjectId, 'Receipt mismatch');
        const replay = await service.create(dto, file);
        check(replay.documentId === created.documentId && puts() === 1, 'Replay duplicated storage');
        let duplicate = false;
        try { await service.create({ ...dto, name: dto.name.toUpperCase(), idempotencyKey: `${prefix}-other` }, file); }
        catch (error) { duplicate = error instanceof ConflictException; }
        check(duplicate, 'Database duplicate was not handled');
        loseResponse = true;
        const interrupted = await service.create({ name: `${prefix}-recover`, idempotencyKey: `${prefix}-recover` }, file);
        check(interrupted.uploadStatus === 'AWAITING_RETRY' && !interrupted.documentId, 'Lost response state mismatch');
        const attempt = await tx.uploadAttempt.findUniqueOrThrow({ where: { subjectId: interrupted.subjectId } });
        const recovered = await service.process(attempt.id);
        check(recovered.uploadStatus === 'UPLOADED' && puts() === 2, 'Reconciliation failed or reuploaded');
        check(await tx.uploadAttempt.count({ where: { idempotencyKey: { startsWith: prefix } } }) === 2, 'Attempt duplication');
        console.log('Database workflow: PASS; idempotent replay: PASS; uniqueness: PASS; interrupted-upload reconciliation: PASS');
        throw rollback;
      }, { timeout: 60000 });
    } catch (error) { if (error !== rollback) throw error; }
    check(await prisma.subject.count({ where: { name: { startsWith: prefix } } }) === 0, 'Fixture rollback failed');
    check(await prisma.uploadAttempt.count({ where: { idempotencyKey: { startsWith: prefix } } }) === 0, 'Attempt rollback failed');
    console.log('Migration history: PASS; test fixture rollback: PASS; real R2 operations: NONE');
  } finally { await prisma.$disconnect(); }
}

main().catch(() => {
  // Never print Prisma errors or fixture data: keep connection details private.
  console.error('Initial upload integration: FAIL (verification/database error)');
  process.exitCode = 1;
});

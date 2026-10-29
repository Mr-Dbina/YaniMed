import '../src/config/load-local-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import type { DocumentStatus, ProcessingJobStatus } from '@prisma/client';
import { ProcessingJobRepository } from '../src/document-processing/processing-job.repository.js';
import { RetryNotAllowedError } from '../src/document-processing/processing-job.types.js';

const PREFIX = 'ZZ-2c3-';
const ACTIVE_JOB_STATUSES: ProcessingJobStatus[] = ['QUEUED', 'RUNNING', 'RETRY_WAIT'];
const prisma = new PrismaClient();
const repo = new ProcessingJobRepository(prisma as never);

let checks = 0;
let failures = 0;
let subjectId = '';
let seq = 0;
const runStamp = Date.now();

function check(name: string, ok: boolean, detail = '') {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function capture(
  fn: () => Promise<unknown>,
): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

async function newDoc(
  label: string,
  status: DocumentStatus,
  errorMessage: string | null = null,
): Promise<string> {
  seq += 1;
  const tag = `${label}-${runStamp}-${seq}`;
  const doc = await prisma.$transaction(async (tx) => {
    const pdfObject = await tx.pdfObject.create({
      data: {
        sha256: createHash('sha256').update(`${PREFIX}${tag}`).digest('hex'),
        r2Key: `${PREFIX}pdf/${tag}.pdf`,
        sizeBytes: 1,
      },
    });
    return tx.document.create({
      data: {
        subjectId,
        pdfObjectId: pdfObject.id,
        title: `${PREFIX}${tag}.pdf`,
        fileUrl: `${PREFIX}${tag}`,
        fileSize: 1,
        status,
        errorMessage,
      },
    });
  });
  return doc.id;
}

interface JobSeed {
  attempt?: number;
  maxAttempts?: number;
  nextRunAt?: Date;
  leaseOwner?: string | null;
  leaseUntil?: Date | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  createdAt?: Date;
}

async function newJob(
  documentId: string,
  status: ProcessingJobStatus,
  data: JobSeed = {},
) {
  return prisma.processingJob.create({
    data: {
      documentId,
      status,
      attempt: data.attempt ?? 0,
      maxAttempts: data.maxAttempts ?? 4,
      nextRunAt: data.nextRunAt ?? new Date(),
      leaseOwner: data.leaseOwner ?? null,
      leaseUntil: data.leaseUntil ?? null,
      errorCode: data.errorCode ?? null,
      errorMessage: data.errorMessage ?? null,
      startedAt: data.startedAt ?? null,
      finishedAt: data.finishedAt ?? null,
      createdAt: data.createdAt ?? new Date(),
    },
  });
}

const docRow = (id: string) =>
  prisma.document.findUniqueOrThrow({
    where: { id },
    select: { status: true, errorMessage: true },
  });

const jobRow = (id: string) =>
  prisma.processingJob.findUniqueOrThrow({
    where: { id },
    select: {
      id: true,
      documentId: true,
      status: true,
      attempt: true,
      maxAttempts: true,
      nextRunAt: true,
      leaseOwner: true,
      leaseUntil: true,
      fencingToken: true,
      errorCode: true,
      errorMessage: true,
      startedAt: true,
      finishedAt: true,
    },
  });

const jobCount = (documentId: string) =>
  prisma.processingJob.count({ where: { documentId } });

const activeJobCount = (documentId: string) =>
  prisma.processingJob.count({
    where: { documentId, status: { in: ACTIVE_JOB_STATUSES } },
  });

async function jobSnapshot(id: string) {
  const job = await jobRow(id);
  return {
    status: job.status,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    fencingToken: job.fencingToken,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    leaseOwner: job.leaseOwner,
    leaseUntil: iso(job.leaseUntil),
    startedAt: iso(job.startedAt),
    finishedAt: iso(job.finishedAt),
  };
}

async function scenarioA() {
  console.log('\nA. FAILED document with a terminal FAILED job -> retry succeeds');
  const docId = await newDoc('a-failed', 'FAILED', 'ZZ-2c3 old failure');
  const oldJob = await newJob(docId, 'FAILED', {
    attempt: 1,
    errorCode: 'OCR_PAGE_TIMEOUT',
    errorMessage: 'ZZ-2c3 old failure',
    startedAt: new Date(Date.now() - 60_000),
    finishedAt: new Date(),
  });
  const before = await jobSnapshot(oldJob.id);
  const beforeCount = await jobCount(docId);

  let createdJobId = '';
  let thrown: unknown;
  try {
    createdJobId = await repo.retryFailed(docId, 4);
  } catch (error) {
    thrown = error;
  }

  check(
    'A1 retryFailed resolves with a new job id',
    createdJobId !== '',
    describeError(thrown),
  );
  if (createdJobId === '') return;

  const created = await jobRow(createdJobId);
  check(
    'A2 new job is QUEUED, attempt 0, maxAttempts 4, no error/lease/finishedAt',
    created.status === 'QUEUED' &&
      created.attempt === 0 &&
      created.maxAttempts === 4 &&
      created.errorCode === null &&
      created.errorMessage === null &&
      created.leaseOwner === null &&
      created.leaseUntil === null &&
      created.finishedAt === null,
    json(created),
  );

  const doc = await docRow(docId);
  check(
    'A3 document is QUEUED and its errorMessage was cleared',
    doc.status === 'QUEUED' && doc.errorMessage === null,
    json(doc),
  );

  const after = await jobSnapshot(oldJob.id);
  check(
    'A4 old terminal FAILED job is untouched',
    json(after) === json(before),
    `${json(before)} -> ${json(after)}`,
  );

  const afterCount = await jobCount(docId);
  check(
    'A5 exactly one new job row was created',
    afterCount === beforeCount + 1,
    `before=${beforeCount} after=${afterCount}`,
  );
}

async function scenarioB() {
  console.log('\nB. READY / QUEUED / PROCESSING are rejected with NOT_FAILED');
  const statuses: DocumentStatus[] = ['READY', 'QUEUED', 'PROCESSING'];

  for (const [index, status] of statuses.entries()) {
    const label = status.toLowerCase();
    const errorMessage = `ZZ-2c3 preserved-${label}`;
    const docId = await newDoc(`b-${label}`, status, errorMessage);
    await newJob(docId, 'FAILED', {
      attempt: 1,
      errorCode: 'ZZ_2C3_TERMINAL',
      errorMessage: 'ZZ-2c3 terminal',
      finishedAt: new Date(),
    });
    const beforeCount = await jobCount(docId);

    const result = await capture(() => repo.retryFailed(docId, 4));
    const rejectedWith = result.ok ? null : result.error;

    check(
      `B${index + 1} ${status}: RetryNotAllowedError(NOT_FAILED)`,
      rejectedWith instanceof RetryNotAllowedError &&
        rejectedWith.reason === 'NOT_FAILED',
      result.ok ? 'resolved unexpectedly' : describeError(rejectedWith),
    );

    const afterCount = await jobCount(docId);
    check(
      `B${index + 1} ${status}: no new job row`,
      afterCount === beforeCount,
      `before=${beforeCount} after=${afterCount}`,
    );

    const doc = await docRow(docId);
    check(
      `B${index + 1} ${status}: document unchanged`,
      doc.status === status && doc.errorMessage === errorMessage,
      json(doc),
    );
  }
}

async function scenarioC() {
  console.log('\nC. FAILED document with an active job -> RETRY_IN_PROGRESS');
  const cases: Array<{ status: ProcessingJobStatus; seed: JobSeed }> = [
    { status: 'QUEUED', seed: {} },
    {
      status: 'RUNNING',
      seed: {
        attempt: 1,
        leaseOwner: 'ZZ-2c3-lease',
        leaseUntil: new Date(Date.now() + 3_600_000),
        startedAt: new Date(),
      },
    },
    {
      status: 'RETRY_WAIT',
      seed: {
        attempt: 2,
        nextRunAt: new Date(Date.now() + 60_000),
        errorCode: 'ECONNRESET',
        errorMessage: 'ZZ-2c3 waiting',
      },
    },
  ];

  for (const [index, testCase] of cases.entries()) {
    const label = testCase.status.toLowerCase();
    const docId = await newDoc(`c-${label}`, 'FAILED', 'ZZ-2c3 active preserved');
    await newJob(docId, testCase.status, testCase.seed);
    const beforeCount = await jobCount(docId);

    const result = await capture(() => repo.retryFailed(docId, 4));
    const rejectedWith = result.ok ? null : result.error;

    check(
      `C${index + 1} ${testCase.status}: RetryNotAllowedError(RETRY_IN_PROGRESS)`,
      rejectedWith instanceof RetryNotAllowedError &&
        rejectedWith.reason === 'RETRY_IN_PROGRESS',
      result.ok ? 'resolved unexpectedly' : describeError(rejectedWith),
    );

    const afterCount = await jobCount(docId);
    check(
      `C${index + 1} ${testCase.status}: no new job row`,
      afterCount === beforeCount,
      `before=${beforeCount} after=${afterCount}`,
    );

    const doc = await docRow(docId);
    check(
      `C${index + 1} ${testCase.status}: document unchanged`,
      doc.status === 'FAILED' && doc.errorMessage === 'ZZ-2c3 active preserved',
      json(doc),
    );
  }
}

async function scenarioD() {
  console.log('\nD. five concurrent retries on one FAILED document');
  const docId = await newDoc('d-race', 'FAILED', 'ZZ-2c3 race preserved');
  await newJob(docId, 'FAILED', {
    attempt: 1,
    errorCode: 'OCR_PAGE_TIMEOUT',
    errorMessage: 'ZZ-2c3 race old',
    finishedAt: new Date(),
  });
  const beforeCount = await jobCount(docId);

  const results = await Promise.allSettled(
    Array.from({ length: 5 }, () => repo.retryFailed(docId, 4)),
  );
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  const rejected = results.filter(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );

  check(
    'D1 exactly 1 of 5 concurrent calls fulfilled',
    fulfilled.length === 1,
    `fulfilled=${fulfilled.length}`,
  );
  check(
    'D2 exactly 4 of 5 concurrent calls rejected',
    rejected.length === 4,
    `rejected=${rejected.length}`,
  );

  const reasons = new Map<string, number>();
  let unexpected = '';
  for (const result of rejected) {
    const error = result.reason;
    if (
      error instanceof RetryNotAllowedError &&
      (error.reason === 'NOT_FAILED' || error.reason === 'RETRY_IN_PROGRESS')
    ) {
      reasons.set(error.reason, (reasons.get(error.reason) ?? 0) + 1);
    } else {
      unexpected += ` ${describeError(error)}`;
    }
  }
  console.log(
    `  rejection reasons: ${
      [...reasons.entries()].map(([reason, count]) => `${reason}=${count}`).join(', ') ||
      'none'
    }`,
  );
  check(
    'D3 every rejection is RetryNotAllowedError with an expected reason',
    unexpected === '' && rejected.length === 4,
    unexpected || 'ok',
  );

  const afterCount = await jobCount(docId);
  check(
    'D4 exactly one new job row was created',
    afterCount === beforeCount + 1,
    `before=${beforeCount} after=${afterCount}`,
  );

  const jobs = await prisma.processingJob.findMany({
    where: { documentId: docId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, status: true, attempt: true, errorCode: true },
  });
  const fresh = jobs.filter((job) => job.status === 'QUEUED' && job.attempt === 0);
  check(
    'D5 the new job is QUEUED with attempt 0',
    fresh.length === 1,
    json(jobs),
  );

  const doc = await docRow(docId);
  check(
    'D6 document is QUEUED and its errorMessage was cleared',
    doc.status === 'QUEUED' && doc.errorMessage === null,
    json(doc),
  );
}

function isActiveJobConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; meta?: unknown; message?: unknown };
  const meta = typeof record.meta === 'object' && record.meta !== null
    ? record.meta as { code?: unknown; message?: unknown; target?: unknown }
    : undefined;
  if (record.code === 'P2002' || record.code === '23505') return true;
  if (meta?.code === 'P2002' || meta?.code === '23505') return true;
  const text = [record.message, meta?.message, meta?.target]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return text.includes('ProcessingJob_documentId_active_key')
    || (text.includes('duplicate key value') && text.includes('ProcessingJob'));
}

async function scenarioE() {
  console.log('\nE. real Postgres 23505 shape from a raw second active-job insert');
  const docId = await newDoc('e-conflict', 'FAILED', 'ZZ-2c3 conflict');
  await newJob(docId, 'QUEUED', { nextRunAt: new Date() });
  const beforeActive = await activeJobCount(docId);

  let error: unknown;
  let insertedId: string | null = null;
  try {
    const inserted = await prisma.$transaction(async (tx) =>
      tx.$queryRaw<Array<{ id: string }>>`
        INSERT INTO "public"."ProcessingJob" (
          "id", "documentId", "status", "attempt", "maxAttempts",
          "nextRunAt", "fencingToken", "createdAt", "updatedAt"
        )
        VALUES (
          ${randomUUID()}, ${docId}, 'QUEUED', 0, ${4}::integer,
          now(), 0, now(), now()
        )
        RETURNING "id"
      `,
    { timeout: 15_000 });
    insertedId = inserted[0]?.id ?? null;
  } catch (thrown) {
    error = thrown;
  }
  if (insertedId !== null) {
    console.log(
      '  second active-job insert unexpectedly succeeded, id:',
      insertedId,
    );
  }

  const record = (
    typeof error === 'object' && error !== null ? error : {}
  ) as {
    name?: unknown;
    code?: unknown;
    meta?: unknown;
    message?: unknown;
  };
  const meta =
    typeof record.meta === 'object' && record.meta !== null
      ? (record.meta as { code?: unknown; message?: unknown; target?: unknown })
      : undefined;

  let metaJson = '<none>';
  try {
    metaJson = JSON.stringify(record.meta);
  } catch {
    metaJson = '<unserializable>';
  }

  console.log(
    '  error.constructor.name:',
    error instanceof Error ? error.constructor.name : typeof error,
  );
  console.log('  error.name:', String(record.name));
  console.log('  error.code:', String(record.code));
  console.log('  error.meta:', metaJson);
  console.log('  error.message:', String(record.message));
  console.log(
    '  instanceof Prisma.PrismaClientKnownRequestError:',
    error instanceof Prisma.PrismaClientKnownRequestError,
  );

  console.log(
    '  would the repository map this to RETRY_IN_PROGRESS:',
    isActiveJobConflict(error) ? 'YES' : 'NO',
  );

  check(
    'E1 the DB rejected the second active-job insert',
    error !== undefined,
    insertedId !== null ? `inserted id ${insertedId}` : 'no error',
  );

  const violationText = [
    record.code,
    record.message,
    meta?.code,
    meta?.message,
    meta?.target,
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  const isUniqueViolation =
    record.code === '23505' ||
    record.code === 'P2002' ||
    meta?.code === '23505' ||
    meta?.code === 'P2002' ||
    /duplicate key value|ProcessingJob_documentId_active_key|unique constraint/i.test(
      violationText,
    );
  check(
    'E2 the rejection is a uniqueness violation',
    isUniqueViolation,
    violationText,
  );

  const afterActive = await activeJobCount(docId);
  check(
    'E3 still exactly one active job for the document',
    afterActive === beforeActive,
    `before=${beforeActive} after=${afterActive}`,
  );
}

async function scenarioF() {
  console.log('\nF. getLatestJob returns the newest of three jobs');
  const docId = await newDoc('f-latest', 'READY');
  const base = Date.now();
  const oldest = await newJob(docId, 'SUCCEEDED', {
    attempt: 1,
    errorCode: 'ZZ-2c3-oldest',
    createdAt: new Date(base - 3 * 60 * 60 * 1000),
    startedAt: new Date(base - 3 * 60 * 60 * 1000),
    finishedAt: new Date(base - 3 * 60 * 60 * 1000 + 1000),
  });
  const middle = await newJob(docId, 'FAILED', {
    attempt: 2,
    errorCode: 'ZZ-2c3-middle',
    createdAt: new Date(base - 2 * 60 * 60 * 1000),
    finishedAt: new Date(base - 2 * 60 * 60 * 1000 + 1000),
  });
  const newest = await newJob(docId, 'RETRY_WAIT', {
    attempt: 3,
    errorCode: 'ZZ-2c3-newest',
    nextRunAt: new Date(base + 60_000),
    createdAt: new Date(base - 60 * 60 * 1000),
  });

  const latest = await repo.getLatestJob(docId);
  check('F1 getLatestJob returned a row', latest !== null, 'null');

  check(
    'F2 returned fields match the newest job',
    latest !== null &&
      latest.status === newest.status &&
      latest.attempt === newest.attempt &&
      latest.maxAttempts === newest.maxAttempts &&
      latest.nextRunAt.getTime() === newest.nextRunAt.getTime() &&
      latest.errorCode === newest.errorCode,
    latest === null ? 'null' : `${json(latest)} vs newest id=${newest.id}`,
  );

  const matched =
    latest === null
      ? null
      : await prisma.processingJob.findFirst({
          where: {
            documentId: docId,
            status: latest.status as ProcessingJobStatus,
            attempt: latest.attempt,
            maxAttempts: latest.maxAttempts,
            nextRunAt: latest.nextRunAt,
            errorCode: latest.errorCode,
          },
          select: { id: true },
        });
  check(
    'F3 the returned fields resolve to the newest job id',
    matched?.id === newest.id,
    latest === null ? 'null' : `matched=${matched?.id ?? 'null'} newest=${newest.id}`,
  );

  check(
    'F4 the older jobs were not selected',
    latest?.errorCode === 'ZZ-2c3-newest' &&
      latest.errorCode !== oldest.errorCode &&
      latest.errorCode !== middle.errorCode,
    latest === null ? 'null' : `errorCode=${latest.errorCode}`,
  );

  console.log(
    `  newest id=${newest.id}; getLatestJob does not select id, so F3 resolves the id from the returned fields`,
  );
}

async function main() {
  console.log(`ZZ-2c3 live verification (prefix ${PREFIX})`);

  const existing = await prisma.subject.findFirst({
    where: { name: { startsWith: PREFIX } },
    select: { name: true },
  });
  if (existing) {
    throw new Error(
      `A ${PREFIX} Subject already exists (${existing.name}). Run "npx tsx scripts/zz-cleanup-2c3.ts --apply" first.`,
    );
  }

  const subject = await prisma.subject.create({
    data: { name: `${PREFIX}live-${runStamp}` },
  });
  subjectId = subject.id;
  console.log(`ZZ subject: ${subject.name} (${subject.id})`);

  await scenarioA();
  await scenarioB();
  await scenarioC();
  await scenarioD();
  await scenarioE();
  await scenarioF();
}

main()
  .catch((error) => {
    failures++;
    console.error(
      'LIVE TEST ERROR:',
      error instanceof Error
        ? error.message.split('\n').slice(-6).join(' | ')
        : error,
    );
  })
  .finally(async () => {
    console.log(
      `\n${checks} checks, ${checks - failures} passed, ${failures} failed`,
    );
    console.log(
      failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`,
    );
    if (failures > 0) {
      console.log('Re-run cleanup: npx tsx scripts/zz-cleanup-2c3.ts --apply');
    }
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });

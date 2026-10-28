import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';
import {
  ProcessingJobRepository,
  type ClaimedJob,
} from '../src/document-processing/processing-job.repository.js';

const prisma = new PrismaClient();
const repo = new ProcessingJobRepository(prisma as never);
let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

let subjectId = '';
async function newDoc(label: string) {
  const d = await prisma.document.create({
    data: {
      subjectId,
      title: `zz-2c2-${label}.pdf`,
      fileUrl: `zz-2c2/${label}`,
      fileSize: 1,
      status: 'QUEUED',
    },
  });
  return d.id;
}
const docRow = async (id: string) =>
  prisma.document.findUniqueOrThrow({
    where: { id },
    select: { status: true, errorMessage: true },
  });
const jobRow = async (id: string) =>
  (
    await prisma.$queryRaw<
      Array<{
        status: string;
        attempt: number;
        fencingToken: number;
        errorCode: string | null;
        leaseOwner: string | null;
        finishedAt: Date | null;
        secondsUntilRun: number;
      }>
    >`
    SELECT "status"::text AS status, "attempt", "fencingToken", "errorCode", "leaseOwner", "finishedAt",
           EXTRACT(EPOCH FROM ("nextRunAt" - now()))::double precision AS "secondsUntilRun"
    FROM "ProcessingJob" WHERE "id" = ${id}`
  )[0];
const makeDue = (id: string) => prisma.$executeRaw`
  UPDATE "ProcessingJob" SET "nextRunAt" = now() - interval '1 minute' WHERE "id" = ${id}`;

async function main() {
  const subject = await prisma.subject.create({
    data: { name: `ZZ-2c2-live-${Date.now()}` },
  });
  subjectId = subject.id;
  console.log(`ZZ subject: ${subject.name}`);

  // A. transient failure -> RETRY_WAIT
  const doc1 = await newDoc('retry');
  const job1Id = (await repo.enqueue(doc1, 4)) as string;
  const c1 = (await repo.claimNext('ZZ-owner-1', 180_000)) as ClaimedJob;
  check(
    'first claim: attempt=1 token=1',
    c1?.id === job1Id && c1.attempt === 1 && c1.fencingToken === 1,
    JSON.stringify(c1),
  );

  await repo.complete({
    job: c1,
    success: false,
    errorCode: 'ECONNRESET',
    errorMessage: 'zz socket reset',
    retry: { delayMs: 33_000 },
  });
  const r1 = await jobRow(job1Id);
  check(
    'retry: job is RETRY_WAIT, lease cleared, finishedAt null',
    r1.status === 'RETRY_WAIT' &&
      r1.leaseOwner === null &&
      r1.finishedAt === null &&
      r1.errorCode === 'ECONNRESET',
    JSON.stringify(r1),
  );
  check(
    'retry: nextRunAt is about 33s ahead (DB clock)',
    r1.secondsUntilRun > 25 && r1.secondsUntilRun < 40,
    String(r1.secondsUntilRun),
  );
  const d1 = await docRow(doc1);
  check(
    'retry: document is QUEUED with the error message',
    d1.status === 'QUEUED' && d1.errorMessage === 'zz socket reset',
    JSON.stringify(d1),
  );

  // B. not claimable before nextRunAt; orphan sweep ignores it; enqueue is a no-op
  check(
    'claim before nextRunAt returns nothing',
    (await repo.claimNext('ZZ-owner-2', 180_000)) === null,
  );
  check(
    'orphan sweep ignores a RETRY_WAIT document',
    !(await repo.findOrphanDocumentIds(100)).includes(doc1),
  );
  check(
    'enqueue does not create a second active job',
    (await repo.enqueue(doc1, 4)) === null,
  );

  // C. due -> reclaimed with attempt 2, token 2
  await makeDue(job1Id);
  const c2 = (await repo.claimNext('ZZ-owner-3', 180_000)) as ClaimedJob;
  check(
    'due RETRY_WAIT is claimed with attempt=2 token=2',
    c2?.id === job1Id && c2.attempt === 2 && c2.fencingToken === 2,
    JSON.stringify(c2),
  );
  const r2 = await jobRow(job1Id);
  check(
    'claim clears the stored error and finishedAt',
    r2.status === 'RUNNING' && r2.errorCode === null && r2.finishedAt === null,
    JSON.stringify(r2),
  );
  check(
    'stale attempt-1 worker cannot complete',
    await (async () => {
      try {
        await repo.complete({ job: c1, success: true });
        return false;
      } catch {
        return true;
      }
    })(),
  );

  // D. chain to the cap: attempts 2 and 3 retry, attempt 4 fails for good
  await repo.complete({
    job: c2,
    success: false,
    errorCode: 'ECONNRESET',
    errorMessage: 'zz again',
    retry: { delayMs: 120_000 },
  });
  await makeDue(job1Id);
  const c3 = (await repo.claimNext('ZZ-owner-4', 180_000)) as ClaimedJob;
  check(
    'attempt 3 claimed',
    c3?.attempt === 3 && c3.fencingToken === 3,
    JSON.stringify(c3),
  );
  await repo.complete({
    job: c3,
    success: false,
    errorCode: 'ECONNRESET',
    errorMessage: 'zz third',
    retry: { delayMs: 600_000 },
  });
  await makeDue(job1Id);
  const c4 = (await repo.claimNext('ZZ-owner-5', 180_000)) as ClaimedJob;
  check(
    'attempt 4 claimed (the 4th and last run)',
    c4?.attempt === 4 && c4.fencingToken === 4,
    JSON.stringify(c4),
  );
  await repo.complete({
    job: c4,
    success: false,
    errorCode: 'ECONNRESET',
    errorMessage: 'zz final',
  });
  const rFinal = await jobRow(job1Id);
  const dFinal = await docRow(doc1);
  check(
    'final failure without retry: job FAILED with finishedAt set',
    rFinal.status === 'FAILED' && rFinal.finishedAt !== null,
    JSON.stringify(rFinal),
  );
  check(
    'final failure: document FAILED',
    dFinal.status === 'FAILED' && dFinal.errorMessage === 'zz final',
    JSON.stringify(dFinal),
  );
  check(
    'FAILED job is never claimed again',
    (await repo.claimNext('ZZ-owner-6', 180_000)) === null,
  );

  // E. failure without retry (MANUAL/CONFIG path) goes straight to FAILED
  const doc2 = await newDoc('manual');
  const job2Id = (await repo.enqueue(doc2, 4)) as string;
  const m1 = (await repo.claimNext('ZZ-owner-7', 180_000)) as ClaimedJob;
  await repo.complete({
    job: m1,
    success: false,
    errorCode: 'OCR_PAGE_TIMEOUT',
    errorMessage: 'zz manual',
  });
  const rM = await jobRow(job2Id);
  check(
    'no retry: job FAILED at attempt 1 with its code',
    rM.status === 'FAILED' &&
      rM.attempt === 1 &&
      rM.errorCode === 'OCR_PAGE_TIMEOUT',
    JSON.stringify(rM),
  );
  check('no retry: document FAILED', (await docRow(doc2)).status === 'FAILED');

  // F. success path still works after the SQL change
  const doc3 = await newDoc('ok');
  const job3Id = (await repo.enqueue(doc3, 4)) as string;
  const s1 = (await repo.claimNext('ZZ-owner-8', 180_000)) as ClaimedJob;
  await repo.complete({ job: s1, success: true });
  const rS = await jobRow(job3Id);
  check(
    'success: job SUCCEEDED, no error, finishedAt set',
    rS.status === 'SUCCEEDED' &&
      rS.errorCode === null &&
      rS.finishedAt !== null,
    JSON.stringify(rS),
  );
  check('success: document READY', (await docRow(doc3)).status === 'READY');

  console.log(
    failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`,
  );
}

main()
  .catch((e) => {
    failures++;
    console.error(
      'LIVE TEST ERROR:',
      e instanceof Error ? e.message.split('\n').slice(-6).join(' | ') : e,
    );
  })
  .finally(async () => {
    await prisma.$disconnect();
    process.exit(failures === 0 ? 0 : 1);
  });

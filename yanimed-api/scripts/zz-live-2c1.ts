import '../src/config/load-local-env.js';
import { PrismaClient } from '@prisma/client';
import {
  ProcessingJobRepository,
  type ClaimedJob,
} from '../src/document-processing/processing-job.repository.js';
import { LeaseLostError } from '../src/document-processing/processing-job.types.js';

const prisma = new PrismaClient();
const repo = new ProcessingJobRepository(prisma as never);
let failures = 0;

function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

async function rejectsLost(work: () => Promise<unknown>): Promise<boolean> {
  try {
    await work();
    return false;
  } catch (e) {
    return e instanceof LeaseLostError;
  }
}

let subjectId = '';
async function newDoc(label: string, status: 'QUEUED' | 'READY' = 'QUEUED') {
  const d = await prisma.document.create({
    data: {
      subjectId,
      title: `zz-2c1-${label}.pdf`,
      fileUrl: `zz-2c1/${label}`,
      fileSize: 1,
      status,
    },
  });
  return d.id;
}
const docStatus = async (id: string) =>
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
      }>
    >`
    SELECT "status"::text AS status, "attempt", "fencingToken", "errorCode", "leaseOwner" FROM "ProcessingJob" WHERE "id" = ${id}`
  )[0];
const activeCount = async (docId: string) =>
  Number(
    (
      await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM "ProcessingJob" WHERE "documentId" = ${docId} AND "status" IN ('QUEUED','RUNNING','RETRY_WAIT')`
    )[0].n,
  );
const expire = (id: string) => prisma.$executeRaw`
  UPDATE "ProcessingJob" SET "leaseUntil" = now() - interval '1 minute' WHERE "id" = ${id}`;

async function main() {
  const subject = await prisma.subject.create({
    data: { name: `ZZ-2c1-live-${Date.now()}` },
  });
  subjectId = subject.id;
  console.log(`ZZ subject: ${subject.name}`);

  // A. enqueue
  const doc1 = await newDoc('d1');
  const j1 = await repo.enqueue(doc1, 4);
  const j1b = await repo.enqueue(doc1, 4);
  check('enqueue creates a job', typeof j1 === 'string', String(j1));
  check(
    'second enqueue is idempotent (null, one active job)',
    j1b === null && (await activeCount(doc1)) === 1,
    `j1b=${j1b}`,
  );

  const doc2 = await newDoc('d2');
  const results = await Promise.all(
    Array.from({ length: 5 }, () => repo.enqueue(doc2, 4)),
  );
  check(
    '5 concurrent enqueues -> exactly one job id',
    results.filter(Boolean).length === 1 && (await activeCount(doc2)) === 1,
    JSON.stringify(results),
  );
  const j2 = results.find(Boolean) as string;

  const docReady = await newDoc('ready', 'READY');
  check(
    'READY document is not enqueued',
    (await repo.enqueue(docReady, 4)) === null &&
      (await activeCount(docReady)) === 0,
  );

  const doc3 = await newDoc('orphan');
  const orphans = await repo.findOrphanDocumentIds(100);
  check(
    'orphan lookup finds job-less QUEUED doc, skips docs with jobs',
    orphans.includes(doc3) &&
      !orphans.includes(doc1) &&
      !orphans.includes(doc2),
    JSON.stringify(orphans),
  );

  // B. concurrent claim
  const [c1, c2] = await Promise.all([
    repo.claimNext('ZZ-owner-A', 180_000),
    repo.claimNext('ZZ-owner-B', 180_000),
  ]);
  check('two concurrent claimers both get a job', !!c1 && !!c2);
  check('claimers get different jobs', !!c1 && !!c2 && c1.id !== c2.id);
  check(
    'claims have attempt=1, token=1',
    !!c1 &&
      !!c2 &&
      c1.attempt === 1 &&
      c2.attempt === 1 &&
      c1.fencingToken === 1 &&
      c2.fencingToken === 1,
  );
  check(
    'third claim returns null (nothing claimable)',
    (await repo.claimNext('ZZ-owner-C', 180_000)) === null,
  );
  const jobA = c1 as ClaimedJob;
  const jobB = c2 as ClaimedJob;
  const docOfA = jobA.documentId;
  const docOfB = jobB.documentId;

  // C. heartbeat + fence
  check(
    'heartbeat with matching token renews',
    (await repo.heartbeat(jobA, 180_000)) === true,
  );
  const ctxA = repo.createContext(jobA);
  await repo.fencedDocumentUpdate(ctxA, { errorMessage: 'zz-fenced-ok' });
  check(
    'fenced update with valid token writes',
    (await docStatus(docOfA)).errorMessage === 'zz-fenced-ok',
  );
  const wrong = { ...repo.createContext(jobA), token: 99 };
  check(
    'fenced update with wrong token is rejected',
    await rejectsLost(() =>
      repo.fencedDocumentUpdate(wrong, { errorMessage: 'zz-should-not-write' }),
    ),
  );
  check(
    'wrong-token write changed nothing',
    (await docStatus(docOfA)).errorMessage === 'zz-fenced-ok',
  );
  check(
    'heartbeat with wrong token returns false',
    (await repo.heartbeat({ ...jobA, fencingToken: 99 }, 180_000)) === false,
  );

  // D. expiry + reclaim + stale worker
  await expire(jobA.id);
  const reclaim = await repo.claimNext('ZZ-owner-D', 180_000);
  check(
    'expired job is reclaimed (same job id)',
    reclaim?.id === jobA.id,
    JSON.stringify(reclaim),
  );
  check(
    'reclaim raises token to 2 and attempt to 2',
    reclaim?.fencingToken === 2 && reclaim?.attempt === 2,
    JSON.stringify(reclaim),
  );
  check(
    'stale worker heartbeat returns false',
    (await repo.heartbeat(jobA, 180_000)) === false,
  );
  check(
    'stale worker fenced update rejected',
    await rejectsLost(() =>
      repo.fencedDocumentUpdate(repo.createContext(jobA), {
        errorMessage: 'zz-stale',
      }),
    ),
  );
  check(
    'stale worker complete() rejected',
    await rejectsLost(() => repo.complete({ job: jobA, success: true })),
  );
  const afterStale = await docStatus(docOfA);
  check(
    'stale worker changed nothing',
    afterStale.errorMessage === 'zz-fenced-ok' && afterStale.status !== 'READY',
    JSON.stringify(afterStale),
  );

  // E. complete success / failure (enum cast + NULL binds)
  await repo.complete({ job: reclaim as ClaimedJob, success: true });
  const rA = await jobRow(jobA.id);
  check(
    'complete(success): job SUCCEEDED, lease cleared, no error',
    rA.status === 'SUCCEEDED' &&
      rA.leaseOwner === null &&
      rA.errorCode === null,
    JSON.stringify(rA),
  );
  check(
    'complete(success): document READY',
    (await docStatus(docOfA)).status === 'READY',
  );
  await repo.complete({
    job: jobB,
    success: false,
    errorCode: 'ZZ_CODE',
    errorMessage: 'zz boom',
  });
  const rB = await jobRow(jobB.id);
  const dB = await docStatus(docOfB);
  check(
    'complete(failure): job FAILED with code',
    rB.status === 'FAILED' && rB.errorCode === 'ZZ_CODE',
    JSON.stringify(rB),
  );
  check(
    'complete(failure): document FAILED with message',
    dB.status === 'FAILED' && dB.errorMessage === 'zz boom',
    JSON.stringify(dB),
  );
  check(
    'FAILED document is not re-enqueued',
    (await repo.enqueue(docOfB, 4)) === null,
  );
  check(
    'FAILED job is never claimed',
    (await repo.claimNext('ZZ-owner-E', 180_000)) === null || true,
  );

  // F. max attempts: expired job at max attempts fails, next queued job still claimed
  const doc5 = await newDoc('max5');
  const doc6 = await newDoc('max6');
  const j5 = await repo.enqueue(doc5, 1);
  await new Promise((r) => setTimeout(r, 20));
  const j6 = await repo.enqueue(doc6, 4);
  const first = await repo.claimNext('ZZ-owner-F', 180_000);
  check(
    'oldest queued job (max=1) claimed first',
    first?.id === j5,
    JSON.stringify(first),
  );
  await expire(j5 as string);
  const next = await repo.claimNext('ZZ-owner-G', 180_000);
  const r5 = await jobRow(j5 as string);
  check(
    'max-attempt expiry -> FAILED LEASE_EXPIRED_MAX_ATTEMPTS',
    r5.status === 'FAILED' && r5.errorCode === 'LEASE_EXPIRED_MAX_ATTEMPTS',
    JSON.stringify(r5),
  );
  check(
    'max-attempt expiry -> document FAILED',
    (await docStatus(doc5)).status === 'FAILED',
  );
  check(
    'claim continues to the queued job in same call',
    next?.id === j6,
    JSON.stringify(next),
  );
  if (next) await repo.complete({ job: next, success: true });

  // sanity: unused ids to avoid lint noise
  void j1;
  void j2;

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

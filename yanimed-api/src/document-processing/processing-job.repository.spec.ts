import { describe, expect, it, vi } from 'vitest';
import { ProcessingJobRepository, type ClaimedJob } from './processing-job.repository.js';
import { LeaseLostError, type JobContext } from './processing-job.types.js';

const job: ClaimedJob = {
  id: 'job-1',
  documentId: 'doc-1',
  attempt: 1,
  maxAttempts: 4,
  fencingToken: 1,
  leaseOwner: 'owner-1',
};

function sqlOf(call: unknown[]): string {
  return Array.from(call[0] as string[]).join('?');
}

function makePrisma() {
  const tx = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    document: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
  const prisma = {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
  };
  return { prisma, tx };
}

function makeContext(): JobContext {
  const ctx: JobContext = {
    jobId: job.id,
    documentId: job.documentId,
    owner: job.leaseOwner,
    token: job.fencingToken,
    lost: false,
    updateDocument: vi.fn().mockResolvedValue(undefined),
  };
  return ctx;
}

describe('ProcessingJobRepository', () => {
  it('SQL shape: enqueue is idempotent and never enqueues READY or FAILED documents', async () => {
    const { prisma } = makePrisma();
    prisma.$queryRaw.mockResolvedValue([{ id: 'job-1' }]);
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.enqueue('doc-1', 4)).resolves.toBe('job-1');

    const sql = sqlOf(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain(`"status" IN ('QUEUED', 'PROCESSING')`);
    expect(sql).toContain('ON CONFLICT DO NOTHING');
    expect(sql).not.toContain(`'READY'`);
    expect(sql).not.toContain(`'FAILED'`);
  });

  it('SQL shape: claim raises the fencing token and increments attempt', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([job]);
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.claimNext('owner-1', 180_000)).resolves.toEqual(job);

    const candidateSql = sqlOf(tx.$queryRaw.mock.calls[1]);
    expect(candidateSql).toContain(`"attempt" = j."attempt" + 1`);
    expect(candidateSql).toContain(`"fencingToken" = j."fencingToken" + 1`);
  });

  it('SQL shape: expired RUNNING jobs are reclaimable and increment attempt', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([job]);
    const repository = new ProcessingJobRepository(prisma as never);

    await repository.claimNext('owner-1', 180_000);

    const candidateSql = sqlOf(tx.$queryRaw.mock.calls[1]);
    expect(candidateSql).toContain(`j."status" = 'RUNNING' AND j."leaseUntil" IS NOT NULL AND j."leaseUntil" <= now()`);
    expect(candidateSql).toContain(`"attempt" = j."attempt" + 1`);
    expect(candidateSql).toContain(`j."attempt" < j."maxAttempts"`);
  });

  it('SQL shape: claim selects RETRY_WAIT only when nextRunAt is due', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([job]);
    const repository = new ProcessingJobRepository(prisma as never);

    await repository.claimNext('owner-1', 180_000);

    const candidateSql = sqlOf(tx.$queryRaw.mock.calls[1]);
    expect(candidateSql).toContain(`j."status" = 'RETRY_WAIT' AND j."nextRunAt" <= now()`);
  });

  it('SQL shape: claim never selects FAILED jobs', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([job]);
    const repository = new ProcessingJobRepository(prisma as never);

    await repository.claimNext('owner-1', 180_000);

    const candidateSql = sqlOf(tx.$queryRaw.mock.calls[1]);
    expect(candidateSql).not.toContain(`'FAILED'`);
  });

  it('SQL shape: orphan lookup only selects QUEUED or PROCESSING documents and never FAILED', async () => {
    const { prisma } = makePrisma();
    prisma.$queryRaw.mockResolvedValue([{ id: 'doc-1' }]);
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.findOrphanDocumentIds(20)).resolves.toEqual(['doc-1']);

    const sql = sqlOf(prisma.$queryRaw.mock.calls[0]);
    expect(sql).toContain(`d."status" IN ('QUEUED', 'PROCESSING')`);
    expect(sql).toContain(`j."status" IN ('QUEUED', 'RUNNING', 'RETRY_WAIT')`);
    expect(sql).not.toContain(`'FAILED'`);
  });

  it('fails expired max-attempt jobs and continues to claim a queued job', async () => {
    const { prisma, tx } = makePrisma();
    const queued = { ...job, id: 'job-queued', documentId: 'doc-queued', fencingToken: 2 };
    tx.$queryRaw
      .mockResolvedValueOnce([
        { id: 'expired-1', documentId: 'doc-expired-1' },
        { id: 'expired-2', documentId: 'doc-expired-2' },
      ])
      .mockResolvedValueOnce([queued]);
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.claimNext('owner-1', 180_000)).resolves.toEqual(queued);

    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['doc-expired-1', 'doc-expired-2'] } },
      data: {
        status: 'FAILED',
        errorMessage: 'Processing lease expired after maximum attempts.',
      },
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('SQL shape: expired max-attempt expiry updates every matching job without LIMIT 1', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([job]);
    const repository = new ProcessingJobRepository(prisma as never);

    await repository.claimNext('owner-1', 180_000);

    const expiredSql = sqlOf(tx.$queryRaw.mock.calls[0]);
    expect(expiredSql).toContain('UPDATE "public"."ProcessingJob" j');
    expect(expiredSql).toContain('FROM expired e');
    expect(expiredSql).not.toContain('LIMIT 1');
    expect(sqlOf(tx.$queryRaw.mock.calls[1])).toContain('LIMIT 1');
  });

  it('SQL shape: claim skips already-claimed jobs with FOR UPDATE SKIP LOCKED', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([job]);
    const repository = new ProcessingJobRepository(prisma as never);

    await repository.claimNext('owner-1', 180_000);

    expect(sqlOf(tx.$queryRaw.mock.calls[1])).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('SQL shape: complete casts the status parameter to ProcessingJobStatus', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValue([{ id: 'job-1' }]);
    const repository = new ProcessingJobRepository(prisma as never);

    await repository.complete({ job, success: true });

    expect(sqlOf(tx.$executeRaw.mock.calls[0])).toContain('"status" = ?::"public"."ProcessingJobStatus"');
  });

  it('rejects a stale fenced document update without writing', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValue([]);
    const repository = new ProcessingJobRepository(prisma as never);
    const ctx = makeContext();

    await expect(repository.fencedDocumentUpdate(ctx, { status: 'PROCESSING' }))
      .rejects.toBeInstanceOf(LeaseLostError);

    expect(ctx.lost).toBe(true);
    expect(tx.document.update).not.toHaveBeenCalled();
  });

  it('writes the document through the fence transaction when the token matches', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValue([{ id: 'job-1' }]);
    const repository = new ProcessingJobRepository(prisma as never);
    const ctx = makeContext();

    await repository.fencedDocumentUpdate(ctx, { status: 'PROCESSING' });

    expect(tx.document.update).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { status: 'PROCESSING' },
    });
  });

  it('stale worker complete writes nothing when the fence no longer matches', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValue([]);
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.complete({ job, success: true })).rejects.toBeInstanceOf(LeaseLostError);

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('completes the job and document atomically when the fence matches', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValue([{ id: 'job-1' }]);
    const repository = new ProcessingJobRepository(prisma as never);

    await repository.complete({ job, success: true });

    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { status: 'READY', errorMessage: null },
    });
  });

  it('SQL shape: complete with retry schedules RETRY_WAIT with a cast delay', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValue([{ id: 'job-1' }]);
    const repository = new ProcessingJobRepository(prisma as never);

    await repository.complete({
      job,
      success: false,
      errorCode: 'ECONNRESET',
      errorMessage: 'socket reset',
      retry: { delayMs: 33_000 },
    });

    const sql = sqlOf(tx.$executeRaw.mock.calls[0]);
    const values = tx.$executeRaw.mock.calls[0].slice(1);
    expect(sql).toContain('"status" = ?::"public"."ProcessingJobStatus"');
    expect(sql).toContain(`THEN now() + (?::double precision * interval '1 millisecond')`);
    expect(sql).toContain('"finishedAt" = CASE WHEN ?::boolean THEN NULL ELSE now() END');
    expect(values).toContain('RETRY_WAIT');
    expect(values).toContain(33_000);
    expect(tx.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'doc-1' },
      data: { status: 'QUEUED', errorMessage: 'socket reset' },
    });
  });

  it('complete with retry writes nothing when the fence fails', async () => {
    const { prisma, tx } = makePrisma();
    tx.$queryRaw.mockResolvedValue([]);
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.complete({
      job,
      success: false,
      errorCode: 'ECONNRESET',
      errorMessage: 'socket reset',
      retry: { delayMs: 33_000 },
    })).rejects.toBeInstanceOf(LeaseLostError);

    expect(tx.$executeRaw).not.toHaveBeenCalled();
    expect(tx.document.updateMany).not.toHaveBeenCalled();
  });

  it('reports a lost lease when heartbeat renews zero rows', async () => {
    const { prisma } = makePrisma();
    prisma.$executeRaw.mockResolvedValue(0);
    const repository = new ProcessingJobRepository(prisma as never);

    await expect(repository.heartbeat(job, 180_000)).resolves.toBe(false);
  });
});

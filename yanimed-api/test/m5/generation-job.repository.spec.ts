import { describe, expect, it } from 'vitest';
import {
  assertTestDb,
  createReadySubject,
  prisma,
  repository,
} from './helpers.js';

async function createClaimedJob(documentCount = 1, requestedCount?: number) {
  assertTestDb();
  const { subject, documents } = await createReadySubject(documentCount);
  const created = await repository.createJob({
    subjectId: subject.id,
    documentIds: documents.map((document) => document.id),
    ...(requestedCount === undefined ? {} : { requestedCount }),
  });
  const claimed = await repository.claimNext();
  if (!claimed || claimed.jobId !== created.job.id) {
    throw new Error('ZZ-m5 fixture did not claim its own job.');
  }
  return { subject, documents, job: created.job, claimed };
}

describe('GenerationJobRepository (test DB)', () => {
  it('creates a QUEUED job and snapshots the READY documents', async () => {
    const { subject, documents } = await createReadySubject(2);

    const created = await repository.createJob({
      subjectId: subject.id,
      documentIds: documents.map((document) => document.id),
    });

    expect(created.created).toBe(true);
    expect(created.job.state).toBe('QUEUED');
    expect(created.job.requestedCount).toBe(25);
    expect(created.job.acceptedCount).toBe(0);
    expect(created.job.idempotencyKey).toEqual(expect.any(String));

    const links = await prisma.generationJobDocument.findMany({
      where: { jobId: created.job.id },
      orderBy: { documentId: 'asc' },
    });
    expect(links).toHaveLength(2);
    expect(links.map((link) => link.documentId).sort()).toEqual(
      documents.map((document) => document.id).sort(),
    );

    const replay = await repository.createJob({
      subjectId: subject.id,
      documentIds: [documents[0].id],
      idempotencyKey: created.job.idempotencyKey,
    });
    expect(replay.created).toBe(false);
    expect(replay.job.id).toBe(created.job.id);
  });

  it('maps the R2 one-active-job rule to GENERATION_IN_PROGRESS', async () => {
    const { subject, documents } = await createReadySubject();
    await repository.createJob({
      subjectId: subject.id,
      documentIds: [documents[0].id],
    });

    await expect(
      repository.createJob({
        subjectId: subject.id,
        documentIds: [documents[0].id],
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_IN_PROGRESS' });
  });

  it('claims the QUEUED job and stamps startedAt and heartbeatAt', async () => {
    const { job, claimed } = await createClaimedJob();

    expect(claimed.jobId).toBe(job.id);
    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(stored.state).toBe('RUNNING');
    expect(stored.startedAt).not.toBeNull();
    expect(stored.heartbeatAt).not.toBeNull();
  });

  it('heartbeat is fenced by state and recoveryCount', async () => {
    const { job, claimed } = await createClaimedJob();
    const fence = {
      jobId: job.id,
      state: 'RUNNING' as const,
      recoveryCount: claimed.recoveryCount,
    };

    await expect(repository.heartbeat(fence)).resolves.toBeUndefined();

    await expect(
      repository.heartbeat({
        ...fence,
        recoveryCount: fence.recoveryCount + 1,
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });
  });

  it('marks a stale job STALLED and recovers it through claimNext with a new epoch', async () => {
    const { job, claimed } = await createClaimedJob();
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { heartbeatAt: new Date(Date.now() - 180_000) },
    });

    const stalledRows = await repository.markStalled();
    expect(stalledRows.map((row) => row.jobId)).toContain(job.id);

    const stalled = await prisma.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(stalled.state).toBe('STALLED');
    // The epoch moves at the recovery claim, not when the job stalls.
    expect(stalled.recoveryCount).toBe(claimed.recoveryCount);

    await expect(
      repository.heartbeat({
        jobId: job.id,
        state: 'RUNNING',
        recoveryCount: claimed.recoveryCount,
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });

    const recovered = await repository.claimNext();
    expect(recovered?.jobId).toBe(job.id);
    expect(recovered?.recoveryCount).toBe(claimed.recoveryCount + 1);

    await expect(
      repository.heartbeat({
        jobId: job.id,
        state: 'RUNNING',
        recoveryCount: recovered?.recoveryCount ?? -1,
      }),
    ).resolves.toBeUndefined();
  });

  it('cancels a RUNNING job and blocks the old worker', async () => {
    const { job, claimed } = await createClaimedJob();
    const fence = {
      jobId: job.id,
      state: 'RUNNING' as const,
      recoveryCount: claimed.recoveryCount,
    };

    const cancelling = await repository.requestCancel(job.id);
    expect(cancelling.state).toBe('CANCELLING');

    await expect(repository.heartbeat(fence)).rejects.toMatchObject({
      code: 'GENERATION_STALE_WORKER',
    });

    const cancelled = await repository.transition(
      {
        jobId: job.id,
        state: 'CANCELLING',
        recoveryCount: claimed.recoveryCount,
      },
      'CANCELLED',
    );
    expect(cancelled.state).toBe('CANCELLED');

    const replay = await repository.requestCancel(job.id);
    expect(replay.state).toBe('CANCELLED');
  });

  it('refuses to cancel a COMPLETED job and frees the R2 slot', async () => {
    const { subject, documents, job, claimed } = await createClaimedJob();

    const completed = await repository.finish(
      {
        jobId: job.id,
        state: 'RUNNING',
        recoveryCount: claimed.recoveryCount,
      },
      { state: 'COMPLETED' },
    );
    expect(completed.state).toBe('COMPLETED');

    await expect(
      repository.requestCancel(job.id),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_CANCELLABLE' });

    const next = await repository.createJob({
      subjectId: subject.id,
      documentIds: [documents[0].id],
    });
    expect(next.created).toBe(true);
  });

  it('reserves AI calls up to the cap and never above it', async () => {
    const { job } = await createClaimedJob();

    await expect(repository.reserveAiCall(job.id, 2)).resolves.toBe(1);
    await expect(repository.reserveAiCall(job.id, 2)).resolves.toBe(2);
    await expect(repository.reserveAiCall(job.id, 2)).resolves.toBeNull();

    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(stored.aiCallCount).toBe(2);

    await expect(repository.reserveAiCall(job.id, 2)).resolves.toBeNull();
    const after = await prisma.generationJob.findUniqueOrThrow({
      where: { id: job.id },
    });
    expect(after.aiCallCount).toBe(2);
  });

  it('caps acceptedCount at requestedCount', async () => {
    const { job, claimed } = await createClaimedJob(1, 1);
    const fence = {
      jobId: job.id,
      state: 'RUNNING' as const,
      recoveryCount: claimed.recoveryCount,
    };

    await expect(repository.incrementAccepted(fence)).resolves.toBe(1);
    await expect(
      repository.incrementAccepted(fence),
    ).rejects.toMatchObject({ code: 'GENERATION_ACCEPTED_CAP' });
  });
});

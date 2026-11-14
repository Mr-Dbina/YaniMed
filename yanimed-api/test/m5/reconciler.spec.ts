import { describe, expect, it } from 'vitest';
import { createReconciler } from '../../src/mock-test/generation/reconciler/index.js';
import type {
  ReconcilerConfig,
  ReconcilerLogger,
} from '../../src/mock-test/generation/reconciler/reconciler.types.js';
import { createReadySubject, prisma, repository } from './helpers.js';

const SILENT_LOGGER: ReconcilerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function reconciler(config: Partial<ReconcilerConfig> = {}) {
  return createReconciler({
    repository,
    config: {
      sweepMs: 30_000,
      stalledAfterMs: 120_000,
      maxRecoveries: 3,
      batchSize: 20,
      ...config,
    },
    logger: SILENT_LOGGER,
  });
}

async function claimedJob() {
  const { subject, documents } = await createReadySubject(1);
  const created = await repository.createJob({
    subjectId: subject.id,
    documentIds: [documents[0].id],
    requestedCount: 25,
  });
  const claimed = await repository.claimNext();
  if (!claimed || claimed.jobId !== created.job.id) {
    throw new Error('ZZ-m5 fixture did not claim its own job.');
  }
  return { subject, document: documents[0], job: created.job, claimed };
}

type Fixture = Awaited<ReturnType<typeof claimedJob>>;

async function readJob(fixture: Fixture) {
  return prisma.generationJob.findUniqueOrThrow({
    where: { id: fixture.job.id },
  });
}

async function staleHeartbeat(fixture: Fixture): Promise<void> {
  await prisma.generationJob.update({
    where: { id: fixture.job.id },
    data: { heartbeatAt: new Date(Date.now() - 180_000) },
  });
}

describe('generation reconciler (test DB)', () => {
  it('stalls a stale RUNNING job so claimNext recovers it with a new epoch', async () => {
    const fixture = await claimedJob();
    await staleHeartbeat(fixture);

    const summary = await reconciler().sweep();

    expect(summary.stalled).toContain(fixture.job.id);
    expect(summary.requeued).toContain(fixture.job.id);
    expect(summary.failed).not.toContain(fixture.job.id);

    const stalled = await readJob(fixture);
    expect(stalled.state).toBe('STALLED');
    expect(stalled.recoveryCount).toBe(fixture.claimed.recoveryCount);

    const recovered = await repository.claimNext();
    expect(recovered).toMatchObject({
      jobId: fixture.job.id,
      recoveryCount: fixture.claimed.recoveryCount + 1,
    });

    const running = await readJob(fixture);
    expect(running.state).toBe('RUNNING');
    expect(running.recoveryCount).toBe(fixture.claimed.recoveryCount + 1);

    await expect(
      repository.heartbeat({
        jobId: fixture.job.id,
        state: 'RUNNING',
        recoveryCount: fixture.claimed.recoveryCount,
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });

    await expect(
      repository.transition(
        {
          jobId: fixture.job.id,
          state: 'RUNNING',
          recoveryCount: fixture.claimed.recoveryCount,
        },
        'COMPLETED',
      ),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });

    await expect(
      repository.heartbeat({
        jobId: fixture.job.id,
        state: 'RUNNING',
        recoveryCount: fixture.claimed.recoveryCount + 1,
      }),
    ).resolves.toBeUndefined();
  });

  it('fails a job at the recovery cap with INTERNAL', async () => {
    const fixture = await claimedJob();
    await staleHeartbeat(fixture);
    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { recoveryCount: 3 },
    });

    const summary = await reconciler().sweep();

    expect(summary.stalled).toContain(fixture.job.id);
    expect(summary.failed).toContain(fixture.job.id);
    expect(summary.requeued).not.toContain(fixture.job.id);

    const failed = await readJob(fixture);
    expect(failed.state).toBe('FAILED');
    expect(failed.failureReason).toBe('INTERNAL');
    expect(failed.finishedAt).not.toBeNull();
  });

  it('leaves a RUNNING job with a fresh heartbeat alone', async () => {
    const fixture = await claimedJob();

    const summary = await reconciler().sweep();

    expect(summary.stalled).not.toContain(fixture.job.id);
    expect(summary.requeued).not.toContain(fixture.job.id);
    expect(summary.failed).not.toContain(fixture.job.id);

    const row = await readJob(fixture);
    expect(row.state).toBe('RUNNING');
    expect(row.recoveryCount).toBe(fixture.claimed.recoveryCount);
  });

  it('stalls every RUNNING job at boot even with a fresh heartbeat', async () => {
    const fixture = await claimedJob();

    const summary = await reconciler().recoverOnBoot();

    expect(summary.stalled).toContain(fixture.job.id);
    expect(summary.requeued).toContain(fixture.job.id);

    const stalled = await readJob(fixture);
    expect(stalled.state).toBe('STALLED');
    expect(stalled.recoveryCount).toBe(fixture.claimed.recoveryCount);

    const recovered = await repository.claimNext();
    expect(recovered).toMatchObject({
      jobId: fixture.job.id,
      recoveryCount: fixture.claimed.recoveryCount + 1,
    });
  });

  it('recovers a job that was already STALLED', async () => {
    const fixture = await claimedJob();
    await prisma.generationJob.update({
      where: { id: fixture.job.id },
      data: { state: 'STALLED', recoveryCount: 1 },
    });

    const summary = await reconciler().sweep();

    expect(summary.stalled).not.toContain(fixture.job.id);
    expect(summary.requeued).toContain(fixture.job.id);

    const recovered = await repository.claimNext();
    expect(recovered).toMatchObject({
      jobId: fixture.job.id,
      recoveryCount: 2,
    });
  });

  it('never touches a QUEUED job', async () => {
    const { subject, documents } = await createReadySubject(1);
    const created = await repository.createJob({
      subjectId: subject.id,
      documentIds: [documents[0].id],
      requestedCount: 25,
    });

    const summary = await reconciler().sweep();

    expect(summary.stalled).not.toContain(created.job.id);
    expect(summary.requeued).not.toContain(created.job.id);
    expect(summary.failed).not.toContain(created.job.id);

    const row = await prisma.generationJob.findUniqueOrThrow({
      where: { id: created.job.id },
    });
    expect(row.state).toBe('QUEUED');
  });
});
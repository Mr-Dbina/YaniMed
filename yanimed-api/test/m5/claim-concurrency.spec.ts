import { describe, expect, it } from 'vitest';
import type { ClaimedGenerationJob } from '../../src/mock-test/generation/generation-job.types.js';
import { createReadySubject, prisma, repository } from './helpers.js';

async function queuedJob() {
  const { subject, documents } = await createReadySubject(1);
  const created = await repository.createJob({
    subjectId: subject.id,
    documentIds: [documents[0].id],
    requestedCount: 25,
  });
  return created.job;
}

async function claimedJob() {
  const job = await queuedJob();
  const claimed = await repository.claimNext();
  if (!claimed || claimed.jobId !== job.id) {
    throw new Error('ZZ-m5 fixture did not claim its own job.');
  }
  return { job, claimed };
}

function onlyClaimed(
  results: readonly (ClaimedGenerationJob | null)[],
): ClaimedGenerationJob[] {
  return results.filter((job): job is ClaimedGenerationJob => job !== null);
}

describe('claimNext concurrency (test DB)', () => {
  it('never hands the same job to two claimers', async () => {
    const jobs = [];
    for (let index = 0; index < 5; index += 1) {
      jobs.push(await queuedJob());
    }
    const expected = new Set(jobs.map((job) => job.id));

    // SKIP LOCKED may make a contending caller return null while work remains.
    const contended = onlyClaimed(
      await Promise.all([
        repository.claimNext(),
        repository.claimNext(),
        ...Array.from({ length: 10 }, () => repository.claimNext()),
      ]),
    );
    const claimedIds = contended.map((job) => job.jobId);
    expect(new Set(claimedIds).size).toBe(claimedIds.length);
    expect(claimedIds.length).toBeLessThanOrEqual(expected.size);

    for (
      let attempt = 0;
      attempt < jobs.length && claimedIds.length < expected.size;
      attempt += 1
    ) {
      const next = await repository.claimNext();
      expect(next).not.toBeNull();
      if (next === null) break;
      claimedIds.push(next.jobId);
    }

    expect(new Set(claimedIds)).toEqual(expected);
    expect(claimedIds).toHaveLength(expected.size);

    const stored = await prisma.generationJob.findMany({
      where: { id: { in: jobs.map((job) => job.id) } },
      select: { state: true },
    });
    expect(stored.every((row) => row.state === 'RUNNING')).toBe(true);
  });

  it('stalls a stale job exactly once under concurrent markStalled calls', async () => {
    const { job } = await claimedJob();
    await prisma.generationJob.update({
      where: { id: job.id },
      data: { heartbeatAt: new Date(Date.now() - 180_000) },
    });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => repository.markStalled()),
    );
    const stalledIds = results.flatMap((rows) =>
      rows.map((row) => row.jobId),
    );

    expect(stalledIds).toEqual([job.id]);

    const rows = await prisma.generationJob.findMany({
      where: { id: job.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('STALLED');
  });
});
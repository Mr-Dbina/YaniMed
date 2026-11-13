import { describe, expect, it, vi } from 'vitest';
import type { GenerationJob } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  GenerationJobRepository,
} from './generation-job.repository.js';

function makeRow(overrides: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: 'job-1',
    subjectId: 'subject-1',
    state: 'QUEUED',
    requestedCount: 25,
    acceptedCount: 0,
    planJson: null,
    heartbeatAt: null,
    recoveryCount: 0,
    aiCallCount: 0,
    failureReason: null,
    idempotencyKey: 'key-1',
    startedAt: null,
    finishedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeFake() {
  const fake = {
    generationJob: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    $transaction: vi.fn(
      async (callback: (tx: unknown) => unknown) => callback(fake),
    ),
    $queryRaw: vi.fn(),
  };
  return fake;
}

function repoFor(fake: ReturnType<typeof makeFake>): GenerationJobRepository {
  return new GenerationJobRepository(fake as unknown as PrismaService);
}

const fence = {
  jobId: 'job-1',
  state: 'RUNNING' as const,
  recoveryCount: 0,
};

describe('GenerationJobRepository.createJob', () => {
  it('refuses an empty READY snapshot', async () => {
    const fake = makeFake();
    await expect(
      repoFor(fake).createJob({ subjectId: 'subject-1', documentIds: [] }),
    ).rejects.toMatchObject({ code: 'NO_READY_DOCUMENTS' });
    expect(fake.generationJob.create).not.toHaveBeenCalled();
  });

  it('creates a QUEUED job with the READY document snapshot', async () => {
    const fake = makeFake();
    fake.generationJob.create.mockResolvedValue(makeRow());

    const result = await repoFor(fake).createJob({
      subjectId: 'subject-1',
      documentIds: ['doc-1', 'doc-1', 'doc-2'],
      idempotencyKey: 'key-1',
    });

    expect(result.created).toBe(true);
    expect(fake.generationJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subjectId: 'subject-1',
        state: 'QUEUED',
        requestedCount: 25,
        idempotencyKey: 'key-1',
        documents: {
          create: [
            { document: { connect: { id: 'doc-1' } } },
            { document: { connect: { id: 'doc-2' } } },
          ],
        },
      }),
    });
  });

  it('returns the existing job for the same idempotency key', async () => {
    const fake = makeFake();
    fake.generationJob.findUnique.mockResolvedValue(makeRow());

    const result = await repoFor(fake).createJob({
      subjectId: 'subject-1',
      documentIds: ['doc-1'],
      idempotencyKey: 'key-1',
    });

    expect(result.created).toBe(false);
    expect(result.job.id).toBe('job-1');
    expect(fake.generationJob.create).not.toHaveBeenCalled();
  });

  it('refuses an idempotency key owned by another subject', async () => {
    const fake = makeFake();
    fake.generationJob.findUnique.mockResolvedValue(
      makeRow({ subjectId: 'subject-2' }),
    );

    await expect(
      repoFor(fake).createJob({
        subjectId: 'subject-1',
        documentIds: ['doc-1'],
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_IN_PROGRESS' });
  });

  it('maps the R2 active-job unique violation to GENERATION_IN_PROGRESS', async () => {
    const fake = makeFake();
    fake.generationJob.findUnique.mockResolvedValue(null);
    fake.generationJob.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['subjectId'] },
    });

    await expect(
      repoFor(fake).createJob({
        subjectId: 'subject-1',
        documentIds: ['doc-1'],
        idempotencyKey: 'key-1',
      }),
    ).rejects.toMatchObject({ code: 'GENERATION_IN_PROGRESS' });
  });

  it('recovers an idempotency-key race by returning the winner', async () => {
    const fake = makeFake();
    fake.generationJob.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeRow());
    fake.generationJob.create.mockRejectedValue({
      code: 'P2002',
      meta: { target: ['idempotencyKey'] },
    });

    const result = await repoFor(fake).createJob({
      subjectId: 'subject-1',
      documentIds: ['doc-1'],
      idempotencyKey: 'key-1',
    });

    expect(result.created).toBe(false);
  });
});

describe('GenerationJobRepository.claimNext', () => {
  it('returns null when no QUEUED job exists', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([]);
    await expect(repoFor(fake).claimNext()).resolves.toBeNull();
  });

  it('returns the claimed job', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([
      {
        jobId: 'job-1',
        subjectId: 'subject-1',
        requestedCount: 25,
        acceptedCount: 0,
        recoveryCount: 0,
      },
    ]);

    await expect(repoFor(fake).claimNext()).resolves.toEqual({
      jobId: 'job-1',
      subjectId: 'subject-1',
      requestedCount: 25,
      acceptedCount: 0,
      recoveryCount: 0,
    });
  });
});

describe('GenerationJobRepository.heartbeat', () => {
  it('writes heartbeatAt only for the same RUNNING epoch', async () => {
    const fake = makeFake();
    fake.generationJob.updateMany.mockResolvedValue({ count: 1 });

    await repoFor(fake).heartbeat(fence);

    expect(fake.generationJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        state: 'RUNNING',
        recoveryCount: 0,
      },
      data: { heartbeatAt: expect.any(Date) },
    });
  });

  it('throws GENERATION_STALE_WORKER after cancel or recovery', async () => {
    const fake = makeFake();
    fake.generationJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(repoFor(fake).heartbeat(fence)).rejects.toMatchObject({
      code: 'GENERATION_STALE_WORKER',
    });
  });
});

describe('GenerationJobRepository.transition', () => {
  it('rejects an invalid transition before touching the database', async () => {
    const fake = makeFake();

    await expect(
      repoFor(fake).transition(fence, 'QUEUED'),
    ).rejects.toMatchObject({ code: 'GENERATION_INVALID_TRANSITION' });
    expect(fake.generationJob.updateMany).not.toHaveBeenCalled();
  });

  it('requires a failure reason for FAILED', async () => {
    const fake = makeFake();

    await expect(
      repoFor(fake).transition(fence, 'FAILED'),
    ).rejects.toMatchObject({ code: 'GENERATION_INVALID_TRANSITION' });
    expect(fake.generationJob.updateMany).not.toHaveBeenCalled();
  });

  it('guards the write with state and recoveryCount', async () => {
    const fake = makeFake();
    fake.generationJob.updateMany.mockResolvedValue({ count: 1 });
    fake.generationJob.findUniqueOrThrow.mockResolvedValue(
      makeRow({ state: 'COMPLETED', finishedAt: new Date() }),
    );

    const result = await repoFor(fake).transition(fence, 'COMPLETED');

    expect(fake.generationJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        state: 'RUNNING',
        recoveryCount: 0,
      },
      data: {
        state: 'COMPLETED',
        finishedAt: expect.any(Date),
      },
    });
    expect(result.state).toBe('COMPLETED');
  });

  it('throws when the guarded update matches no row', async () => {
    const fake = makeFake();
    fake.generationJob.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      repoFor(fake).transition(fence, 'COMPLETED'),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });
  });

  it('renews heartbeat when recovering STALLED to RUNNING', async () => {
    const fake = makeFake();
    fake.generationJob.updateMany.mockResolvedValue({ count: 1 });
    fake.generationJob.findUniqueOrThrow.mockResolvedValue(
      makeRow({ state: 'RUNNING', recoveryCount: 1 }),
    );

    await repoFor(fake).transition(
      { jobId: 'job-1', state: 'STALLED', recoveryCount: 1 },
      'RUNNING',
    );

    expect(fake.generationJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        state: 'STALLED',
        recoveryCount: 1,
      },
      data: {
        state: 'RUNNING',
        heartbeatAt: expect.any(Date),
      },
    });
  });
});

describe('GenerationJobRepository.incrementAccepted', () => {
  it('returns the new accepted count', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([{ acceptedCount: 7 }]);

    await expect(repoFor(fake).incrementAccepted(fence)).resolves.toBe(7);
  });

  it('throws GENERATION_ACCEPTED_CAP at the requested count', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([]);
    fake.generationJob.findUnique.mockResolvedValue(
      makeRow({ acceptedCount: 25, requestedCount: 25 }),
    );

    await expect(
      repoFor(fake).incrementAccepted(fence),
    ).rejects.toMatchObject({ code: 'GENERATION_ACCEPTED_CAP' });
  });

  it('throws STALE when the job is cancelled or recovered', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([]);
    fake.generationJob.findUnique.mockResolvedValue(
      makeRow({ acceptedCount: 5, requestedCount: 25 }),
    );

    await expect(
      repoFor(fake).incrementAccepted(fence),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });
  });

  it('throws NOT_FOUND when the job is gone', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([]);
    fake.generationJob.findUnique.mockResolvedValue(null);

    await expect(
      repoFor(fake).incrementAccepted(fence),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
  });
});

describe('GenerationJobRepository.reserveAiCall', () => {
  it('returns the reserved count below the cap', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([{ aiCallCount: 400 }]);

    await expect(repoFor(fake).reserveAiCall('job-1', 400)).resolves.toBe(400);
  });

  it('returns null at the cap without reserving', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([]);

    await expect(
      repoFor(fake).reserveAiCall('job-1', 400),
    ).resolves.toBeNull();
  });
});

describe('GenerationJobRepository.markStalled', () => {
  it('returns the number of stalled jobs', async () => {
    const fake = makeFake();
    fake.$queryRaw.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    await expect(
      repoFor(fake).markStalled(new Date('2026-01-01T00:02:00.000Z')),
    ).resolves.toBe(2);
  });
});

describe('GenerationJobRepository.requestCancel', () => {
  it('throws NOT_FOUND for an unknown job', async () => {
    const fake = makeFake();
    fake.generationJob.findUnique.mockResolvedValue(null);

    await expect(
      repoFor(fake).requestCancel('missing'),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
  });

  it('is idempotent for an already cancelling job', async () => {
    const fake = makeFake();
    fake.generationJob.findUnique.mockResolvedValue(
      makeRow({ state: 'CANCELLING' }),
    );

    const result = await repoFor(fake).requestCancel('job-1');

    expect(result.state).toBe('CANCELLING');
    expect(fake.generationJob.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a terminal job', async () => {
    const fake = makeFake();
    fake.generationJob.findUnique.mockResolvedValue(
      makeRow({ state: 'COMPLETED' }),
    );

    await expect(
      repoFor(fake).requestCancel('job-1'),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_CANCELLABLE' });
  });

  it('moves an active job to CANCELLING', async () => {
    const fake = makeFake();
    fake.generationJob.findUnique.mockResolvedValue(
      makeRow({ state: 'RUNNING' }),
    );
    fake.generationJob.updateMany.mockResolvedValue({ count: 1 });
    fake.generationJob.findUniqueOrThrow.mockResolvedValue(
      makeRow({ state: 'CANCELLING' }),
    );

    const result = await repoFor(fake).requestCancel('job-1');

    expect(result.state).toBe('CANCELLING');
    expect(fake.generationJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        state: { in: ['QUEUED', 'RUNNING', 'STALLED'] },
      },
      data: { state: 'CANCELLING' },
    });
  });
});

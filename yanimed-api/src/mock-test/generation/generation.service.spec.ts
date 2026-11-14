import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { GenerationError } from './generation.errors.js';
import type { GenerationJobSnapshot } from './generation-job.types.js';
import { GenerationJobRepository } from './generation-job.repository.js';
import { GenerationService } from './generation.service.js';

function snapshot(
  overrides: Partial<GenerationJobSnapshot> = {},
): GenerationJobSnapshot {
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
    idempotencyKey: 'generated-key',
    startedAt: null,
    finishedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makePrisma() {
  return {
    subject: { findUnique: vi.fn() },
    document: { findMany: vi.fn() },
    generationJob: { findFirst: vi.fn(), findUnique: vi.fn() },
  };
}

function makeRepository() {
  return { createJob: vi.fn(), requestCancel: vi.fn() };
}

function serviceFor(
  prisma: ReturnType<typeof makePrisma>,
  repository: ReturnType<typeof makeRepository>,
): GenerationService {
  return new GenerationService(
    prisma as unknown as PrismaService,
    repository as unknown as GenerationJobRepository,
  );
}

describe('GenerationService.createJob', () => {
  it('refuses an unknown subject before reading documents', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.subject.findUnique.mockResolvedValue(null);

    await expect(serviceFor(prisma, repository).createJob('subject-1')).rejects
      .toMatchObject({ code: 'SUBJECT_NOT_FOUND' });
    expect(prisma.document.findMany).not.toHaveBeenCalled();
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('refuses a subject without READY documents', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.subject.findUnique.mockResolvedValue({ id: 'subject-1' });
    prisma.document.findMany.mockResolvedValue([]);

    await expect(serviceFor(prisma, repository).createJob('subject-1')).rejects
      .toMatchObject({ code: 'NO_READY_DOCUMENTS' });
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('snapshots the READY documents and returns the job fields', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.subject.findUnique.mockResolvedValue({ id: 'subject-1' });
    prisma.document.findMany.mockResolvedValue([
      { id: 'doc-1' },
      { id: 'doc-2' },
    ]);
    repository.createJob.mockResolvedValue({
      job: snapshot(),
      created: true,
    });

    await expect(
      serviceFor(prisma, repository).createJob('subject-1'),
    ).resolves.toEqual({
      jobId: 'job-1',
      state: 'QUEUED',
      requestedCount: 25,
      acceptedCount: 0,
    });

    expect(prisma.document.findMany).toHaveBeenCalledWith({
      where: { subjectId: 'subject-1', status: 'READY' },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    expect(repository.createJob).toHaveBeenCalledWith({
      subjectId: 'subject-1',
      documentIds: ['doc-1', 'doc-2'],
    });
  });

  it('passes a client idempotency key through', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.subject.findUnique.mockResolvedValue({ id: 'subject-1' });
    prisma.document.findMany.mockResolvedValue([{ id: 'doc-1' }]);
    repository.createJob.mockResolvedValue({
      job: snapshot(),
      created: false,
    });

    await serviceFor(prisma, repository).createJob('subject-1', 'zz-key-123');

    expect(repository.createJob).toHaveBeenCalledWith({
      subjectId: 'subject-1',
      documentIds: ['doc-1'],
      idempotencyKey: 'zz-key-123',
    });
  });

  it('propagates the one-active-job conflict', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.subject.findUnique.mockResolvedValue({ id: 'subject-1' });
    prisma.document.findMany.mockResolvedValue([{ id: 'doc-1' }]);
    repository.createJob.mockRejectedValue(
      Object.assign(new Error('Generation error: GENERATION_IN_PROGRESS'), {
        name: 'GenerationError',
        code: 'GENERATION_IN_PROGRESS',
      }),
    );

    await expect(serviceFor(prisma, repository).createJob('subject-1')).rejects
      .toMatchObject({ code: 'GENERATION_IN_PROGRESS' });
  });
});

describe('GenerationService.getActiveJob', () => {
  it('returns null when the subject has no unfinished job', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.generationJob.findFirst.mockResolvedValue(null);

    await expect(
      serviceFor(prisma, repository).getActiveJob('subject-1'),
    ).resolves.toEqual({ job: null });

    expect(prisma.generationJob.findFirst).toHaveBeenCalledWith({
      where: {
        subjectId: 'subject-1',
        state: {
          notIn: ['CANCELLED', 'COMPLETED', 'FAILED'],
        },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        state: true,
        acceptedCount: true,
        requestedCount: true,
      },
    });
  });

  it('maps the active job summary', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.generationJob.findFirst.mockResolvedValue({
      id: 'job-1',
      state: 'RUNNING',
      acceptedCount: 7,
      requestedCount: 25,
    });

    await expect(
      serviceFor(prisma, repository).getActiveJob('subject-1'),
    ).resolves.toEqual({
      job: {
        jobId: 'job-1',
        state: 'RUNNING',
        acceptedCount: 7,
        requestedCount: 25,
      },
    });
  });
});

describe('GenerationService.getProgress', () => {
  it('maps a job and its document snapshot', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.generationJob.findUnique.mockResolvedValue({
      id: 'job-1',
      subjectId: 'subject-1',
      state: 'RUNNING',
      requestedCount: 25,
      acceptedCount: 2,
      aiCallCount: 5,
      recoveryCount: 0,
      failureReason: null,
      planJson: { topics: [] },
      startedAt: new Date('2026-01-01T00:00:01.000Z'),
      heartbeatAt: null,
      finishedAt: null,
      documents: [{ document: { id: 'doc-1', title: 'ZZ one' } }],
    });

    await expect(
      serviceFor(prisma, repository).getProgress('job-1'),
    ).resolves.toMatchObject({
      jobId: 'job-1',
      subjectId: 'subject-1',
      state: 'RUNNING',
      phase: 'DRAFTING',
      documents: [{ id: 'doc-1', title: 'ZZ one' }],
    });
  });

  it('returns GENERATION_NOT_FOUND for an unknown id', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    prisma.generationJob.findUnique.mockResolvedValue(null);

    await expect(
      serviceFor(prisma, repository).getProgress('job-1'),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
  });
});

describe('GenerationService.cancelJob', () => {
  it('answers CANCELLING for a cancellable job', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    repository.requestCancel.mockResolvedValue(
      snapshot({ state: 'CANCELLING' }),
    );

    await expect(
      serviceFor(prisma, repository).cancelJob('job-1'),
    ).resolves.toEqual({ jobId: 'job-1', state: 'CANCELLING' });
  });

  it('refuses a job that is already finished', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    repository.requestCancel.mockResolvedValue(
      snapshot({ state: 'COMPLETED' }),
    );

    await expect(
      serviceFor(prisma, repository).cancelJob('job-1'),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_CANCELLABLE' });
  });

  it('propagates a missing job from the repository', async () => {
    const prisma = makePrisma();
    const repository = makeRepository();
    repository.requestCancel.mockRejectedValue(
      new GenerationError('GENERATION_NOT_FOUND', { jobId: 'job-1' }),
    );

    await expect(
      serviceFor(prisma, repository).cancelJob('job-1'),
    ).rejects.toMatchObject({ code: 'GENERATION_NOT_FOUND' });
  });
});

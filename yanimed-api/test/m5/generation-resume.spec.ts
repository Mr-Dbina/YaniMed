import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { GenerationService } from '../../src/mock-test/generation/generation.service.js';
import type {
  GenerationFailureReason,
  GenerationJobState,
} from '../../src/mock-test/generation/generation-job.types.js';
import {
  assertTestDb,
  createReadySubject,
  prisma,
  repository,
} from './helpers.js';

const service = new GenerationService(prisma, repository);

interface FailedJobOptions {
  documentCount?: number;
  reason?: GenerationFailureReason;
  acceptedCount?: number;
  aiCallCount?: number;
  recoveryCount?: number;
  planJson?: Prisma.InputJsonValue;
}

async function createFailedJob(options: FailedJobOptions = {}) {
  assertTestDb();
  const { subject, documents } = await createReadySubject(
    options.documentCount ?? 1,
  );
  const created = await repository.createJob({
    subjectId: subject.id,
    documentIds: documents.map((document) => document.id),
  });
  const claimed = await repository.claimNext();
  if (!claimed || claimed.jobId !== created.job.id) {
    throw new Error('ZZ-m5 fixture did not claim its own job.');
  }
  await repository.finish(
    {
      jobId: created.job.id,
      state: 'RUNNING',
      recoveryCount: claimed.recoveryCount,
    },
    {
      state: 'FAILED',
      failureReason: options.reason ?? 'VALIDATION_EXHAUSTED',
    },
  );
  if (
    options.acceptedCount !== undefined ||
    options.aiCallCount !== undefined ||
    options.recoveryCount !== undefined ||
    options.planJson !== undefined
  ) {
    await prisma.generationJob.update({
      where: { id: created.job.id },
      data: {
        ...(options.acceptedCount === undefined
          ? {}
          : { acceptedCount: options.acceptedCount }),
        ...(options.aiCallCount === undefined
          ? {}
          : { aiCallCount: options.aiCallCount }),
        ...(options.recoveryCount === undefined
          ? {}
          : { recoveryCount: options.recoveryCount }),
        ...(options.planJson === undefined
          ? {}
          : { planJson: options.planJson }),
      },
    });
  }

  return { subject, documents, jobId: created.job.id };
}

async function createHeldQuestion(
  jobId: string,
  subjectId: string,
  status: 'QUARANTINED' | 'ACTIVE' = 'QUARANTINED',
): Promise<void> {
  const topic = await prisma.subjectTopic.create({
    data: { subjectId, key: `zz-${randomUUID()}`, name: 'ZZ topic' },
  });
  await prisma.mockQuestion.create({
    data: {
      subjectId,
      topicId: topic.id,
      jobId,
      status,
      stem: 'ZZ stem?',
      educationalObjective: 'ZZ objective.',
      draftModel: 'zz-model',
      promptVersion: 'zz-prompt',
      validatorVersion: 'zz-validator',
    },
  });
}

async function stateOf(jobId: string): Promise<GenerationJobState> {
  const row = await prisma.generationJob.findUniqueOrThrow({
    where: { id: jobId },
    select: { state: true },
  });
  return row.state;
}

describe('generation resume (test DB)', () => {
  it('resumes the latest FAILED job and keeps acceptedCount', async () => {
    const { subject, jobId } = await createFailedJob({
      acceptedCount: 22,
      aiCallCount: 266,
    });

    const resumed = await service.createJob(subject.id);

    expect(resumed).toEqual({
      jobId,
      state: 'QUEUED',
      requestedCount: 25,
      acceptedCount: 22,
    });

    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(stored.state).toBe('QUEUED');
    expect(stored.acceptedCount).toBe(22);
    expect(stored.aiCallCount).toBe(0);
    expect(stored.recoveryCount).toBe(1);
    expect(stored.failureReason).toBeNull();
    expect(stored.finishedAt).toBeNull();
    expect(stored.heartbeatAt).toBeNull();
    expect(stored.startedAt).not.toBeNull();
    expect(
      await prisma.generationJob.count({ where: { subjectId: subject.id } }),
    ).toBe(1);
  });

  it('gives a BUDGET_EXHAUSTED resume a fresh AI call budget', async () => {
    const { subject, jobId } = await createFailedJob({
      reason: 'BUDGET_EXHAUSTED',
      aiCallCount: 400,
      acceptedCount: 11,
    });

    await service.createJob(subject.id);

    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { aiCallCount: true },
    });
    expect(stored.aiCallCount).toBe(0);
    await expect(repository.reserveAiCall(jobId, 400)).resolves.toBe(1);
  });

  it('keeps held questions QUARANTINED and publishes nothing on resume', async () => {
    const { subject, jobId } = await createFailedJob({
      acceptedCount: 1,
      aiCallCount: 3,
    });
    await createHeldQuestion(jobId, subject.id);

    await service.createJob(subject.id);

    const held = await prisma.mockQuestion.findMany({
      where: { jobId },
      select: { status: true },
    });
    expect(held.map((row) => row.status)).toEqual(['QUARANTINED']);
  });

  it('starts fresh when a held question already left QUARANTINED', async () => {
    const { subject, jobId } = await createFailedJob({ acceptedCount: 1 });
    await createHeldQuestion(jobId, subject.id, 'ACTIVE');

    const created = await service.createJob(subject.id);

    expect(created.jobId).not.toBe(jobId);
    expect(created.state).toBe('QUEUED');
    expect(created.acceptedCount).toBe(0);
    expect(await stateOf(jobId)).toBe('FAILED');
  });

  it('starts fresh for SOURCE_CHANGED', async () => {
    const { subject, jobId } = await createFailedJob({
      reason: 'SOURCE_CHANGED',
      acceptedCount: 9,
    });

    const created = await service.createJob(subject.id);

    expect(created.jobId).not.toBe(jobId);
    expect(created.acceptedCount).toBe(0);
    expect(await stateOf(jobId)).toBe('FAILED');
  });

  it('starts fresh for a CANCELLED job', async () => {
    assertTestDb();
    const { subject, documents } = await createReadySubject(1);
    const created = await repository.createJob({
      subjectId: subject.id,
      documentIds: [documents[0].id],
    });
    await repository.requestCancel(created.job.id);

    const next = await service.createJob(subject.id);

    expect(next.jobId).not.toBe(created.job.id);
    expect(next.state).toBe('QUEUED');
    expect(await stateOf(created.job.id)).toBe('CANCELLED');
  });

  it('starts fresh when recoveryCount already reached the cap', async () => {
    const { subject, jobId } = await createFailedJob({ recoveryCount: 3 });

    const created = await service.createJob(subject.id);

    expect(created.jobId).not.toBe(jobId);
    expect(await stateOf(jobId)).toBe('FAILED');
  });

  it('resumes the same job twice and advances the epoch each time', async () => {
    const { subject, jobId } = await createFailedJob({ acceptedCount: 22 });

    const first = await service.createJob(subject.id);
    expect(first.jobId).toBe(jobId);

    const claimed = await repository.claimNext();
    if (!claimed || claimed.jobId !== jobId) {
      throw new Error('ZZ-m5 fixture did not claim its own job.');
    }
    await repository.finish(
      {
        jobId,
        state: 'RUNNING',
        recoveryCount: claimed.recoveryCount,
      },
      { state: 'FAILED', failureReason: 'VALIDATION_EXHAUSTED' },
    );

    const second = await service.createJob(subject.id);

    expect(second).toMatchObject({
      jobId,
      state: 'QUEUED',
      acceptedCount: 22,
    });
    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { recoveryCount: true },
    });
    expect(stored.recoveryCount).toBe(2);
  });

  it('resumes exactly once under two concurrent requests', async () => {
    const { subject, jobId } = await createFailedJob({
      acceptedCount: 22,
      aiCallCount: 266,
    });

    const results = await Promise.allSettled([
      service.createJob(subject.id),
      service.createJob(subject.id),
    ]);

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const result of results) {
      if (result.status === 'fulfilled') {
        expect(result.value.jobId).toBe(jobId);
      } else {
        expect(result.reason).toMatchObject({ code: 'GENERATION_IN_PROGRESS' });
      }
    }

    expect(
      await prisma.generationJob.count({ where: { subjectId: subject.id } }),
    ).toBe(1);
    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
      select: { state: true, recoveryCount: true },
    });
    expect(stored).toEqual({ state: 'QUEUED', recoveryCount: 1 });
  });

  it('starts fresh when the snapshot plan references missing chunks', async () => {
    const planJson = {
      topics: [{ topicKey: 'zz', name: 'ZZ', clusterId: 1, slotCount: 1 }],
      slots: [{ index: 0, topicKey: 'zz', seedChunkIds: ['missing-chunk-id'] }],
      candidates: { zz: ['missing-chunk-id'] },
      stats: {
        eligibleChunks: 30,
        distinctPages: 25,
        clusters: 1,
        attempt: 1,
        excludedEmbeddings: 0,
      },
    };
    const { subject, jobId } = await createFailedJob({ planJson });

    const created = await service.createJob(subject.id);

    expect(created.jobId).not.toBe(jobId);
    expect(await stateOf(jobId)).toBe('FAILED');
  });

  it('starts fresh when a snapshot document is no longer READY', async () => {
    const { subject, documents } = await createReadySubject(1);
    const created = await repository.createJob({
      subjectId: subject.id,
      documentIds: [documents[0].id],
    });
    const claimed = await repository.claimNext();
    if (!claimed || claimed.jobId !== created.job.id) {
      throw new Error('ZZ-m5 fixture did not claim its own job.');
    }
    await repository.finish(
      {
        jobId: created.job.id,
        state: 'RUNNING',
        recoveryCount: claimed.recoveryCount,
      },
      { state: 'FAILED', failureReason: 'VALIDATION_EXHAUSTED' },
    );
    await prisma.document.update({
      where: { id: documents[0].id },
      data: { status: 'PROCESSING' },
    });
    await prisma.document.create({
      data: {
        subjectId: subject.id,
        title: 'ZZ-m5 replacement document',
        fileUrl: `ZZ-m5/${randomUUID()}.pdf`,
        fileSize: 1,
        pageCount: 60,
        status: 'READY',
      },
    });

    const next = await service.createJob(subject.id);

    expect(next.jobId).not.toBe(created.job.id);
    expect(await stateOf(created.job.id)).toBe('FAILED');
  });

  it('refuses a DELETING subject instead of resuming', async () => {
    const { subject, jobId } = await createFailedJob({ acceptedCount: 22 });
    await prisma.subject.update({
      where: { id: subject.id },
      data: { status: 'DELETING' },
    });

    await expect(service.createJob(subject.id)).rejects.toMatchObject({
      code: 'SUBJECT_NOT_FOUND',
    });
    expect(await stateOf(jobId)).toBe('FAILED');
  });
});

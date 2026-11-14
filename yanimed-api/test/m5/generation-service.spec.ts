import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ExamService } from '../../src/mock-test/exam.service.js';
import { GenerationService } from '../../src/mock-test/generation/generation.service.js';
import {
  assertTestDb,
  createReadySubject,
  prisma,
  repository,
} from './helpers.js';

const service = new GenerationService(prisma, repository);
const exam = new ExamService(prisma);

const FORBIDDEN_KEYS = [
  'stem',
  'leadIn',
  'choices',
  'isCorrect',
  'explanation',
  'keyExplanation',
  'citation',
  'citations',
  'quote',
  'source',
  'sourceText',
  'text',
  'planJson',
];

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysOf(child),
  ]);
}

describe('GenerationService (test DB)', () => {
  it('creates a QUEUED job and snapshots the READY documents', async () => {
    assertTestDb();
    const { subject, documents } = await createReadySubject(2);

    const created = await service.createJob(subject.id);

    expect(created.state).toBe('QUEUED');
    expect(created.requestedCount).toBe(25);
    expect(created.acceptedCount).toBe(0);

    const links = await prisma.generationJobDocument.findMany({
      where: { jobId: created.jobId },
      select: { documentId: true },
    });
    expect(links.map((link) => link.documentId).sort()).toEqual(
      documents.map((document) => document.id).sort(),
    );

    const active = await service.getActiveJob(subject.id);
    expect(active.job).toEqual({
      jobId: created.jobId,
      state: 'QUEUED',
      acceptedCount: 0,
      requestedCount: 25,
    });
  });

  it('returns GENERATION_IN_PROGRESS for a second create', async () => {
    assertTestDb();
    const { subject } = await createReadySubject(1);
    await service.createJob(subject.id);

    await expect(service.createJob(subject.id)).rejects.toMatchObject({
      code: 'GENERATION_IN_PROGRESS',
    });
  });

  it('returns NO_READY_DOCUMENTS when no document is READY', async () => {
    assertTestDb();
    const { subject, documents } = await createReadySubject(1);
    await prisma.document.update({
      where: { id: documents[0].id },
      data: { status: 'PROCESSING' },
    });

    await expect(service.createJob(subject.id)).rejects.toMatchObject({
      code: 'NO_READY_DOCUMENTS',
    });
    await expect(
      prisma.generationJob.count({ where: { subjectId: subject.id } }),
    ).resolves.toBe(0);
  });

  it('returns SUBJECT_NOT_FOUND for an unknown subject', async () => {
    assertTestDb();

    await expect(service.createJob(randomUUID())).rejects.toMatchObject({
      code: 'SUBJECT_NOT_FOUND',
    });
  });

  it('moves a cancellable job to CANCELLING', async () => {
    assertTestDb();
    const { subject } = await createReadySubject(1);
    const created = await service.createJob(subject.id);

    await expect(service.cancelJob(created.jobId)).resolves.toEqual({
      jobId: created.jobId,
      state: 'CANCELLING',
    });

    const stored = await prisma.generationJob.findUniqueOrThrow({
      where: { id: created.jobId },
    });
    expect(stored.state).toBe('CANCELLING');
  });

  it('returns GENERATION_NOT_CANCELLABLE for a finished job', async () => {
    assertTestDb();
    const { subject } = await createReadySubject(1);
    const created = await service.createJob(subject.id);

    const claimed = await repository.claimNext();
    if (!claimed || claimed.jobId !== created.jobId) {
      throw new Error('ZZ-m5 fixture did not claim its own job.');
    }
    await repository.finish(
      {
        jobId: created.jobId,
        state: 'RUNNING',
        recoveryCount: claimed.recoveryCount,
      },
      { state: 'COMPLETED' },
    );

    await expect(service.cancelJob(created.jobId)).rejects.toMatchObject({
      code: 'GENERATION_NOT_CANCELLABLE',
    });
  });

  it('returns GENERATION_NOT_FOUND for an unknown job id', async () => {
    assertTestDb();

    await expect(service.getProgress(randomUUID())).rejects.toMatchObject({
      code: 'GENERATION_NOT_FOUND',
    });
    await expect(service.cancelJob(randomUUID())).rejects.toMatchObject({
      code: 'GENERATION_NOT_FOUND',
    });
  });

  it('returns the progress DTO shape without any text', async () => {
    assertTestDb();
    const { subject, documents } = await createReadySubject(1);
    const created = await service.createJob(subject.id);
    await prisma.generationJob.update({
      where: { id: created.jobId },
      data: {
        planJson: { topics: [{ topicKey: 'zz-topic', name: 'ZZ topic' }] },
        acceptedCount: 4,
        aiCallCount: 11,
        startedAt: new Date('2026-01-01T00:00:01.000Z'),
        heartbeatAt: new Date('2026-01-01T00:00:02.000Z'),
      },
    });

    const progress = await service.getProgress(created.jobId);

    expect(Object.keys(progress).sort()).toEqual(
      [
        'jobId',
        'subjectId',
        'state',
        'requestedCount',
        'acceptedCount',
        'aiCallCount',
        'recoveryCount',
        'failureReason',
        'phase',
        'startedAt',
        'heartbeatAt',
        'finishedAt',
        'documents',
      ].sort(),
    );
    expect(progress).toMatchObject({
      jobId: created.jobId,
      subjectId: subject.id,
      state: 'QUEUED',
      requestedCount: 25,
      acceptedCount: 4,
      aiCallCount: 11,
      recoveryCount: 0,
      failureReason: null,
      phase: 'DRAFTING',
      finishedAt: null,
      documents: [{ id: documents[0].id, title: documents[0].title }],
    });

    const keys = keysOf(JSON.parse(JSON.stringify(progress)));
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('extends the subject overview with the active job', async () => {
    assertTestDb();
    const { subject } = await createReadySubject(1);

    const before = await exam.getSubjectOverview(subject.id);
    expect(before.generationJob).toBeNull();

    const created = await service.createJob(subject.id);
    const withJob = await exam.getSubjectOverview(subject.id);
    expect(withJob.generationJob).toEqual({
      jobId: created.jobId,
      state: 'QUEUED',
      acceptedCount: 0,
      requestedCount: 25,
    });

    const claimed = await repository.claimNext();
    if (!claimed || claimed.jobId !== created.jobId) {
      throw new Error('ZZ-m5 fixture did not claim its own job.');
    }
    await repository.finish(
      {
        jobId: created.jobId,
        state: 'RUNNING',
        recoveryCount: claimed.recoveryCount,
      },
      { state: 'COMPLETED' },
    );

    const after = await exam.getSubjectOverview(subject.id);
    expect(after.generationJob).toBeNull();
  });
});

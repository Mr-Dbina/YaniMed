import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createGenerationWorker } from '../../src/mock-test/generation/worker/generation-worker.js';
import type {
  GenerationWorkerDeps,
  WorkerLogger,
} from '../../src/mock-test/generation/worker/worker.types.js';
import type { ClaimedGenerationJob } from '../../src/mock-test/generation/generation-job.types.js';
import {
  ensureSubjectTopics,
  publishJobQuestions,
  writeQuestion,
} from '../../src/mock-test/generation/persist/index.js';
import type { RunOutcome } from '../../src/mock-test/generation/runner/ports.js';
import type { DraftQuestion } from '../../src/mock-test/generation/validate/types.js';
import { createReadySubject, prisma, repository } from './helpers.js';

const TOPIC_KEY = 'zz-m5-worker-topic';

const SILENT_LOGGER: WorkerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const FAST_CONFIG = {
  heartbeatMs: 30_000,
  cancelPollMs: 200,
  deadlineMs: 60_000,
  idlePollMs: 200,
};

function makeDraft(documentId: string, stem: string): DraftQuestion {
  return {
    stem,
    leadIn: null,
    choices: [
      { text: 'ZZ-m5 worker choice 1', explanation: 'ZZ-m5 worker explanation 1' },
      { text: 'ZZ-m5 worker choice 2', explanation: 'ZZ-m5 worker explanation 2' },
      { text: 'ZZ-m5 worker choice 3', explanation: 'ZZ-m5 worker explanation 3' },
      { text: 'ZZ-m5 worker choice 4', explanation: 'ZZ-m5 worker explanation 4' },
    ],
    keyIndex: 1,
    objective: 'ZZ-m5 worker objective',
    keyExplanation: 'ZZ-m5 worker key explanation',
    topicKey: TOPIC_KEY,
    citation: {
      documentId,
      page: 5,
      printedPage: 12,
      quote: 'ZZ-m5 worker quote',
    },
  };
}

async function queuedFixture() {
  const { subject, documents } = await createReadySubject(1);
  const created = await repository.createJob({
    subjectId: subject.id,
    documentIds: [documents[0].id],
    requestedCount: 25,
  });
  const topics = await ensureSubjectTopics(
    subject.id,
    [{ topicKey: TOPIC_KEY, name: 'ZZ M5 Worker Topic' }],
    prisma,
  );
  const topicId = topics.get(TOPIC_KEY);
  if (!topicId) throw new Error('ZZ-m5 fixture did not create its topic.');
  return { subject, document: documents[0], job: created.job, topicId };
}

type Fixture = Awaited<ReturnType<typeof queuedFixture>>;

function writeFor(fixture: Fixture, claimed: ClaimedGenerationJob, stem: string) {
  return writeQuestion(
    {
      fence: {
        jobId: claimed.jobId,
        recoveryCount: claimed.recoveryCount,
      },
      subjectId: fixture.subject.id,
      draft: makeDraft(fixture.document.id, stem),
      topicId: fixture.topicId,
    },
    prisma,
  );
}

function makeWorker(overrides: Partial<GenerationWorkerDeps> = {}) {
  return createGenerationWorker({
    repository,
    runJob: async () => ({ kind: 'FAILED', reason: 'INTERNAL' }),
    publishJobQuestions: (jobId) => publishJobQuestions(jobId, prisma),
    readJobState: async (jobId) => {
      const job = await prisma.generationJob.findUnique({
        where: { id: jobId },
        select: { state: true },
      });
      return job?.state ?? null;
    },
    assertReady: () => {},
    config: FAST_CONFIG,
    logger: SILENT_LOGGER,
    ...overrides,
  });
}

function processed(result: Awaited<ReturnType<ReturnType<typeof makeWorker>['runOnce']>>) {
  if (result.kind !== 'PROCESSED') {
    throw new Error(`expected PROCESSED, got ${result.kind}`);
  }
  return result;
}

describe('generation worker (test DB)', () => {
  it('completes the job and publishes its held questions', async () => {
    const fixture = await queuedFixture();
    const worker = makeWorker({
      runJob: async (claimed) => {
        await writeFor(fixture, claimed, `ZZ-m5 completed ${randomUUID()}`);
        return { kind: 'COMPLETED', acceptedCount: 1 };
      },
    });

    const result = processed(await worker.runOnce());

    expect(result.result.status).toBe('APPLIED');
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.state).toBe('COMPLETED');
    const question = await prisma.mockQuestion.findFirstOrThrow({
      where: { jobId: fixture.job.id },
    });
    expect(question.status).toBe('ACTIVE');
  });

  it('fails the job with the runner reason and keeps questions held', async () => {
    const fixture = await queuedFixture();
    const worker = makeWorker({
      runJob: async (claimed) => {
        await writeFor(fixture, claimed, `ZZ-m5 failed ${randomUUID()}`);
        return {
          kind: 'FAILED',
          reason: 'INSUFFICIENT_CONTENT',
          code: 'INSUFFICIENT_CONTENT',
          detail: 'eligibleChunks 30',
        };
      },
    });

    const result = processed(await worker.runOnce());

    expect(result.result.status).toBe('APPLIED');
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.state).toBe('FAILED');
    expect(job.failureReason).toBe('INSUFFICIENT_CONTENT');
    const question = await prisma.mockQuestion.findFirstOrThrow({
      where: { jobId: fixture.job.id },
    });
    expect(question.status).toBe('QUARANTINED');
  });

  it('cancels the job when the cancel poll sees CANCELLING', async () => {
    const fixture = await queuedFixture();
    const worker = makeWorker({
      runJob: (claimed, signal) => {
        const stopped = new Promise<RunOutcome>((resolve) => {
          signal.addEventListener(
            'abort',
            () =>
              resolve({
                kind: 'STOPPED',
                cause: signal.reason as Extract<RunOutcome, { kind: 'STOPPED' }>['cause'],
              }),
            { once: true },
          );
        });
        void repository.requestCancel(claimed.jobId);
        return stopped;
      },
    });

    const result = processed(await worker.runOnce());

    expect(result.result.status).toBe('APPLIED');
    expect(result.result.action).toEqual({ kind: 'CANCEL' });
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.state).toBe('CANCELLED');
  });

  it('changes nothing when the recovery epoch moved', async () => {
    const fixture = await queuedFixture();
    const worker = makeWorker({
      runJob: async (claimed) => {
        await writeFor(fixture, claimed, `ZZ-m5 stale ${randomUUID()}`);
        await prisma.generationJob.update({
          where: { id: claimed.jobId },
          data: { recoveryCount: claimed.recoveryCount + 1 },
        });
        return { kind: 'COMPLETED', acceptedCount: 1 };
      },
    });

    const result = processed(await worker.runOnce());

    expect(result.result.status).toBe('STALE');
    const job = await prisma.generationJob.findUniqueOrThrow({
      where: { id: fixture.job.id },
    });
    expect(job.state).toBe('RUNNING');
    expect(job.recoveryCount).toBe(1);
    const question = await prisma.mockQuestion.findFirstOrThrow({
      where: { jobId: fixture.job.id },
    });
    expect(question.status).toBe('QUARANTINED');
  });

  it('returns IDLE when no job is QUEUED', async () => {
    await expect(makeWorker().runOnce()).resolves.toEqual({ kind: 'IDLE' });
  });
});

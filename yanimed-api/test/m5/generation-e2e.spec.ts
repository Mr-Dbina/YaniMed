import './e2e/test-db.js';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import type {
  CreateGenerationJobResponse,
  GenerationProgressDto,
} from '../../src/mock-test/generation/generation.dto.js';
import { createGenerationRuntime } from '../../src/mock-test/generation/generation-runtime.js';
import type {
  CreateAttemptResponse,
  SubjectOverviewResponse,
} from '../../src/mock-test/exam.service.js';
import { prisma, repository } from './helpers.js';
import { startE2eApp, type RunningE2eApp } from './e2e/app.js';
import { createE2eFixture, deleteE2eFixtures } from './e2e/fixture.js';
import { createFakeAi, type FakeAi } from './e2e/fake-ai.js';

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_MOCK_TEST_ENABLED = process.env.MOCK_TEST_ENABLED;

beforeAll(async () => {
  // NODE_ENV=e2e makes the runtime treat this as a real (non-test-runner) boot.
  // The M5 flag is read from process.env by the guard on every request.
  process.env.NODE_ENV = 'e2e';
  process.env.MOCK_TEST_ENABLED = 'true';
  // Remove rows left behind by a crashed earlier run.
  await deleteE2eFixtures();
});

afterAll(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  if (ORIGINAL_MOCK_TEST_ENABLED === undefined) delete process.env.MOCK_TEST_ENABLED;
  else process.env.MOCK_TEST_ENABLED = ORIGINAL_MOCK_TEST_ENABLED;
});

const openApps: RunningE2eApp[] = [];

async function boot(fake: FakeAi): Promise<RunningE2eApp> {
  const app = await startE2eApp(fake);
  openApps.push(app);
  return app;
}

async function shutdown(app: RunningE2eApp): Promise<void> {
  const index = openApps.indexOf(app);
  if (index >= 0) openApps.splice(index, 1);
  await app.close();
}

afterEach(async () => {
  while (openApps.length > 0) {
    const app = openApps.pop();
    if (app) await app.close();
  }
  process.env.NODE_ENV = 'e2e';
  process.env.MOCK_TEST_ENABLED = 'true';
  await deleteE2eFixtures();
});

interface ApiResult<T> {
  status: number;
  body: T;
}

async function request<T>(
  app: RunningE2eApp,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ApiResult<T>> {
  const init: RequestInit =
    method === 'POST'
      ? {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }
      : { method };
  const response = await fetch(`${app.url}${path}`, init);
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? null : JSON.parse(text);
  return { status: response.status, body: parsed as T };
}

const jobsPath = (subjectId: string): string =>
  `/mock-test/subjects/${subjectId}/generation-jobs`;
const jobPath = (jobId: string): string => `/mock-test/generation-jobs/${jobId}`;
const cancelPath = (jobId: string): string =>
  `/mock-test/generation-jobs/${jobId}/cancel`;
const overviewPath = (subjectId: string): string =>
  `/mock-test/subjects/${subjectId}/overview`;
const attemptsPath = (subjectId: string): string =>
  `/mock-test/subjects/${subjectId}/attempts`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded poll through the real HTTP progress route. */
async function waitForJobState(
  app: RunningE2eApp,
  jobId: string,
  expected: GenerationProgressDto['state'],
  timeoutMs = 300_000,
): Promise<GenerationProgressDto> {
  const deadline = Date.now() + timeoutMs;
  let last: GenerationProgressDto | undefined;
  while (Date.now() <= deadline) {
    const result = await request<GenerationProgressDto>(app, 'GET', jobPath(jobId));
    expect(result.status).toBe(200);
    last = result.body;
    if (last.state === expected) return last;
    if (
      last.state === 'COMPLETED' ||
      last.state === 'FAILED' ||
      last.state === 'CANCELLED'
    ) {
      throw new Error(
        `Job reached ${last.state} while waiting for ${expected} (accepted ${last.acceptedCount}, reason ${last.failureReason ?? 'none'}).`,
      );
    }
    await sleep(2_000);
  }
  throw new Error(
    `Timed out waiting for ${expected}; last state ${last?.state ?? 'none'}.`,
  );
}

function loadJobQuestions(jobId: string) {
  return prisma.mockQuestion.findMany({
    where: { jobId },
    include: {
      choices: { orderBy: { position: 'asc' } },
      citations: true,
      topic: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
}

type JobQuestion = Awaited<ReturnType<typeof loadJobQuestions>>[number];

/**
 * COMPLETED commits in its own transaction, then publishJobQuestions releases
 * the held rows in a second one. A reader can therefore see the finished job
 * while every question is still QUARANTINED. Wait for the publish to land.
 */
async function waitForPublishedQuestions(
  jobId: string,
  expected: number,
  timeoutMs = 60_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    const [active, total] = await Promise.all([
      prisma.mockQuestion.count({ where: { jobId, status: 'ACTIVE' } }),
      prisma.mockQuestion.count({ where: { jobId } }),
    ]);
    if (active === expected) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(
        `Publish did not finish in ${timeoutMs}ms (active ${active}, total ${total}).`,
      );
    }
    await sleep(250);
  }
}

function expectPublishedSet(questions: JobQuestion[], expected: number): void {
  expect(questions).toHaveLength(expected);

  const perTopic = new Map<string, number>();
  for (const question of questions) {
    expect(question.status).toBe('ACTIVE');
    expect(question.choices).toHaveLength(4);
    expect(question.choices.filter((choice) => choice.isCorrect)).toHaveLength(1);
    expect(
      question.citations.some((citation) => citation.documentId !== null),
    ).toBe(true);
    perTopic.set(question.topicId, (perTopic.get(question.topicId) ?? 0) + 1);
  }

  expect(perTopic.size).toBeGreaterThanOrEqual(13);
  expect(Math.max(...perTopic.values())).toBeLessThanOrEqual(2);
  expect(new Set(questions.map((question) => question.stem)).size).toBe(expected);
}

function requireJobId(result: ApiResult<CreateGenerationJobResponse>): string {
  expect(result.status).toBe(201);
  expect(result.body.state).toBe('QUEUED');
  expect(result.body.requestedCount).toBe(25);
  return result.body.jobId;
}

it(
  '1. creates a job over HTTP, completes 25 published questions and starts an attempt',
  async () => {
    const fixture = await createE2eFixture();
    // Blocking the first VERIFY keeps the job RUNNING while the overview is read.
    const fake = createFakeAi({ blockVerifyAtCall: 1 });
    const app = await boot(fake);

    const created = await request<CreateGenerationJobResponse>(
      app,
      'POST',
      jobsPath(fixture.subjectId),
    );
    const jobId = requireJobId(created);

    await fake.waitUntilBlocked();

    const during = await request<SubjectOverviewResponse>(
      app,
      'GET',
      overviewPath(fixture.subjectId),
    );
    expect(during.status).toBe(200);
    expect(during.body.generationJob).not.toBeNull();
    expect(during.body.generationJob?.jobId).toBe(jobId);
    expect(during.body.generationJob?.state).toBe('RUNNING');
    expect(during.body.generationJob?.requestedCount).toBe(25);
    expect(during.body.eligibleQuestionCount).toBe(0);

    fake.release();

    const completed = await waitForJobState(app, jobId, 'COMPLETED');
    expect(completed.acceptedCount).toBe(25);

    await waitForPublishedQuestions(jobId, 25);

    expectPublishedSet(await loadJobQuestions(jobId), 25);

    const after = await request<SubjectOverviewResponse>(
      app,
      'GET',
      overviewPath(fixture.subjectId),
    );
    expect(after.status).toBe(200);
    expect(after.body.eligibleQuestionCount).toBe(25);
    expect(after.body.questionsPerTest).toBe(25);
    expect(after.body.generationJob).toBeNull();

    const attempt = await request<CreateAttemptResponse>(
      app,
      'POST',
      attemptsPath(fixture.subjectId),
    );
    expect(attempt.status).toBe(201);
    expect(attempt.body.status).toBe('READY');
    expect(attempt.body.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  },
  300_000,
);

it(
  '2. concurrent creates return one 201 and 409 GENERATION_IN_PROGRESS for the rest',
  async () => {
    const fixture = await createE2eFixture();
    // The blocked DRAFT keeps the winning job active during the whole race.
    const fake = createFakeAi({ blockDraftAtCall: 1 });
    const app = await boot(fake);

    const pair = await Promise.all([
      request<CreateGenerationJobResponse | { code?: string }>(
        app,
        'POST',
        jobsPath(fixture.subjectId),
      ),
      request<CreateGenerationJobResponse | { code?: string }>(
        app,
        'POST',
        jobsPath(fixture.subjectId),
      ),
    ]);

    expect(pair.filter((result) => result.status === 201)).toHaveLength(1);
    const losing = pair.find((result) => result.status !== 201);
    if (losing === undefined) throw new Error('Both concurrent creates won.');
    expect(losing.status).toBe(409);
    expect((losing.body as { code?: string }).code).toBe(
      'GENERATION_IN_PROGRESS',
    );

    await fake.waitUntilBlocked();

    const ten = await Promise.all(
      Array.from({ length: 10 }, () =>
        request<CreateGenerationJobResponse | { code?: string }>(
          app,
          'POST',
          jobsPath(fixture.subjectId),
        ),
      ),
    );
    for (const result of ten) {
      expect(result.status, JSON.stringify(result.body)).toBe(409);
      expect((result.body as { code?: string }).code).toBe(
        'GENERATION_IN_PROGRESS',
      );
    }

    expect(
      await prisma.generationJob.count({ where: { subjectId: fixture.subjectId } }),
    ).toBe(1);

    const winner = pair.find(
      (result): result is ApiResult<CreateGenerationJobResponse> =>
        result.status === 201,
    );
    if (!winner) throw new Error('The concurrent create produced no job.');
    const jobId = requireJobId(winner);

    const cancelled = await request<{ jobId: string; state: string }>(
      app,
      'POST',
      cancelPath(jobId),
    );
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.state).toBe('CANCELLING');
    try {
      // The cancel poll aborts the blocked DRAFT; the runner then ends STOPPED.
      await waitForJobState(app, jobId, 'CANCELLED');
    } finally {
      fake.release();
    }
  },
  300_000,
);

it(
  '3. cancel during a blocked AI call ends CANCELLED with every question quarantined',
  async () => {
    const fixture = await createE2eFixture();
    // Two slots finish before the third VERIFY blocks, so real rows exist.
    const fake = createFakeAi({ blockVerifyAtCall: 3 });
    const app = await boot(fake);

    const created = await request<CreateGenerationJobResponse>(
      app,
      'POST',
      jobsPath(fixture.subjectId),
    );
    const jobId = requireJobId(created);

    await fake.waitUntilBlocked();
    expect(await prisma.mockQuestion.count({ where: { jobId } })).toBe(2);

    const before = await request<SubjectOverviewResponse>(
      app,
      'GET',
      overviewPath(fixture.subjectId),
    );
    expect(before.body.eligibleQuestionCount).toBe(0);

    const cancelling = await request<{ jobId: string; state: string }>(
      app,
      'POST',
      cancelPath(jobId),
    );
    expect(cancelling.status).toBe(200);
    expect(cancelling.body.state).toBe('CANCELLING');

    try {
      // The blocked VERIFY rejects on abort, so no further slot can be written.
      const cancelled = await waitForJobState(app, jobId, 'CANCELLED');
      expect(cancelled.acceptedCount).toBeGreaterThanOrEqual(2);
    } finally {
      fake.release();
    }

    const questions = await loadJobQuestions(jobId);
    expect(questions.length).toBeGreaterThanOrEqual(2);
    for (const question of questions) {
      expect(question.status).toBe('QUARANTINED');
    }
    expect(questions.some((question) => question.status === 'ACTIVE')).toBe(false);

    const after = await request<SubjectOverviewResponse>(
      app,
      'GET',
      overviewPath(fixture.subjectId),
    );
    expect(after.body.eligibleQuestionCount).toBe(0);
  },
  300_000,
);

it(
  '4. a killed worker leaves RUNNING and a new app recovers it to 25 questions',
  async () => {
    const fixture = await createE2eFixture();
    const fakeA = createFakeAi({ blockDraftAtCall: 1 });
    const appA = await boot(fakeA);

    const created = await request<CreateGenerationJobResponse>(
      appA,
      'POST',
      jobsPath(fixture.subjectId),
    );
    const jobId = requireJobId(created);

    await fakeA.waitUntilBlocked();
    await shutdown(appA);

    const killed = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(killed.state).toBe('RUNNING');
    expect(killed.recoveryCount).toBe(0);
    expect(await prisma.mockQuestion.count({ where: { jobId } })).toBe(0);

    const appB = await boot(createFakeAi());
    const completed = await waitForJobState(appB, jobId, 'COMPLETED');
    expect(completed.recoveryCount).toBe(1);
    expect(completed.acceptedCount).toBe(25);

    await waitForPublishedQuestions(jobId, 25);

    expectPublishedSet(await loadJobQuestions(jobId), 25);
    expect(
      await prisma.mockQuestion.count({ where: { jobId, status: 'QUARANTINED' } }),
    ).toBe(0);
  },
  300_000,
);

it(
  '5. the old recovery epoch is fenced off and changes nothing',
  async () => {
    const fixture = await createE2eFixture();
    const created = await repository.createJob({
      subjectId: fixture.subjectId,
      documentIds: [fixture.documentId],
    });
    const jobId = created.job.id;

    const claimed = await repository.claimNext();
    expect(claimed?.jobId).toBe(jobId);
    expect(claimed?.recoveryCount).toBe(0);

    await repository.markStalled(new Date(), 20, { includeFresh: true });
    const reclaimed = await repository.claimNext();
    expect(reclaimed?.jobId).toBe(jobId);
    expect(reclaimed?.recoveryCount).toBe(1);

    const oldFence = { jobId, state: 'RUNNING' as const, recoveryCount: 0 };
    await expect(repository.heartbeat(oldFence)).rejects.toMatchObject({
      code: 'GENERATION_STALE_WORKER',
    });
    await expect(
      repository.transition(oldFence, 'CANCELLING'),
    ).rejects.toMatchObject({ code: 'GENERATION_STALE_WORKER' });

    const unchanged = await prisma.generationJob.findUniqueOrThrow({
      where: { id: jobId },
    });
    expect(unchanged.state).toBe('RUNNING');
    expect(unchanged.recoveryCount).toBe(1);
    expect(unchanged.acceptedCount).toBe(0);
    expect(unchanged.finishedAt).toBeNull();

    await repository.transition(
      { jobId, state: 'RUNNING', recoveryCount: 1 },
      'CANCELLING',
    );
    await repository.transition(
      { jobId, state: 'CANCELLING', recoveryCount: 1 },
      'CANCELLED',
    );
  },
  120_000,
);

it(
  '6. the runtime starts recover, reconciler, worker and stops in reverse',
  async () => {
    const order: string[] = [];
    const runtime = createGenerationRuntime({
      components: {
        reconciler: {
          recoverOnBoot: async () => {
            order.push('recoverOnBoot');
            return { stalled: [], requeued: [], failed: [] };
          },
          start: () => {
            order.push('reconciler.start');
          },
          stop: () => {
            order.push('reconciler.stop');
          },
        },
        worker: {
          start: () => {
            order.push('worker.start');
          },
          stop: async () => {
            order.push('worker.stop');
          },
        },
      },
      enabled: true,
      underTest: false,
    });

    await runtime.bootstrap();
    await runtime.shutdown();

    expect(order).toEqual([
      'recoverOnBoot',
      'reconciler.start',
      'worker.start',
      'worker.stop',
      'reconciler.stop',
    ]);
  },
  30_000,
);

it(
  '7. with the flag off the routes are 404 and the worker never starts',
  async () => {
    const fixture = await createE2eFixture();
    const queued = await repository.createJob({
      subjectId: fixture.subjectId,
      documentIds: [fixture.documentId],
    });

    process.env.MOCK_TEST_ENABLED = 'false';
    let app: RunningE2eApp | null = null;
    try {
      app = await boot(createFakeAi());

      const created = await request<{ code?: string }>(
        app,
        'POST',
        jobsPath(fixture.subjectId),
      );
      expect(created.status).toBe(404);
      expect(created.body.code).toBeUndefined();

      const overview = await request<{ code?: string }>(
        app,
        'GET',
        overviewPath(fixture.subjectId),
      );
      expect(overview.status).toBe(404);

      // Longer than the worker idle poll: a started worker would have claimed it.
      await sleep(5_000);
      const row = await prisma.generationJob.findUniqueOrThrow({
        where: { id: queued.job.id },
      });
      expect(row.state).toBe('QUEUED');
      expect(row.startedAt).toBeNull();
      expect(row.planJson).toBeNull();
      expect(row.aiCallCount).toBe(0);
    } finally {
      if (app) await shutdown(app);
      process.env.MOCK_TEST_ENABLED = 'true';
    }
  },
  120_000,
);

it(
  '8. a failing provider leaves the job FAILED and its questions quarantined',
  async () => {
    const fixture = await createE2eFixture();
    // Three slots complete, then every later DRAFT call throws.
    const fake = createFakeAi({ failDraftFromCall: 4 });
    const app = await boot(fake);

    const before = await request<SubjectOverviewResponse>(
      app,
      'GET',
      overviewPath(fixture.subjectId),
    );
    expect(before.body.eligibleQuestionCount).toBe(0);

    const created = await request<CreateGenerationJobResponse>(
      app,
      'POST',
      jobsPath(fixture.subjectId),
    );
    const jobId = requireJobId(created);

    const failed = await waitForJobState(app, jobId, 'FAILED');
    expect(failed.failureReason).toBe('PROVIDER_UNAVAILABLE');

    const questions = await loadJobQuestions(jobId);
    expect(questions).toHaveLength(3);
    for (const question of questions) {
      expect(question.status).toBe('QUARANTINED');
    }

    const after = await request<SubjectOverviewResponse>(
      app,
      'GET',
      overviewPath(fixture.subjectId),
    );
    expect(after.body.eligibleQuestionCount).toBe(0);
    expect(after.body.generationJob).toBeNull();
  },
  300_000,
);

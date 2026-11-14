import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationError } from '../generation.errors.js';
import type { ClaimedGenerationJob } from '../generation-job.types.js';
import type { RunOutcome } from '../runner/ports.js';
import { createGenerationWorker } from './generation-worker.js';
import type {
  GenerationWorker,
  GenerationWorkerDeps,
  RunJobForWorker,
  TimerHandle,
} from './worker.types.js';

const SENTINEL = 'ZZ-m5-secret-text';

const JOB: ClaimedGenerationJob = {
  jobId: 'job-1',
  subjectId: 'subject-1',
  requestedCount: 25,
  acceptedCount: 0,
  recoveryCount: 3,
};

interface Harness {
  worker: GenerationWorker;
  repository: {
    claimNext: ReturnType<typeof vi.fn>;
    heartbeat: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };
  runJob: ReturnType<typeof vi.fn>;
  publish: ReturnType<typeof vi.fn>;
  readJobState: ReturnType<typeof vi.fn>;
  assertReady: ReturnType<typeof vi.fn>;
}

function makeHarness(overrides: Partial<GenerationWorkerDeps> = {}): Harness {
  const repository = {
    claimNext: vi.fn(async () => JOB),
    heartbeat: vi.fn(async () => undefined),
    transition: vi.fn(async () => ({})),
  };
  const runJob = vi.fn<RunJobForWorker>(async () => ({
    kind: 'COMPLETED',
    acceptedCount: 25,
  }));
  const publish = vi.fn(async () => 25);
  const readJobState = vi.fn(async () => 'RUNNING');
  const assertReady = vi.fn(() => undefined);

  const deps: GenerationWorkerDeps = {
    repository: repository as unknown as GenerationWorkerDeps['repository'],
    runJob,
    publishJobQuestions: publish,
    readJobState: readJobState as unknown as GenerationWorkerDeps['readJobState'],
    assertReady,
    ...overrides,
  };

  return {
    worker: createGenerationWorker(deps),
    repository,
    runJob,
    publish,
    readJobState,
    assertReady,
  };
}

function abortOutcome(): RunJobForWorker {
  return (_job, signal) =>
    new Promise<RunOutcome>((resolve) => {
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
}

function processed(result: Awaited<ReturnType<GenerationWorker['runOnce']>>) {
  if (result.kind !== 'PROCESSED') {
    throw new Error(`expected PROCESSED, got ${result.kind}`);
  }
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('generation worker', () => {
  it('heartbeats every 30 seconds and stops timers when the job ends', async () => {
    let finish!: (outcome: RunOutcome) => void;
    const harness = makeHarness({
      runJob: (_job, _signal) =>
        new Promise<RunOutcome>((resolve) => {
          finish = resolve;
        }),
    });

    const processing = harness.worker.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.repository.heartbeat).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.repository.heartbeat).toHaveBeenCalledTimes(2);

    finish({ kind: 'COMPLETED', acceptedCount: 25 });
    const result = processed(await processing);

    expect(result.result.status).toBe('APPLIED');
    expect(harness.repository.transition).toHaveBeenCalledWith(
      { jobId: 'job-1', state: 'RUNNING', recoveryCount: 3 },
      'COMPLETED',
    );
    expect(harness.publish).toHaveBeenCalledWith('job-1');
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.repository.heartbeat).toHaveBeenCalledTimes(2);
  });

  it('aborts with STALE_WORKER on a stale heartbeat and applies nothing', async () => {
    const harness = makeHarness({ runJob: abortOutcome() });
    harness.repository.heartbeat.mockRejectedValue(
      new GenerationError('GENERATION_STALE_WORKER'),
    );

    const processing = harness.worker.runOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    const result = processed(await processing);

    expect(result.result.outcome).toEqual({
      kind: 'STOPPED',
      cause: 'STALE_WORKER',
    });
    expect(result.result.status).toBe('NOOP');
    expect(harness.repository.transition).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts with CANCEL when the job becomes CANCELLING', async () => {
    const harness = makeHarness({
      runJob: abortOutcome(),
      readJobState: (async () => 'CANCELLING') as GenerationWorkerDeps['readJobState'],
      config: { cancelPollMs: 10 },
    });

    const processing = harness.worker.runOnce();
    await vi.advanceTimersByTimeAsync(10);
    const result = processed(await processing);

    expect(result.result.outcome).toEqual({ kind: 'STOPPED', cause: 'CANCEL' });
    expect(result.result.status).toBe('APPLIED');
    expect(harness.repository.transition).toHaveBeenCalledWith(
      { jobId: 'job-1', state: 'CANCELLING', recoveryCount: 3 },
      'CANCELLED',
    );
    expect(harness.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts with DEADLINE and fails the job as TIMEOUT', async () => {
    const harness = makeHarness({
      runJob: abortOutcome(),
      config: { deadlineMs: 10_000, heartbeatMs: 60_000, cancelPollMs: 60_000 },
    });

    const processing = harness.worker.runOnce();
    await vi.advanceTimersByTimeAsync(10_000);
    const result = processed(await processing);

    expect(result.result.outcome).toEqual({ kind: 'STOPPED', cause: 'DEADLINE' });
    expect(result.result.status).toBe('APPLIED');
    expect(harness.repository.transition).toHaveBeenCalledWith(
      { jobId: 'job-1', state: 'RUNNING', recoveryCount: 3 },
      'FAILED',
      { failureReason: 'TIMEOUT' },
    );
    expect(harness.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stop aborts with SHUTDOWN and leaves the job RUNNING', async () => {
    const harness = makeHarness({ runJob: abortOutcome() });

    const processing = harness.worker.runOnce();
    await vi.advanceTimersByTimeAsync(0);
    const stopping = harness.worker.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopping;
    const result = processed(await processing);

    expect(result.result.outcome).toEqual({
      kind: 'STOPPED',
      cause: 'SHUTDOWN',
    });
    expect(result.result.status).toBe('NOOP');
    expect(harness.repository.transition).not.toHaveBeenCalled();
    expect(harness.publish).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears all timers and fails INTERNAL when runJob throws', async () => {
    const harness = makeHarness({
      runJob: async () => {
        throw new Error(SENTINEL);
      },
    });

    const result = processed(await harness.worker.runOnce());

    expect(result.result.outcome).toEqual({
      kind: 'UNEXPECTED',
      errorName: 'Error',
    });
    expect(result.result.status).toBe('APPLIED');
    expect(harness.repository.transition).toHaveBeenCalledWith(
      { jobId: 'job-1', state: 'RUNNING', recoveryCount: 3 },
      'FAILED',
      { failureReason: 'INTERNAL' },
    );
    expect(JSON.stringify(result.result)).not.toContain(SENTINEL);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails the job when assertReady throws and never calls runJob', async () => {
    const harness = makeHarness({
      assertReady: () => {
        throw new GenerationError('GENERATION_VERIFIER_NOT_CONFIGURED');
      },
    });

    const result = processed(await harness.worker.runOnce());

    expect(harness.runJob).not.toHaveBeenCalled();
    expect(result.result.outcome).toEqual({
      kind: 'UNEXPECTED',
      errorName: 'GenerationError',
      code: 'GENERATION_VERIFIER_NOT_CONFIGURED',
    });
    expect(harness.repository.transition).toHaveBeenCalledWith(
      { jobId: 'job-1', state: 'RUNNING', recoveryCount: 3 },
      'FAILED',
      { failureReason: 'INTERNAL' },
    );
  });

  it('reports a publish failure and leaves the job COMPLETED', async () => {
    const harness = makeHarness({
      publishJobQuestions: async () => {
        throw new GenerationError('GENERATION_INVALID_TRANSITION');
      },
    });

    const result = processed(await harness.worker.runOnce());

    expect(result.result.status).toBe('PUBLISH_FAILED');
    expect(result.result.publishError).toEqual({
      name: 'GenerationError',
      code: 'GENERATION_INVALID_TRANSITION',
    });
    expect(harness.repository.transition).toHaveBeenCalledTimes(1);
    expect(harness.repository.transition).toHaveBeenCalledWith(
      { jobId: 'job-1', state: 'RUNNING', recoveryCount: 3 },
      'COMPLETED',
    );
  });

  it('swallows a stale fenced transition and does not publish', async () => {
    const harness = makeHarness();
    harness.repository.transition.mockRejectedValue(
      new GenerationError('GENERATION_STALE_WORKER'),
    );

    const result = processed(await harness.worker.runOnce());

    expect(result.result.status).toBe('STALE');
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('returns IDLE when there is no QUEUED job', async () => {
    const harness = makeHarness();
    harness.repository.claimNext.mockResolvedValue(null);

    await expect(harness.worker.runOnce()).resolves.toEqual({ kind: 'IDLE' });
  });

  it('starts the loop only once and clears it on stop', async () => {
    const harness = makeHarness();
    harness.repository.claimNext.mockResolvedValue(null);
    const setIntervalFn = vi.fn((callback: () => void, ms: number) =>
      setInterval(callback, ms),
    );
    const clearIntervalFn = vi.fn((handle: TimerHandle) =>
      clearInterval(handle),
    );
    const deps = {
      timers: { setInterval: setIntervalFn, clearInterval: clearIntervalFn },
    } as Partial<GenerationWorkerDeps>;
    const worker = createGenerationWorker({
      repository: harness.repository as unknown as GenerationWorkerDeps['repository'],
      runJob: harness.runJob as unknown as GenerationWorkerDeps['runJob'],
      publishJobQuestions: harness.publish as unknown as GenerationWorkerDeps['publishJobQuestions'],
      readJobState: harness.readJobState as unknown as GenerationWorkerDeps['readJobState'],
      assertReady: harness.assertReady as unknown as GenerationWorkerDeps['assertReady'],
      ...deps,
    });

    worker.start();
    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(setIntervalFn).toHaveBeenCalledTimes(1);

    await worker.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

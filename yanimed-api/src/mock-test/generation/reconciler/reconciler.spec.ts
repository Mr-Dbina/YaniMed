import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GenerationError } from '../generation.errors.js';
import type {
  GenerationJobSnapshot,
  StalledGenerationJob,
} from '../generation-job.types.js';
import { createReconciler } from './reconciler.js';
import type {
  ReconcileSummary,
  ReconcilerConfig,
  ReconcilerDeps,
  ReconcilerLogger,
  ReconcilerRepository,
  ReconcilerTimerHandle,
} from './reconciler.types.js';

function snapshot(): GenerationJobSnapshot {
  return {} as GenerationJobSnapshot;
}

function emptySummary(): ReconcileSummary {
  return { stalled: [], requeued: [], failed: [], cancelled: [] };
}

interface Harness {
  reconciler: ReturnType<typeof createReconciler>;
  repository: {
    markStalled: ReturnType<typeof vi.fn>;
    listStalled: ReturnType<typeof vi.fn>;
    listOrphanedCancels: ReturnType<typeof vi.fn>;
    transition: ReturnType<typeof vi.fn>;
  };
  logger: {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(
  config: Partial<ReconcilerConfig> = {},
  overrides: Partial<ReconcilerDeps> = {},
): Harness {
  const repository = {
    markStalled: vi.fn(async () => [] as StalledGenerationJob[]),
    listStalled: vi.fn(async () => [] as StalledGenerationJob[]),
    listOrphanedCancels: vi.fn(async () => [] as StalledGenerationJob[]),
    transition: vi.fn(async () => snapshot()),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const reconciler = createReconciler({
    repository: repository as unknown as ReconcilerRepository,
    logger: logger as unknown as ReconcilerLogger,
    config,
    ...overrides,
  });

  return { reconciler, repository, logger };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('generation reconciler', () => {
  it('stalls every RUNNING job at boot and requeues below the cap', async () => {
    const harness = makeHarness();
    harness.repository.markStalled
      .mockResolvedValueOnce([
        { jobId: 'job-a', recoveryCount: 0, acceptedCount: 0 },
        { jobId: 'job-b', recoveryCount: 2, acceptedCount: 0 },
      ])
      .mockResolvedValueOnce([]);

    const summary = await harness.reconciler.recoverOnBoot();

    expect(summary).toEqual({
      stalled: ['job-a', 'job-b'],
      requeued: ['job-a', 'job-b'],
      failed: [],
      cancelled: [],
    });
    expect(harness.repository.markStalled).toHaveBeenNthCalledWith(
      1,
      expect.any(Date),
      20,
      { stalledAfterMs: 120_000, includeFresh: true },
    );
    expect(harness.repository.transition).not.toHaveBeenCalled();
  });

  it('only stalls stale RUNNING jobs on a sweep', async () => {
    const harness = makeHarness({ maxRecoveries: 3 });

    await expect(harness.reconciler.sweep()).resolves.toEqual(emptySummary());
    expect(harness.repository.markStalled).toHaveBeenCalledWith(
      expect.any(Date),
      20,
      { stalledAfterMs: 120_000, includeFresh: false },
    );
  });

  it('requeues recovery counts 0, 1 and 2 and fails count 3 as INTERNAL', async () => {
    const harness = makeHarness();
    harness.repository.listStalled.mockResolvedValueOnce([
      { jobId: 'job-a', recoveryCount: 0, acceptedCount: 0 },
      { jobId: 'job-b', recoveryCount: 1, acceptedCount: 0 },
      { jobId: 'job-c', recoveryCount: 2, acceptedCount: 0 },
      { jobId: 'job-d', recoveryCount: 3, acceptedCount: 0 },
    ]);

    const summary = await harness.reconciler.sweep();

    expect(summary.requeued).toEqual(['job-a', 'job-b', 'job-c']);
    expect(summary.failed).toEqual(['job-d']);
    expect(harness.repository.transition).toHaveBeenCalledTimes(1);
    expect(harness.repository.transition).toHaveBeenCalledWith(
      { jobId: 'job-d', state: 'STALLED', recoveryCount: 3 },
      'FAILED',
      { failureReason: 'INTERNAL' },
    );
  });

  it('requeues a partial STALLED job at the cap instead of failing it', async () => {
    const harness = makeHarness();
    harness.repository.listStalled.mockResolvedValueOnce([
      { jobId: 'job-e', recoveryCount: 5, acceptedCount: 12 },
    ]);

    const summary = await harness.reconciler.sweep();

    expect(summary.requeued).toEqual(['job-e']);
    expect(summary.failed).toEqual([]);
    expect(harness.repository.transition).not.toHaveBeenCalled();
  });

  it('swallows a lost race on a fenced failure', async () => {
    const harness = makeHarness();
    harness.repository.listStalled.mockResolvedValueOnce([
      { jobId: 'job-a', recoveryCount: 3 },
    ]);
    harness.repository.transition.mockRejectedValueOnce(
      new GenerationError('GENERATION_STALE_WORKER'),
    );

    await expect(harness.reconciler.sweep()).resolves.toEqual(emptySummary());
    expect(harness.logger.error).not.toHaveBeenCalled();
  });

  it('keeps going when one failure write throws', async () => {
    const harness = makeHarness();
    harness.repository.listStalled.mockResolvedValueOnce([
      { jobId: 'job-a', recoveryCount: 3 },
      { jobId: 'job-b', recoveryCount: 4 },
    ]);
    harness.repository.transition
      .mockRejectedValueOnce(new Error('ZZ-m5-secret-text'))
      .mockResolvedValueOnce(snapshot());

    const summary = await harness.reconciler.sweep();

    expect(summary.failed).toEqual(['job-b']);
    expect(harness.repository.transition).toHaveBeenCalledTimes(2);
    expect(harness.logger.error).toHaveBeenCalledWith(
      'generation.reconciler.fail_failed',
      { jobId: 'job-a', name: 'Error' },
    );
  });

  it('runs one sweep at a time', async () => {
    const harness = makeHarness();
    let release!: (rows: StalledGenerationJob[]) => void;
    harness.repository.markStalled.mockImplementationOnce(
      () =>
        new Promise<StalledGenerationJob[]>((resolve) => {
          release = resolve;
        }),
    );

    const first = harness.reconciler.sweep();
    const second = harness.reconciler.sweep();

    expect(second).toBe(first);
    expect(harness.repository.markStalled).toHaveBeenCalledTimes(1);

    release([]);
    await first;

    expect(harness.repository.listStalled).toHaveBeenCalledTimes(1);
  });

  it('processes more than one batch of stalled jobs', async () => {
    const harness = makeHarness({ batchSize: 2 });
    harness.repository.markStalled
      .mockResolvedValueOnce([
        { jobId: 'job-a', recoveryCount: 0, acceptedCount: 0 },
        { jobId: 'job-b', recoveryCount: 0, acceptedCount: 0 },
      ])
      .mockResolvedValueOnce([]);

    const summary = await harness.reconciler.sweep();

    expect(summary.stalled).toEqual(['job-a', 'job-b']);
    expect(harness.repository.markStalled).toHaveBeenCalledTimes(2);
  });

  it('finishes orphaned CANCELLING rows through a fenced transition', async () => {
    const harness = makeHarness();
    harness.repository.listOrphanedCancels.mockResolvedValueOnce([
      { jobId: 'job-a', recoveryCount: 0, acceptedCount: 0 },
      { jobId: 'job-b', recoveryCount: 2, acceptedCount: 0 },
    ]);

    const summary = await harness.reconciler.sweep();

    expect(summary.cancelled).toEqual(['job-a', 'job-b']);
    expect(harness.repository.listOrphanedCancels).toHaveBeenCalledWith(
      expect.any(Date),
      20,
      { stalledAfterMs: 120_000, includeFresh: false },
    );
    expect(harness.repository.transition).toHaveBeenCalledTimes(2);
    expect(harness.repository.transition).toHaveBeenCalledWith(
      { jobId: 'job-a', state: 'CANCELLING', recoveryCount: 0 },
      'CANCELLED',
    );
    expect(harness.logger.info).toHaveBeenCalledWith(
      'generation.reconciler.orphan_cancelled',
      { jobId: 'job-a' },
    );
  });

  it('treats every CANCELLING row as orphaned at boot', async () => {
    const harness = makeHarness();
    harness.repository.listOrphanedCancels.mockResolvedValueOnce([
      { jobId: 'job-a', recoveryCount: 1, acceptedCount: 0 },
    ]);

    const summary = await harness.reconciler.recoverOnBoot();

    expect(summary.cancelled).toEqual(['job-a']);
    expect(harness.repository.listOrphanedCancels).toHaveBeenCalledWith(
      expect.any(Date),
      20,
      { stalledAfterMs: 120_000, includeFresh: true },
    );
  });

  it('swallows a lost race on an orphan cancel', async () => {
    const harness = makeHarness();
    harness.repository.listOrphanedCancels.mockResolvedValueOnce([
      { jobId: 'job-a', recoveryCount: 0, acceptedCount: 0 },
    ]);
    harness.repository.transition.mockRejectedValueOnce(
      new GenerationError('GENERATION_STALE_WORKER'),
    );

    const summary = await harness.reconciler.sweep();

    expect(summary.cancelled).toEqual([]);
    expect(harness.logger.error).not.toHaveBeenCalled();
  });

  it('keeps going when an orphan cancel write throws', async () => {
    const harness = makeHarness();
    harness.repository.listOrphanedCancels.mockResolvedValueOnce([
      { jobId: 'job-a', recoveryCount: 0, acceptedCount: 0 },
      { jobId: 'job-b', recoveryCount: 0, acceptedCount: 0 },
    ]);
    harness.repository.transition
      .mockRejectedValueOnce(new Error('ZZ-m5-secret-text'))
      .mockResolvedValueOnce(snapshot());

    const summary = await harness.reconciler.sweep();

    expect(summary.cancelled).toEqual(['job-b']);
    expect(harness.logger.error).toHaveBeenCalledWith(
      'generation.reconciler.cancel_failed',
      { jobId: 'job-a', name: 'Error' },
    );
  });

  it('starts once, sweeps on the interval and clears the timer on stop', async () => {
    const setIntervalFn = vi.fn(
      (callback: () => void, ms: number) => setInterval(callback, ms),
    );
    const clearIntervalFn = vi.fn((handle: ReconcilerTimerHandle) =>
      clearInterval(handle),
    );
    const harness = makeHarness(
      {},
      {
        timers: {
          setInterval: setIntervalFn,
          clearInterval: clearIntervalFn,
        },
      },
    );

    harness.reconciler.start();
    harness.reconciler.start();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.repository.markStalled).toHaveBeenCalledTimes(1);

    harness.reconciler.stop();
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.repository.markStalled).toHaveBeenCalledTimes(1);
  });

  it('stop without start is a no-op', () => {
    const harness = makeHarness();

    expect(() => harness.reconciler.stop()).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
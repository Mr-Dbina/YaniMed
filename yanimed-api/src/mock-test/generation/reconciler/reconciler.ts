import type {
  GenerationJobFence,
  StalledGenerationJob,
} from '../generation-job.types.js';
import {
  DEFAULT_RECONCILER_CONFIG,
  type ReconcileSummary,
  type Reconciler,
  type ReconcilerDeps,
  type ReconcilerLogger,
  type ReconcilerTimerHandle,
  type ReconcilerTimers,
} from './reconciler.types.js';

const SILENT_LOGGER: ReconcilerLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

const DEFAULT_TIMERS: ReconcilerTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle),
};

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function errorNameOf(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return 'UnknownError';
}

function emptySummary(): ReconcileSummary {
  return { stalled: [], requeued: [], failed: [] };
}

/**
 * Returns stalled jobs to the single claim path. A job below the recovery cap
 * stays STALLED, so the next claimNext advances its epoch and runs it again;
 * a job at the cap is failed. Every write is fenced, and a lost race is
 * treated as "another run already handled it".
 */
export function createReconciler(deps: ReconcilerDeps): Reconciler {
  const config = { ...DEFAULT_RECONCILER_CONFIG, ...deps.config };
  const timers = deps.timers ?? DEFAULT_TIMERS;
  const clock = deps.clock ?? (() => Date.now());
  const logger = deps.logger ?? SILENT_LOGGER;

  let started = false;
  let handle: ReconcilerTimerHandle | null = null;
  let inFlight: Promise<ReconcileSummary> | null = null;

  const recover = async (
    rows: readonly StalledGenerationJob[],
    summary: ReconcileSummary,
    recovered: Set<string>,
  ): Promise<void> => {
    for (const row of rows) {
      if (recovered.has(row.jobId)) continue;
      recovered.add(row.jobId);

      if (row.recoveryCount < config.maxRecoveries) {
        // claimNext claims it and advances recoveryCount.
        summary.requeued.push(row.jobId);
        continue;
      }

      const fence: GenerationJobFence = {
        jobId: row.jobId,
        state: 'STALLED',
        recoveryCount: row.recoveryCount,
      };
      try {
        await deps.repository.transition(fence, 'FAILED', {
          failureReason: 'INTERNAL',
        });
        summary.failed.push(row.jobId);
      } catch (error) {
        const code = errorCodeOf(error);
        if (code === 'GENERATION_STALE_WORKER') continue;
        logger.error('generation.reconciler.fail_failed', {
          jobId: row.jobId,
          name: errorNameOf(error),
          ...(code === undefined ? {} : { code }),
        });
      }
    }
  };

  const stall = async (
    includeFresh: boolean,
    summary: ReconcileSummary,
    recovered: Set<string>,
  ): Promise<void> => {
    const now = new Date(clock());
    const seen = new Set<string>();

    for (;;) {
      const rows = await deps.repository.markStalled(now, config.batchSize, {
        stalledAfterMs: config.stalledAfterMs,
        includeFresh,
      });
      const fresh = rows.filter((row) => !seen.has(row.jobId));
      if (fresh.length === 0) return;
      for (const row of fresh) {
        seen.add(row.jobId);
        summary.stalled.push(row.jobId);
      }
      await recover(fresh, summary, recovered);
      if (rows.length < config.batchSize) return;
    }
  };

  const recoverStalled = async (
    summary: ReconcileSummary,
    recovered: Set<string>,
  ): Promise<void> => {
    for (;;) {
      const rows = await deps.repository.listStalled(config.batchSize);
      const fresh = rows.filter((row) => !recovered.has(row.jobId));
      if (fresh.length === 0) return;
      await recover(fresh, summary, recovered);
      if (rows.length < config.batchSize) return;
    }
  };

  const run = async (includeFresh: boolean): Promise<ReconcileSummary> => {
    const summary = emptySummary();
    const recovered = new Set<string>();

    await stall(includeFresh, summary, recovered);
    await recoverStalled(summary, recovered);

    logger.info('generation.reconciler.swept', {
      stalled: summary.stalled.length,
      requeued: summary.requeued.length,
      failed: summary.failed.length,
    });
    return summary;
  };

  const guard = (
    work: () => Promise<ReconcileSummary>,
  ): Promise<ReconcileSummary> => {
    if (inFlight !== null) return inFlight;
    const promise = work().finally(() => {
      inFlight = null;
    });
    inFlight = promise;
    return promise;
  };

  const recoverOnBoot = (): Promise<ReconcileSummary> =>
    guard(() => run(true));
  const sweep = (): Promise<ReconcileSummary> => guard(() => run(false));

  const start = (): void => {
    if (started) return;
    started = true;
    handle = timers.setInterval(() => {
      void sweep().catch((error: unknown) => {
        logger.error('generation.reconciler.sweep_failed', {
          name: errorNameOf(error),
        });
      });
    }, config.sweepMs);
  };

  const stop = (): void => {
    started = false;
    if (handle === null) return;
    timers.clearInterval(handle);
    handle = null;
  };

  return { recoverOnBoot, sweep, start, stop };
}
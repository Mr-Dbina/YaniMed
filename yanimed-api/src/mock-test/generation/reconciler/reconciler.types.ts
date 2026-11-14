import { MAX_RECOVERIES, STALL_AFTER_MS } from '../generation.constants.js';
import type { StalledGenerationJob } from '../generation-job.types.js';
import type { GenerationJobRepository } from '../generation-job.repository.js';

export const DEFAULT_RECONCILER_CONFIG = {
  sweepMs: 30_000,
  stalledAfterMs: STALL_AFTER_MS,
  maxRecoveries: MAX_RECOVERIES,
  batchSize: 20,
} satisfies ReconcilerConfig;

export interface ReconcilerConfig {
  /** Interval between sweeps once start() is called. */
  sweepMs: number;
  /** A RUNNING job without a heartbeat for this long is stalled. */
  stalledAfterMs: number;
  /** At this many recovery claims a STALLED job fails. */
  maxRecoveries: number;
  /** Rows per query, so one sweep never scans the whole table. */
  batchSize: number;
}

/** Only the repository methods the reconciler owns. */
export type ReconcilerRepository = Pick<
  GenerationJobRepository,
  'markStalled' | 'listStalled' | 'transition'
>;

export type ReconcilerClock = () => number;
export type ReconcilerTimerHandle = ReturnType<typeof setInterval>;

export interface ReconcilerTimers {
  setInterval(callback: () => void, ms: number): ReconcilerTimerHandle;
  clearInterval(handle: ReconcilerTimerHandle): void;
}

/** Fields are ids, codes and names only; never text. */
export type ReconcilerLogFields = Record<string, string | number | undefined>;

export interface ReconcilerLogger {
  info(event: string, fields?: ReconcilerLogFields): void;
  warn(event: string, fields?: ReconcilerLogFields): void;
  error(event: string, fields?: ReconcilerLogFields): void;
}

/** Job ids only. */
export interface ReconcileSummary {
  stalled: string[];
  requeued: string[];
  failed: string[];
}

export interface ReconcilerDeps {
  repository: ReconcilerRepository;
  clock?: ReconcilerClock;
  timers?: ReconcilerTimers;
  config?: Partial<ReconcilerConfig>;
  logger?: ReconcilerLogger;
}

export interface Reconciler {
  /** Stalls every RUNNING job immediately; call once before the worker. */
  recoverOnBoot(): Promise<ReconcileSummary>;
  /** Stalls stale RUNNING jobs and applies the recovery rule. */
  sweep(): Promise<ReconcileSummary>;
  start(): void;
  stop(): void;
}

export type { StalledGenerationJob };
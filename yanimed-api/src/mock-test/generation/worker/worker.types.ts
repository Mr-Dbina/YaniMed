import {
  HEARTBEAT_INTERVAL_MS,
  JOB_TIMEOUT_MS,
} from '../generation.constants.js';
import type { ClaimedGenerationJob, GenerationJobState } from '../generation-job.types.js';
import type { GenerationJobRepository } from '../generation-job.repository.js';
import type { RunOutcome } from '../runner/ports.js';
import type { OutcomeAction } from './outcome.js';

export const DEFAULT_WORKER_CONFIG = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  cancelPollMs: 2_000,
  deadlineMs: JOB_TIMEOUT_MS,
  idlePollMs: 2_000,
} satisfies WorkerConfig;

export interface WorkerConfig {
  heartbeatMs: number;
  cancelPollMs: number;
  deadlineMs: number;
  idlePollMs: number;
}

/** Only the repository methods the worker owns. */
export type WorkerRepository = Pick<
  GenerationJobRepository,
  'claimNext' | 'heartbeat' | 'transition'
>;

/**
 * Step 13 wires this factory to the adapters, the AI gateway and assertReady.
 * The worker treats it as a black box that either returns an outcome or throws.
 */
export type RunJobForWorker = (
  job: ClaimedGenerationJob,
  signal: AbortSignal,
) => Promise<RunOutcome>;

/**
 * The repository has no state read, so cancellation needs this injected seam.
 * It returns null when the job disappeared.
 */
export type ReadJobState = (
  jobId: string,
) => Promise<GenerationJobState | null>;

export type PublishJobQuestions = (jobId: string) => Promise<number>;

export type TimerHandle = ReturnType<typeof setInterval>;

/** Injectable so unit tests can use fake timers. */
export interface WorkerTimers {
  setInterval(callback: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export type WorkerClock = () => number;

/** Fields are ids, codes and names only; never text. */
export type WorkerLogFields = Record<string, string | number | undefined>;

export interface WorkerLogger {
  info(event: string, fields?: WorkerLogFields): void;
  warn(event: string, fields?: WorkerLogFields): void;
  error(event: string, fields?: WorkerLogFields): void;
}

export type WorkerOutcome =
  | RunOutcome
  | { kind: 'UNEXPECTED'; errorName: string; code?: string };

export type ApplyStatus =
  | 'APPLIED'
  | 'STALE'
  | 'NOOP'
  | 'PUBLISH_FAILED'
  | 'TRANSITION_FAILED';

export interface SafeError {
  name: string;
  code?: string;
}

export interface WorkerJobResult {
  jobId: string;
  outcome: WorkerOutcome;
  action: OutcomeAction;
  status: ApplyStatus;
  publishError?: SafeError;
  transitionError?: SafeError;
}

export type RunOnceResult =
  | { kind: 'IDLE' }
  | { kind: 'BUSY' }
  | { kind: 'PROCESSED'; jobId: string; result: WorkerJobResult };

export interface GenerationWorkerDeps {
  repository: WorkerRepository;
  runJob: RunJobForWorker;
  publishJobQuestions: PublishJobQuestions;
  readJobState: ReadJobState;
  /** GenerationAiService.assertReady; failures fail the job. */
  assertReady: () => void;
  clock?: WorkerClock;
  timers?: WorkerTimers;
  config?: Partial<WorkerConfig>;
  logger?: WorkerLogger;
}

export interface GenerationWorker {
  /** No-op when already running. */
  start(): void;
  /** Aborts the active job with SHUTDOWN and waits for it to unwind. */
  stop(): Promise<void>;
  /** Claims and processes at most one job; used by tests and the loop. */
  runOnce(): Promise<RunOnceResult>;
}

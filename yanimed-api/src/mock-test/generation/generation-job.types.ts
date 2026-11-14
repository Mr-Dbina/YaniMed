/** Plain TypeScript mirror of the Prisma GenerationJobState enum. */
export type GenerationJobState =
  | 'QUEUED'
  | 'RUNNING'
  | 'STALLED'
  | 'CANCELLING'
  | 'CANCELLED'
  | 'COMPLETED'
  | 'FAILED';

export type GenerationFailureReason =
  | 'INSUFFICIENT_CONTENT'
  | 'PROVIDER_UNAVAILABLE'
  | 'BUDGET_EXHAUSTED'
  | 'VALIDATION_EXHAUSTED'
  | 'SOURCE_CHANGED'
  | 'TIMEOUT'
  | 'INTERNAL';

const TRANSITIONS: Record<
  GenerationJobState,
  readonly GenerationJobState[]
> = {
  QUEUED: ['RUNNING', 'CANCELLING'],
  RUNNING: ['COMPLETED', 'STALLED', 'CANCELLING', 'FAILED'],
  STALLED: ['RUNNING', 'FAILED', 'CANCELLING'],
  CANCELLING: ['CANCELLED'],
  CANCELLED: [],
  COMPLETED: [],
  FAILED: [],
};

export const TERMINAL_GENERATION_JOB_STATES: readonly GenerationJobState[] = [
  'CANCELLED',
  'COMPLETED',
  'FAILED',
];

export function canTransitionGenerationJob(
  from: GenerationJobState,
  to: GenerationJobState,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface GenerationJobSnapshot {
  id: string;
  subjectId: string;
  state: GenerationJobState;
  requestedCount: number;
  acceptedCount: number;
  planJson: unknown;
  heartbeatAt: Date | null;
  recoveryCount: number;
  aiCallCount: number;
  failureReason: string | null;
  idempotencyKey: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface ClaimedGenerationJob {
  jobId: string;
  subjectId: string;
  requestedCount: number;
  acceptedCount: number;
  recoveryCount: number;
}

/**
 * A STALLED row offered for recovery. recoveryCount is still the stalled
 * epoch; the recovery claim advances it before the job runs again.
 */
export interface StalledGenerationJob {
  jobId: string;
  recoveryCount: number;
}

/**
 * Every write after claim includes state and recoveryCount. recoveryCount is
 * the epoch: a recovered worker keeps the old value and can no longer write.
 */
export interface GenerationJobFence {
  jobId: string;
  state: GenerationJobState;
  recoveryCount: number;
}

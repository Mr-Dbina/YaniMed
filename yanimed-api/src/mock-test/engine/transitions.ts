import type { AttemptStatus } from './types.js';

const ALLOWED: Record<AttemptStatus, readonly AttemptStatus[]> = {
  GENERATING: ['READY', 'FAILED', 'CANCELLED', 'ABANDONED'],
  READY: ['IN_PROGRESS', 'ABANDONED'],
  IN_PROGRESS: ['AWAITING_SUBMISSION', 'ABANDONED'],
  AWAITING_SUBMISSION: ['COMPLETED', 'ABANDONED'],
  FAILED: ['ABANDONED'],
  CANCELLED: ['ABANDONED'],
  COMPLETED: [],
  ABANDONED: [],
};

export function canTransition(
  from: AttemptStatus,
  to: AttemptStatus,
): boolean {
  return ALLOWED[from].includes(to);
}

/** Matches the DB partial unique index for unfinished attempts. */
export function isUnfinished(status: AttemptStatus): boolean {
  return (
    status === 'GENERATING' ||
    status === 'READY' ||
    status === 'IN_PROGRESS' ||
    status === 'AWAITING_SUBMISSION'
  );
}

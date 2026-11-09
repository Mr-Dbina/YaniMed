import { describe, expect, it } from 'vitest';
import { canTransition, isUnfinished } from './transitions.js';
import type { AttemptStatus } from './types.js';

const STATUSES: AttemptStatus[] = [
  'GENERATING',
  'READY',
  'IN_PROGRESS',
  'AWAITING_SUBMISSION',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'ABANDONED',
];

// Independent copy of the allowed table, used to check every 8x8 pair.
const ALLOWED: Record<AttemptStatus, AttemptStatus[]> = {
  GENERATING: ['READY', 'FAILED', 'CANCELLED', 'ABANDONED'],
  READY: ['IN_PROGRESS', 'ABANDONED'],
  IN_PROGRESS: ['AWAITING_SUBMISSION', 'ABANDONED'],
  AWAITING_SUBMISSION: ['COMPLETED', 'ABANDONED'],
  FAILED: ['ABANDONED'],
  CANCELLED: ['ABANDONED'],
  COMPLETED: [],
  ABANDONED: [],
};

const PAIRS = STATUSES.flatMap((from) =>
  STATUSES.map((to) => [from, to] as const),
);

describe('canTransition', () => {
  it.each(PAIRS)('matches the allowed table for %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED[from].includes(to));
  });

  it('allows no transition out of a terminal state', () => {
    for (const terminal of ['COMPLETED', 'ABANDONED'] as AttemptStatus[]) {
      for (const to of STATUSES) {
        expect(canTransition(terminal, to)).toBe(false);
      }
    }
  });
});

describe('isUnfinished', () => {
  it.each(STATUSES)('classifies %s', (status) => {
    expect(isUnfinished(status)).toBe(
      ['GENERATING', 'READY', 'IN_PROGRESS', 'AWAITING_SUBMISSION'].includes(
        status,
      ),
    );
  });

  it('matches exactly the four partial-index statuses', () => {
    expect(STATUSES.filter(isUnfinished)).toEqual([
      'GENERATING',
      'READY',
      'IN_PROGRESS',
      'AWAITING_SUBMISSION',
    ]);
  });
});

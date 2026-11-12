import { describe, expect, it } from 'vitest';
import {
  canTransitionGenerationJob,
  TERMINAL_GENERATION_JOB_STATES,
  type GenerationJobState,
} from './generation-job.types.js';

const ALL: GenerationJobState[] = [
  'QUEUED',
  'RUNNING',
  'STALLED',
  'CANCELLING',
  'CANCELLED',
  'COMPLETED',
  'FAILED',
];

describe('canTransitionGenerationJob', () => {
  it('allows the approved transitions', () => {
    const allowed: Array<[GenerationJobState, GenerationJobState]> = [
      ['QUEUED', 'RUNNING'],
      ['QUEUED', 'CANCELLING'],
      ['RUNNING', 'COMPLETED'],
      ['RUNNING', 'STALLED'],
      ['RUNNING', 'CANCELLING'],
      ['RUNNING', 'FAILED'],
      ['STALLED', 'RUNNING'],
      ['STALLED', 'FAILED'],
      ['STALLED', 'CANCELLING'],
      ['CANCELLING', 'CANCELLED'],
    ];

    for (const [from, to] of allowed) {
      expect(canTransitionGenerationJob(from, to)).toBe(true);
    }
  });

  it('rejects every transition out of a terminal state', () => {
    for (const terminal of TERMINAL_GENERATION_JOB_STATES) {
      for (const to of ALL) {
        expect(canTransitionGenerationJob(terminal, to)).toBe(false);
      }
    }
  });

  it('rejects skipping or reversing states', () => {
    expect(canTransitionGenerationJob('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransitionGenerationJob('QUEUED', 'STALLED')).toBe(false);
    expect(canTransitionGenerationJob('RUNNING', 'QUEUED')).toBe(false);
    expect(canTransitionGenerationJob('STALLED', 'COMPLETED')).toBe(false);
    expect(canTransitionGenerationJob('CANCELLING', 'RUNNING')).toBe(false);
  });
});

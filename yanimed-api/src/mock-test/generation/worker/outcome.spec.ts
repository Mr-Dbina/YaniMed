import { describe, expect, it } from 'vitest';
import { GenerationError } from '../generation.errors.js';
import { actionForOutcome, actionForThrow, errorCode, errorName } from './outcome.js';

const SENTINEL = 'ZZ-m5-secret-text';

describe('outcome to action', () => {
  it('maps COMPLETED to COMPLETE', () => {
    expect(
      actionForOutcome({ kind: 'COMPLETED', acceptedCount: 25 }),
    ).toEqual({ kind: 'COMPLETE' });
  });

  it.each([
    'INSUFFICIENT_CONTENT',
    'PROVIDER_UNAVAILABLE',
    'BUDGET_EXHAUSTED',
    'VALIDATION_EXHAUSTED',
    'SOURCE_CHANGED',
    'TIMEOUT',
    'INTERNAL',
  ] as const)('maps FAILED %s to a FAIL action', (reason) => {
    expect(
      actionForOutcome({
        kind: 'FAILED',
        reason,
        code: 'GENERATION_TEST',
        detail: 'rows 3',
      }),
    ).toEqual({
      kind: 'FAIL',
      failureReason: reason,
      code: 'GENERATION_TEST',
      detail: 'rows 3',
    });
  });

  it('maps a plain FAILED outcome without optional fields', () => {
    expect(
      actionForOutcome({ kind: 'FAILED', reason: 'INTERNAL' }),
    ).toEqual({ kind: 'FAIL', failureReason: 'INTERNAL' });
  });

  it('maps STOPPED CANCEL to CANCEL', () => {
    expect(actionForOutcome({ kind: 'STOPPED', cause: 'CANCEL' })).toEqual({
      kind: 'CANCEL',
    });
  });

  it('maps STOPPED DEADLINE to FAILED TIMEOUT', () => {
    expect(actionForOutcome({ kind: 'STOPPED', cause: 'DEADLINE' })).toEqual({
      kind: 'FAIL',
      failureReason: 'TIMEOUT',
    });
  });

  it.each(['STALE_WORKER', 'SHUTDOWN'] as const)(
    'maps STOPPED %s to no writes',
    (cause) => {
      expect(actionForOutcome({ kind: 'STOPPED', cause })).toEqual({
        kind: 'NONE',
        reason: cause,
      });
    },
  );

  it('maps an unexpected Error to FAILED INTERNAL with the name only', () => {
    const action = actionForThrow(new Error(SENTINEL));

    expect(action).toEqual({
      kind: 'FAIL',
      failureReason: 'INTERNAL',
      detail: 'Error',
    });
    expect(JSON.stringify(action)).not.toContain(SENTINEL);
  });

  it('keeps the code of a GenerationError and drops its message', () => {
    const action = actionForThrow(
      new GenerationError('GENERATION_VERIFIER_NOT_CONFIGURED'),
    );

    expect(action).toEqual({
      kind: 'FAIL',
      failureReason: 'INTERNAL',
      detail: 'GenerationError',
      code: 'GENERATION_VERIFIER_NOT_CONFIGURED',
    });
  });

  it('uses a thrown object name and code', () => {
    expect(actionForThrow({ name: 'WeirdError', code: 'E_TEST' })).toEqual({
      kind: 'FAIL',
      failureReason: 'INTERNAL',
      detail: 'WeirdError',
      code: 'E_TEST',
    });
    expect(actionForThrow(undefined)).toEqual({
      kind: 'FAIL',
      failureReason: 'INTERNAL',
      detail: 'UnknownError',
    });
  });

  it('reads only the error name and code', () => {
    expect(errorName({ name: 'Named' })).toBe('Named');
    expect(errorName('text')).toBe('UnknownError');
    expect(errorCode({ code: 'E_TEST' })).toBe('E_TEST');
    expect(errorCode({ code: 7 })).toBeUndefined();
  });
});

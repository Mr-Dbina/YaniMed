import { describe, expect, it } from 'vitest';
import { decideAnswer, type DecideAnswerInput } from './answers.js';
import type { AttemptStatus } from './types.js';

const incomingChoiceId = 'choice-b';

function input(
  overrides: Partial<DecideAnswerInput> = {},
): DecideAnswerInput {
  return {
    attemptStatus: 'IN_PROGRESS',
    questionStatus: 'UNSEEN',
    existingChoiceId: null,
    incomingChoiceId,
    ...overrides,
  };
}

describe('decideAnswer in IN_PROGRESS', () => {
  it('creates the first answer', () => {
    expect(decideAnswer(input())).toEqual({ kind: 'CREATE' });
  });

  it('treats an identical replay as a no-op success', () => {
    expect(
      decideAnswer(input({ existingChoiceId: incomingChoiceId })),
    ).toEqual({ kind: 'NOOP_REPLAY' });
  });

  it('rejects a different choice as a revision conflict', () => {
    expect(
      decideAnswer(input({ existingChoiceId: 'choice-a' })),
    ).toEqual({ kind: 'REJECT', code: 'REVISION_CONFLICT' });
  });
});

describe('decideAnswer in AWAITING_SUBMISSION', () => {
  it('edits an existing answer', () => {
    expect(
      decideAnswer(
        input({
          attemptStatus: 'AWAITING_SUBMISSION',
          existingChoiceId: 'choice-a',
        }),
      ),
    ).toEqual({ kind: 'EDIT' });
  });

  it('treats an identical replay as a no-op success', () => {
    expect(
      decideAnswer(
        input({
          attemptStatus: 'AWAITING_SUBMISSION',
          existingChoiceId: incomingChoiceId,
        }),
      ),
    ).toEqual({ kind: 'NOOP_REPLAY' });
  });

  it('rejects a missing answer because editing cannot create one', () => {
    expect(
      decideAnswer(input({ attemptStatus: 'AWAITING_SUBMISSION' })),
    ).toEqual({ kind: 'REJECT', code: 'NOT_EDITABLE' });
  });
});

describe('decideAnswer in every other attempt status', () => {
  it.each([
    'GENERATING',
    'READY',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'ABANDONED',
  ] satisfies AttemptStatus[])('rejects %s with NOT_IN_PROGRESS', (status) => {
    expect(decideAnswer(input({ attemptStatus: status }))).toEqual({
      kind: 'REJECT',
      code: 'NOT_IN_PROGRESS',
    });
  });
});

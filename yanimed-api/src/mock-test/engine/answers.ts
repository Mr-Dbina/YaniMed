import type { AttemptStatus, QuestionStatus } from './types.js';

export type AnswerDecisionKind =
  | 'CREATE'
  | 'NOOP_REPLAY'
  | 'EDIT'
  | 'REJECT';

export type AnswerRejectCode =
  | 'REVISION_CONFLICT'
  | 'NOT_EDITABLE'
  | 'NOT_IN_PROGRESS';

export type AnswerDecision =
  | { kind: 'CREATE' }
  | { kind: 'NOOP_REPLAY' }
  | { kind: 'EDIT' }
  | { kind: 'REJECT'; code: AnswerRejectCode };

export interface DecideAnswerInput {
  attemptStatus: AttemptStatus;
  /** Accepted for state completeness; the existing answer drives the decision. */
  questionStatus: QuestionStatus;
  existingChoiceId: string | null;
  incomingChoiceId: string;
}

/**
 * Single answer mutation rule.
 *
 * IN_PROGRESS is append-only: a different value is a revision conflict.
 * AWAITING_SUBMISSION is the edit window: a different value edits the answer.
 * A missing answer in AWAITING_SUBMISSION cannot be edited into existence.
 */
export function decideAnswer(input: DecideAnswerInput): AnswerDecision {
  const { attemptStatus, existingChoiceId, incomingChoiceId } = input;

  if (attemptStatus === 'IN_PROGRESS') {
    if (existingChoiceId === null) return { kind: 'CREATE' };
    if (existingChoiceId === incomingChoiceId) {
      return { kind: 'NOOP_REPLAY' };
    }
    return { kind: 'REJECT', code: 'REVISION_CONFLICT' };
  }

  if (attemptStatus === 'AWAITING_SUBMISSION') {
    if (existingChoiceId === null) {
      return { kind: 'REJECT', code: 'NOT_EDITABLE' };
    }
    if (existingChoiceId === incomingChoiceId) {
      return { kind: 'NOOP_REPLAY' };
    }
    return { kind: 'EDIT' };
  }

  return { kind: 'REJECT', code: 'NOT_IN_PROGRESS' };
}

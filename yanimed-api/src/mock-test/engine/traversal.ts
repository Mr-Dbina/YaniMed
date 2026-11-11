import {
  QUESTIONS_PER_TEST,
  type AttemptStatus,
  type EngineQuestion,
} from './types.js';

export type ActiveAttemptStatus = Extract<
  AttemptStatus,
  'IN_PROGRESS' | 'AWAITING_SUBMISSION'
>;

export interface ApplyResult {
  /** New array of new objects. The input array and its objects are untouched. */
  questions: EngineQuestion[];
  nextPosition: number | null;
  attemptStatus: ActiveAttemptStatus;
}

const QUESTION_STATUSES = ['UNSEEN', 'SKIPPED', 'ANSWERED'] as const;

/** A complete attempt has exactly one question at each position 1..25. */
function assertQuestionSet(questions: readonly EngineQuestion[]): void {
  if (questions.length !== QUESTIONS_PER_TEST) {
    throw new Error('Invalid question set.');
  }

  const seen = new Set<number>();
  for (const question of questions) {
    if (
      !Number.isInteger(question.position) ||
      question.position < 1 ||
      question.position > QUESTIONS_PER_TEST ||
      seen.has(question.position) ||
      !QUESTION_STATUSES.includes(question.status)
    ) {
      throw new Error('Invalid question set.');
    }
    seen.add(question.position);
  }
}

function assertCurrentPosition(currentPosition: number): void {
  if (
    !Number.isInteger(currentPosition) ||
    currentPosition < 1 ||
    currentPosition > QUESTIONS_PER_TEST
  ) {
    throw new Error('Invalid current position.');
  }
}

function sortedByPosition(
  questions: readonly EngineQuestion[],
): EngineQuestion[] {
  return [...questions].sort((a, b) => a.position - b.position);
}

/**
 * Smallest position after the current one with UNSEEN or SKIPPED status.
 * When none exists, wraps to the smallest such position. Null means every
 * question is ANSWERED.
 *
 * Reading of the rule: a SKIPPED question between the current position and an
 * UNSEEN one is visited first, because position order wins over status.
 */
export function nextPosition(
  questions: readonly EngineQuestion[],
  currentPosition: number,
): number | null {
  assertQuestionSet(questions);
  assertCurrentPosition(currentPosition);
  const ordered = sortedByPosition(questions);

  const forward = ordered.find(
    (question) =>
      question.position > currentPosition && question.status !== 'ANSWERED',
  );
  if (forward) return forward.position;

  const wrapped = ordered.find(
    (question) => question.status !== 'ANSWERED',
  );
  return wrapped ? wrapped.position : null;
}

function withStatus(
  questions: readonly EngineQuestion[],
  currentPosition: number,
  status: EngineQuestion['status'],
): EngineQuestion[] {
  return questions.map((question) => ({
    ...question,
    status: question.position === currentPosition ? status : question.status,
  }));
}

function resultFor(
  questions: EngineQuestion[],
  currentPosition: number,
): ApplyResult {
  const next = nextPosition(questions, currentPosition);
  return {
    questions,
    nextPosition: next,
    attemptStatus: next === null ? 'AWAITING_SUBMISSION' : 'IN_PROGRESS',
  };
}

export function applyAnswer(
  questions: readonly EngineQuestion[],
  currentPosition: number,
): ApplyResult {
  assertQuestionSet(questions);
  assertCurrentPosition(currentPosition);

  return resultFor(
    withStatus(questions, currentPosition, 'ANSWERED'),
    currentPosition,
  );
}

/**
 * Skip is allowed on any UNSEEN or SKIPPED question, including in the revisit
 * pass. Only ANSWERED questions are refused.
 */
export function applySkip(
  questions: readonly EngineQuestion[],
  currentPosition: number,
): ApplyResult {
  assertQuestionSet(questions);
  assertCurrentPosition(currentPosition);

  const current = questions.find(
    (question) => question.position === currentPosition,
  );
  if (current?.status === 'ANSWERED') {
    throw new Error('Answered questions cannot be skipped.');
  }

  return resultFor(
    withStatus(questions, currentPosition, 'SKIPPED'),
    currentPosition,
  );
}

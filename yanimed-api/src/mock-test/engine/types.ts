/** Plain TypeScript mirrors of the Prisma enums. The engine imports no Prisma. */
export type AttemptStatus =
  | 'GENERATING'
  | 'READY'
  | 'IN_PROGRESS'
  | 'AWAITING_SUBMISSION'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'ABANDONED';

export type QuestionStatus = 'UNSEEN' | 'SKIPPED' | 'ANSWERED';

/** The only per-question state traversal needs. */
export interface EngineQuestion {
  position: number;
  status: QuestionStatus;
}

export const QUESTIONS_PER_TEST = 25;
export const CHOICES_PER_QUESTION = 4;
export const LETTER_MIN = 5;
export const LETTER_MAX = 8;

/** Stable error codes for the Mock Test exam service. */
export type MockTestErrorCode =
  | 'ATTEMPT_EXISTS'
  | 'INSUFFICIENT_CONTENT'
  | 'SESSION_SUPERSEDED'
  | 'REVISION_CONFLICT'
  | 'NOT_ALL_ANSWERED'
  | 'NOT_IN_PROGRESS'
  | 'NOT_EDITABLE'
  | 'SKIP_NOT_ALLOWED'
  | 'ATTEMPT_NOT_FOUND'
  | 'QUESTION_NOT_FOUND'
  | 'INVALID_CHOICE'
  | 'SUBJECT_NOT_FOUND';

export interface MockTestErrorOptions {
  /** Present for ATTEMPT_EXISTS so a client can resume the existing attempt. */
  attemptId?: string;
  /** Small numeric facts, never row contents. */
  details?: Record<string, number>;
}

/** Messages contain only the stable code, never row data. */
export class MockTestError extends Error {
  readonly code: MockTestErrorCode;
  readonly attemptId?: string;
  readonly details?: Record<string, number>;

  constructor(code: MockTestErrorCode, options: MockTestErrorOptions = {}) {
    super(`Mock Test error: ${code}`);
    this.name = 'MockTestError';
    this.code = code;
    this.attemptId = options.attemptId;
    this.details = options.details;
  }
}

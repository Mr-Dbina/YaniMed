export type GenerationErrorCode =
  | 'GENERATION_IN_PROGRESS'
  | 'GENERATION_NOT_FOUND'
  | 'GENERATION_NOT_CANCELLABLE'
  | 'NO_READY_DOCUMENTS'
  | 'GENERATION_STALE_WORKER'
  | 'GENERATION_ACCEPTED_CAP'
  | 'GENERATION_INVALID_TRANSITION'
  | 'GENERATION_BUDGET_EXHAUSTED'
  | 'GENERATION_VERIFIER_NOT_CONFIGURED'
  | 'GENERATION_PROVIDER_UNAVAILABLE'
  | 'GENERATION_AI_TIMEOUT';

export interface GenerationErrorOptions {
  jobId?: string;
  /** Small numeric facts, never row contents. */
  details?: Record<string, number>;
}

/** Messages contain only the stable code, never row data. */
export class GenerationError extends Error {
  readonly code: GenerationErrorCode;
  readonly jobId?: string;
  readonly details?: Record<string, number>;

  constructor(code: GenerationErrorCode, options: GenerationErrorOptions = {}) {
    super(`Generation error: ${code}`);
    this.name = 'GenerationError';
    this.code = code;
    this.jobId = options.jobId;
    this.details = options.details;
  }
}

import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { MockTestError, type MockTestErrorCode } from './exam.errors.js';
import {
  GenerationError,
  type GenerationErrorCode,
} from './generation/generation.errors.js';

interface ErrorMapping {
  status: number;
  message: string;
}

/** Fixed, generic messages. No row data, ids or submitted values. */
const ERROR_MAPPING: Record<MockTestErrorCode, ErrorMapping> = {
  ATTEMPT_EXISTS: {
    status: HttpStatus.CONFLICT,
    message: 'An unfinished attempt already exists for this subject.',
  },
  INSUFFICIENT_CONTENT: {
    status: HttpStatus.CONFLICT,
    message: 'This subject does not have enough eligible questions.',
  },
  SESSION_SUPERSEDED: {
    status: HttpStatus.CONFLICT,
    message: 'This exam was opened in another window.',
  },
  REVISION_CONFLICT: {
    status: HttpStatus.CONFLICT,
    message: 'This answer was already changed.',
  },
  NOT_ALL_ANSWERED: {
    status: HttpStatus.CONFLICT,
    message: 'Every question must be answered before submitting.',
  },
  NOT_IN_PROGRESS: {
    status: HttpStatus.CONFLICT,
    message: 'This exam is not in a state that allows this action.',
  },
  NOT_EDITABLE: {
    status: HttpStatus.CONFLICT,
    message: 'Answers can no longer be changed.',
  },
  SKIP_NOT_ALLOWED: {
    status: HttpStatus.CONFLICT,
    message: 'This question cannot be skipped.',
  },
  ATTEMPT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Attempt not found.',
  },
  QUESTION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Question not found.',
  },
  INVALID_CHOICE: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The selected choice is not valid for this question.',
  },
  SUBJECT_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Subject not found.',
  },
};

/** Generation codes. Messages stay generic; no job row data is copied. */
const GENERATION_MAPPING: Record<GenerationErrorCode, ErrorMapping> = {
  GENERATION_IN_PROGRESS: {
    status: HttpStatus.CONFLICT,
    message: 'A generation job is already unfinished for this subject.',
  },
  GENERATION_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'Generation job not found.',
  },
  GENERATION_NOT_CANCELLABLE: {
    status: HttpStatus.CONFLICT,
    message: 'This generation job can no longer be cancelled.',
  },
  NO_READY_DOCUMENTS: {
    status: HttpStatus.CONFLICT,
    message: 'This subject has no READY documents to generate questions from.',
  },
  GENERATION_STALE_WORKER: {
    status: HttpStatus.CONFLICT,
    message: 'Another worker owns this generation job.',
  },
  GENERATION_ACCEPTED_CAP: {
    status: HttpStatus.CONFLICT,
    message: 'This generation job already accepted its question count.',
  },
  GENERATION_INVALID_TRANSITION: {
    status: HttpStatus.CONFLICT,
    message: 'This generation job is not in a state that allows this action.',
  },
  GENERATION_INVALID_PLAN: {
    status: HttpStatus.CONFLICT,
    message: 'The stored generation plan is not usable.',
  },
  GENERATION_BUDGET_EXHAUSTED: {
    status: HttpStatus.CONFLICT,
    message: 'The generation AI budget is exhausted.',
  },
  GENERATION_VERIFIER_NOT_CONFIGURED: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The generation verifier model is not configured.',
  },
  GENERATION_PROVIDER_UNAVAILABLE: {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: 'The generation provider is unavailable.',
  },
  GENERATION_AI_TIMEOUT: {
    status: HttpStatus.GATEWAY_TIMEOUT,
    message: 'The generation provider timed out.',
  },
};

/**
 * Maps domain errors to stable HTTP responses. Only the two Mock Test error
 * classes are caught, so HttpExceptions keep the framework's default handling.
 */
@Catch(MockTestError, GenerationError)
export class MockTestErrorFilter implements ExceptionFilter {
  catch(
    exception: MockTestError | GenerationError,
    host: ArgumentsHost,
  ): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapping =
      exception instanceof MockTestError
        ? ERROR_MAPPING[exception.code]
        : GENERATION_MAPPING[exception.code];

    const body: Record<string, unknown> = {
      code: exception.code,
      message: mapping.message,
    };

    if (
      exception instanceof MockTestError &&
      exception.code === 'ATTEMPT_EXISTS' &&
      exception.attemptId
    ) {
      body.attemptId = exception.attemptId;
    }
    if (
      exception instanceof MockTestError &&
      exception.code === 'INSUFFICIENT_CONTENT'
    ) {
      body.eligible = exception.details?.available ?? 0;
      body.required = exception.details?.required ?? 0;
    }

    response.status(mapping.status).json(body);
  }
}

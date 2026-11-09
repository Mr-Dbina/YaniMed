import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from '@nestjs/common';
import type { Response } from 'express';
import { MockTestError, type MockTestErrorCode } from './exam.errors.js';

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

/**
 * Maps domain errors to stable HTTP responses. Only MockTestError is caught,
 * so HttpExceptions and unknown errors keep the framework's default handling.
 */
@Catch(MockTestError)
export class MockTestErrorFilter implements ExceptionFilter {
  catch(exception: MockTestError, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const mapping = ERROR_MAPPING[exception.code];

    const body: Record<string, unknown> = {
      code: exception.code,
      message: mapping.message,
    };

    if (exception.code === 'ATTEMPT_EXISTS' && exception.attemptId) {
      body.attemptId = exception.attemptId;
    }
    if (exception.code === 'INSUFFICIENT_CONTENT') {
      body.eligible = exception.details?.available ?? 0;
      body.required = exception.details?.required ?? 0;
    }

    response.status(mapping.status).json(body);
  }
}

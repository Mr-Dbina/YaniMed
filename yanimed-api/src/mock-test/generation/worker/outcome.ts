import { GenerationError } from '../generation.errors.js';
import type { GenerationFailureReason } from '../generation-job.types.js';
import type { RunOutcome } from '../runner/ports.js';

/**
 * What the worker does after one runner outcome. Pure: the worker performs the
 * transition and publish; this module only decides which one is allowed.
 */
export type OutcomeAction =
  | { kind: 'COMPLETE' }
  | {
      kind: 'FAIL';
      failureReason: GenerationFailureReason;
      code?: string;
      detail?: string;
    }
  | { kind: 'CANCEL' }
  | { kind: 'NONE'; reason: 'STALE_WORKER' | 'SHUTDOWN' };

function failed(
  failureReason: GenerationFailureReason,
  extra: { code?: string; detail?: string } = {},
): Extract<OutcomeAction, { kind: 'FAIL' }> {
  return {
    kind: 'FAIL',
    failureReason,
    ...(extra.code === undefined ? {} : { code: extra.code }),
    ...(extra.detail === undefined ? {} : { detail: extra.detail }),
  };
}

/** Maps every runner outcome to exactly one action. */
export function actionForOutcome(outcome: RunOutcome): OutcomeAction {
  switch (outcome.kind) {
    case 'COMPLETED':
      return { kind: 'COMPLETE' };
    case 'FAILED':
      return failed(outcome.reason, {
        ...(outcome.code === undefined ? {} : { code: outcome.code }),
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      });
    case 'STOPPED':
      switch (outcome.cause) {
        case 'CANCEL':
          return { kind: 'CANCEL' };
        case 'DEADLINE':
          return failed('TIMEOUT');
        case 'STALE_WORKER':
          return { kind: 'NONE', reason: 'STALE_WORKER' };
        case 'SHUTDOWN':
          return { kind: 'NONE', reason: 'SHUTDOWN' };
      }
  }
}

/** An unexpected throw is an internal failure; only its name and code survive. */
export function actionForThrow(
  error: unknown,
): Extract<OutcomeAction, { kind: 'FAIL' }> {
  return failed('INTERNAL', {
    detail: errorName(error),
    ...(errorCode(error) === undefined ? {} : { code: errorCode(error) }),
  });
}

export function errorName(error: unknown): string {
  if (error instanceof Error) return error.name;
  if (typeof error === 'object' && error !== null) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return 'UnknownError';
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof GenerationError) return error.code;
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

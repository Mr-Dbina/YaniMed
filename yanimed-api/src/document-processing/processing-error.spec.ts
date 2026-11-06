import { describe, expect, it } from 'vitest';
import {
  classifyProcessingError,
  sanitizeProcessingMessage,
  type ProcessingErrorPolicy,
} from './processing-error.js';

function coded(code: string, message = 'boom', extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function expected(code: string, policy: ProcessingErrorPolicy) {
  return { code, policy };
}

describe('classifyProcessingError', () => {
  it.each([
    {
      name: 'rule a: OCR page limit is CONFIG even when other rules would match',
      error: coded('OCR_PAGE_LIMIT_EXCEEDED', 'OCR_PAGE_TIMEOUT 1', { retryable: true }),
      expected: expected('OCR_PAGE_LIMIT_EXCEEDED', 'CONFIG'),
    },
    {
      name: 'rule b: coded OCR page timeout is MANUAL',
      error: coded('OCR_PAGE_TIMEOUT', 'OCR_PAGE_TIMEOUT 60000'),
      expected: expected('OCR_PAGE_TIMEOUT', 'MANUAL'),
    },
    {
      name: 'rule b: message-only OCR page timeout is MANUAL',
      error: new Error('OCR_PAGE_TIMEOUT 60000'),
      expected: expected('OCR_PAGE_TIMEOUT', 'MANUAL'),
    },
    {
      name: 'rule b: coded OCR time budget is MANUAL',
      error: coded('OCR_TIME_BUDGET_EXCEEDED', 'OCR_TIME_BUDGET_EXCEEDED: elapsed 1ms'),
      expected: expected('OCR_TIME_BUDGET_EXCEEDED', 'MANUAL'),
    },
    {
      name: 'rule b: coded processing time budget is MANUAL',
      error: coded('PROCESSING_TIME_BUDGET_EXCEEDED', 'PROCESSING_TIME_BUDGET_EXCEEDED: job exceeded 1ms.'),
      expected: expected('PROCESSING_TIME_BUDGET_EXCEEDED', 'MANUAL'),
    },
    {
      name: 'rule b runs before rule c when retryable is true',
      error: coded('OCR_PAGE_TIMEOUT', 'OCR_PAGE_TIMEOUT 60000', { retryable: true }),
      expected: expected('OCR_PAGE_TIMEOUT', 'MANUAL'),
    },
    {
      name: 'rule c: EMBEDDING_TRANSIENT is AUTO_RETRY',
      error: coded('EMBEDDING_TRANSIENT', 'Gemini embedding request failed (429): x'),
      expected: expected('EMBEDDING_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule c: STORAGE_TRANSIENT is AUTO_RETRY',
      error: coded('STORAGE_TRANSIENT', 'R2 download failed'),
      expected: expected('STORAGE_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule c: DB_TRANSIENT is AUTO_RETRY',
      error: coded('DB_TRANSIENT', 'database unavailable'),
      expected: expected('DB_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule c: retryable true is AUTO_RETRY',
      error: Object.assign(new Error('retry me'), { retryable: true }),
      expected: expected('PROCESSING_FAILED', 'AUTO_RETRY'),
    },
    {
      name: 'rule d: Prisma P1001 is DB_TRANSIENT',
      error: coded('P1001', 'cannot reach database'),
      expected: expected('DB_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule d: Prisma P1002 is DB_TRANSIENT',
      error: coded('P1002', 'database timeout'),
      expected: expected('DB_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule d: Prisma P1008 is DB_TRANSIENT',
      error: coded('P1008', 'database timeout'),
      expected: expected('DB_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule d: Prisma P1017 is DB_TRANSIENT',
      error: coded('P1017', 'connection closed'),
      expected: expected('DB_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule d: Prisma P2024 is DB_TRANSIENT',
      error: coded('P2024', 'pool timeout'),
      expected: expected('DB_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule d: Prisma P2034 is DB_TRANSIENT',
      error: coded('P2034', 'write conflict'),
      expected: expected('DB_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule d: PrismaClientInitializationError is DB_TRANSIENT',
      error: Object.assign(new Error('cannot initialise'), { name: 'PrismaClientInitializationError' }),
      expected: expected('DB_TRANSIENT', 'AUTO_RETRY'),
    },
    {
      name: 'rule e: ECONNRESET is AUTO_RETRY',
      error: coded('ECONNRESET', 'socket reset'),
      expected: expected('ECONNRESET', 'AUTO_RETRY'),
    },
    {
      name: 'rule e: ETIMEDOUT is AUTO_RETRY',
      error: coded('ETIMEDOUT', 'socket timeout'),
      expected: expected('ETIMEDOUT', 'AUTO_RETRY'),
    },
    {
      name: 'rule e: ECONNREFUSED is AUTO_RETRY',
      error: coded('ECONNREFUSED', 'connection refused'),
      expected: expected('ECONNREFUSED', 'AUTO_RETRY'),
    },
    {
      name: 'rule e: EAI_AGAIN is AUTO_RETRY',
      error: coded('EAI_AGAIN', 'dns retry'),
      expected: expected('EAI_AGAIN', 'AUTO_RETRY'),
    },
    {
      name: 'rule e: ENOTFOUND is AUTO_RETRY',
      error: coded('ENOTFOUND', 'dns missing'),
      expected: expected('ENOTFOUND', 'AUTO_RETRY'),
    },
    {
      name: 'rule e: EPIPE is AUTO_RETRY',
      error: coded('EPIPE', 'broken pipe'),
      expected: expected('EPIPE', 'AUTO_RETRY'),
    },
    {
      name: 'rule e: fetch failed is AUTO_RETRY',
      error: new Error('fetch failed'),
      expected: expected('PROCESSING_FAILED', 'AUTO_RETRY'),
    },
    {
      name: 'rule f: unknown Error is MANUAL',
      error: new Error('boom'),
      expected: expected('PROCESSING_FAILED', 'MANUAL'),
    },
    {
      name: 'rule f: unknown string code is MANUAL and preserved',
      error: coded('SOMETHING_ELSE', 'boom'),
      expected: expected('SOMETHING_ELSE', 'MANUAL'),
    },
    {
      name: 'rule f: non-string code falls back to PROCESSING_FAILED',
      error: Object.assign(new Error('boom'), { code: 42 }),
      expected: expected('PROCESSING_FAILED', 'MANUAL'),
    },
    {
      name: 'non-Error string throw',
      error: 'oops',
      expected: expected('PROCESSING_FAILED', 'MANUAL'),
    },
    {
      name: 'null throw',
      error: null,
      expected: expected('PROCESSING_FAILED', 'MANUAL'),
    },
  ])('$name', ({ error, expected: result }) => {
    expect(classifyProcessingError(error)).toMatchObject(result);
  });

  it('sanitizes messages to the first line and 500 characters', () => {
    expect(sanitizeProcessingMessage('first\nsecond')).toBe('first');
    expect(sanitizeProcessingMessage('x'.repeat(600))).toHaveLength(500);
    expect(classifyProcessingError(new Error('first\nsecond')).message).toBe('first');
    expect(classifyProcessingError('oops').message).toBe('oops');
    expect(classifyProcessingError(null).message).toBe('null');
  });

  it('skips empty leading lines and returns the first non-empty trimmed line', () => {
    expect(
      sanitizeProcessingMessage('\nInvalid `prisma.documentPage.upsert()` invocation:\n  details'),
    ).toBe('Invalid `prisma.documentPage.upsert()` invocation:');
    expect(sanitizeProcessingMessage('  \n\t\n  real message  \nnext')).toBe('real message');
  });
});

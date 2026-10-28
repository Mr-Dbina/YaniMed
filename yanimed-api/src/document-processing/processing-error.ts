export type ProcessingErrorPolicy = 'AUTO_RETRY' | 'MANUAL' | 'CONFIG';

export interface ClassifiedProcessingError {
  code: string;
  message: string;
  policy: ProcessingErrorPolicy;
}

const MANUAL_CODES = new Set([
  'OCR_PAGE_TIMEOUT',
  'OCR_TIME_BUDGET_EXCEEDED',
  'PROCESSING_TIME_BUDGET_EXCEEDED',
]);

const MANUAL_PREFIXES = [
  'OCR_PAGE_TIMEOUT',
  'OCR_TIME_BUDGET_EXCEEDED',
  'PROCESSING_TIME_BUDGET_EXCEEDED',
] as const;

const AUTO_RETRY_CODES = new Set([
  'EMBEDDING_TRANSIENT',
  'STORAGE_TRANSIENT',
  'DB_TRANSIENT',
]);

const PRISMA_RETRY_CODES = new Set([
  'P1001',
  'P1002',
  'P1008',
  'P1017',
  'P2024',
  'P2034',
]);

export const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
]);

function readStringProperty(error: unknown, property: string): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = (error as Record<string, unknown>)[property];
  return typeof value === 'string' ? value : undefined;
}

function readMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPrismaInitializationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (readStringProperty(error, 'name') === 'PrismaClientInitializationError') return true;
  const constructor = (error as { constructor?: { name?: unknown } }).constructor;
  return constructor?.name === 'PrismaClientInitializationError';
}

export function sanitizeProcessingMessage(message: string): string {
  return message.split(/\r?\n/, 1)[0].slice(0, 500);
}

export function isTransientNetworkError(error: unknown): boolean {
  const code = readStringProperty(error, 'code');
  if (code && TRANSIENT_NETWORK_CODES.has(code)) return true;
  return sanitizeProcessingMessage(readMessage(error)) === 'fetch failed';
}

export function classifyProcessingError(error: unknown): ClassifiedProcessingError {
  const code = readStringProperty(error, 'code');
  const message = sanitizeProcessingMessage(readMessage(error));
  const retryable = typeof error === 'object' && error !== null
    && (error as { retryable?: unknown }).retryable === true;

  if (code === 'OCR_PAGE_LIMIT_EXCEEDED') {
    return { code, message, policy: 'CONFIG' };
  }

  const manualCode = code && MANUAL_CODES.has(code) ? code : undefined;
  const manualPrefix = MANUAL_PREFIXES.find(prefix => message.startsWith(prefix));
  if (manualCode || manualPrefix) {
    return { code: manualCode ?? manualPrefix!, message, policy: 'MANUAL' };
  }

  if ((code && AUTO_RETRY_CODES.has(code)) || retryable) {
    return { code: code ?? 'PROCESSING_FAILED', message, policy: 'AUTO_RETRY' };
  }

  if ((code && PRISMA_RETRY_CODES.has(code)) || isPrismaInitializationError(error)) {
    return { code: 'DB_TRANSIENT', message, policy: 'AUTO_RETRY' };
  }

  if (isTransientNetworkError(error)) {
    return { code: code ?? 'PROCESSING_FAILED', message, policy: 'AUTO_RETRY' };
  }

  return { code: code ?? 'PROCESSING_FAILED', message, policy: 'MANUAL' };
}

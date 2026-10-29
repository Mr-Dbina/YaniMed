import type { Prisma } from '@prisma/client';

export type ProcessingTransaction = Prisma.TransactionClient;

export interface JobContext {
  jobId: string;
  documentId: string;
  owner: string;
  token: number;
  lost: boolean;
  updateDocument(data: Prisma.DocumentUpdateInput, tx?: ProcessingTransaction): Promise<void>;
}

export class LeaseLostError extends Error {
  readonly code = 'JOB_LEASE_LOST';

  constructor(message = 'Processing job lease was lost.') {
    super(message);
    this.name = 'LeaseLostError';
  }
}

export type RetryNotAllowedReason = 'NOT_FAILED' | 'RETRY_IN_PROGRESS';

export class RetryNotAllowedError extends Error {
  readonly code = 'RETRY_NOT_ALLOWED';

  constructor(readonly reason: RetryNotAllowedReason) {
    super(reason === 'NOT_FAILED'
      ? 'Only a FAILED document can be retried.'
      : 'A processing job is already active for this document.');
    this.name = 'RetryNotAllowedError';
  }
}

export class RetryDocumentNotFoundError extends Error {
  readonly code = 'DOCUMENT_NOT_FOUND';

  constructor(message = 'Document not found.') {
    super(message);
    this.name = 'RetryDocumentNotFoundError';
  }
}

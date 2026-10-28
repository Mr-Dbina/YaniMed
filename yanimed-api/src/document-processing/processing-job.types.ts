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

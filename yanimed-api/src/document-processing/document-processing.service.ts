import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { PdfExtractionService } from '../pdf-extraction/pdf-extraction.service.js';
import { EmbeddingService } from '../embeddings/embedding.service.js';
import { ProcessingJobRepository, type ClaimedJob } from './processing-job.repository.js';
import { classifyProcessingError } from './processing-error.js';
import { LeaseLostError, type JobContext } from './processing-job.types.js';

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 1) return fallback;
  return parsed;
}

@Injectable()
export class DocumentProcessingService {
  private readonly logger = new Logger(DocumentProcessingService.name);
  private readonly owner = `${process.pid}:${randomUUID()}`;
  private readonly leaseMs = readPositiveInt('PROCESSING_LEASE_MS', 180_000);
  private readonly heartbeatMs = readPositiveInt('PROCESSING_HEARTBEAT_MS', 30_000);
  private readonly jobMaxMs = readPositiveInt('PROCESSING_JOB_MAX_MS', 3_600_000);
  private readonly maxAttempts = readPositiveInt('PROCESSING_MAX_ATTEMPTS', 4);
  private drainTail: Promise<void> = Promise.resolve();

  constructor(
    @Inject(ProcessingJobRepository) private readonly jobs: ProcessingJobRepository,
    @Optional() private readonly extraction?: PdfExtractionService,
    @Optional() private readonly embeddings?: EmbeddingService,
  ) {}

  schedule(documentId: string): void {
    void (async () => {
      try {
        await this.jobs.enqueue(documentId, this.maxAttempts);
      } catch (error) {
        this.logger.warn(`Unable to enqueue document ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      try {
        await this.drain(1);
      } catch (error) {
        this.logger.warn(`Document processing failed for ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  }

  async enqueueOrphans(limit: number): Promise<void> {
    const documentIds = await this.jobs.findOrphanDocumentIds(limit);
    for (const documentId of documentIds) {
      await this.jobs.enqueue(documentId, this.maxAttempts);
    }
  }

  drain(maxJobs: number = 1): Promise<void> {
    const run = this.drainTail.then(() => this.drainInternal(maxJobs));
    this.drainTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async drainInternal(maxJobs: number): Promise<void> {
    for (let processed = 0; processed < maxJobs; processed++) {
      const claimedAt = Date.now();
      const job = await this.jobs.claimNext(this.owner, this.leaseMs);
      if (!job) return;
      await this.runJob(job, claimedAt);
    }
  }

  private async runJob(job: ClaimedJob, claimedAt: number): Promise<void> {
    const ctx = this.jobs.createContext(job);
    let localLeaseUntil = claimedAt + this.leaseMs;
    let heartbeatInFlight = false;
    let finished = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectLost!: (error: LeaseLostError) => void;
    const lost = new Promise<never>((_, reject) => {
      rejectLost = reject;
    });

    const markLost = () => {
      if (finished || ctx.lost) return;
      ctx.lost = true;
      rejectLost(new LeaseLostError());
      this.logger.warn(`Processing lease lost for job ${job.id}.`);
    };

    const pipeline = this.runPipeline(job, ctx);
    pipeline.catch(() => undefined);

    const deadline = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(this.timeBudgetExceeded());
      }, this.jobMaxMs);
      timer.unref?.();
      deadlineTimer = timer;
    });

    const heartbeatTimer = setInterval(() => {
      if (Date.now() > localLeaseUntil) markLost();
      if (heartbeatInFlight || ctx.lost) return;
      heartbeatInFlight = true;
      const heartbeatStartedAt = Date.now();
      void this.jobs.heartbeat(job, this.leaseMs).then(alive => {
        if (alive) {
          localLeaseUntil = heartbeatStartedAt + this.leaseMs;
          return;
        }
        markLost();
      }).catch(error => {
        this.logger.warn(`Processing heartbeat failed for job ${job.id}: ${error instanceof Error ? error.message : String(error)}`);
        if (Date.now() > localLeaseUntil) {
          markLost();
        }
      }).finally(() => {
        heartbeatInFlight = false;
      });
    }, this.heartbeatMs);
    heartbeatTimer.unref?.();

    try {
      await Promise.race([pipeline, deadline, lost]);
    } catch (error) {
      if (error instanceof LeaseLostError || ctx.lost) {
        this.logger.warn(`Stopping processing for job ${job.id} because its lease was lost.`);
        return;
      }

      const classified = classifyProcessingError(error);
      const errorMessage = classified.message;
      const errorCode = classified.code;
      const timedOut = errorCode === 'PROCESSING_TIME_BUDGET_EXCEEDED';
      if (timedOut) ctx.lost = true;
      this.logger.warn(`Processing job ${job.id} failed with policy ${classified.policy}.`);

      try {
        await this.jobs.complete({ job, success: false, errorCode, errorMessage });
      } catch (completeError) {
        if (completeError instanceof LeaseLostError) {
          this.logger.warn(`Stopping processing for job ${job.id} because its lease was lost.`);
        } else {
          this.logger.error(`Unable to record failure for job ${job.id}: ${completeError instanceof Error ? completeError.message : String(completeError)}`);
        }
      }
      if (timedOut) return;
    } finally {
      finished = true;
      clearInterval(heartbeatTimer);
      if (deadlineTimer) clearTimeout(deadlineTimer);
    }
  }

  private async runPipeline(job: ClaimedJob, ctx: JobContext): Promise<void> {
    if (!this.extraction) throw new Error('PDF extraction service is not available.');
    await this.extraction.processDocument(job.documentId, {}, ctx);

    if (ctx.lost) throw new LeaseLostError();

    if (!this.embeddings) throw new Error('Embedding service is not available.');
    await this.embeddings.embedDocument(job.documentId, ctx);

    if (ctx.lost) throw new LeaseLostError();

    const integrity = await this.embeddings.verifyDocumentEmbeddings(job.documentId);
    if (integrity.totalChunks === 0) {
      throw new Error('Document contains no extractable text.');
    }
    if (!integrity.isComplete) {
      throw new Error('Embedding integrity verification failed.');
    }

    await this.jobs.complete({ job, success: true });
  }

  private timeBudgetExceeded(): Error {
    const error = new Error(`PROCESSING_TIME_BUDGET_EXCEEDED: job exceeded ${this.jobMaxMs}ms.`);
    (error as { code?: string }).code = 'PROCESSING_TIME_BUDGET_EXCEEDED';
    return error;
  }
}

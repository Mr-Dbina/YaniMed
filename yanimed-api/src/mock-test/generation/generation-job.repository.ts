import { randomUUID } from 'node:crypto';
import type { GenerationJob } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  MAX_RECOVERIES,
  QUESTIONS_PER_TEST,
  STALL_AFTER_MS,
} from './generation.constants.js';
import { GenerationError } from './generation.errors.js';
import {
  canTransitionGenerationJob,
  type ClaimedGenerationJob,
  type GenerationFailureReason,
  type GenerationJobFence,
  type GenerationJobSnapshot,
  type GenerationJobState,
  type StalledGenerationJob,
} from './generation-job.types.js';

const TX_OPTIONS = { maxWait: 30_000, timeout: 30_000 };
const STALL_BATCH = 20;
const CANCELLABLE_STATES: GenerationJobState[] = [
  'QUEUED',
  'RUNNING',
  'STALLED',
];

export interface CreateGenerationJobInput {
  subjectId: string;
  documentIds: readonly string[];
  idempotencyKey?: string;
  requestedCount?: number;
}

export interface CreateGenerationJobResult {
  job: GenerationJobSnapshot;
  created: boolean;
}

export interface TransitionOptions {
  failureReason?: GenerationFailureReason;
}

export interface FinishOutcome {
  state: 'COMPLETED' | 'FAILED' | 'CANCELLED';
  failureReason?: GenerationFailureReason;
}

interface ClaimedRow {
  jobId: string;
  subjectId: string;
  requestedCount: number;
  acceptedCount: number;
  recoveryCount: number;
}

export interface MarkStalledOptions {
  /** Defaults to STALL_AFTER_MS. */
  stalledAfterMs?: number;
  /** Boot recovery: every RUNNING job belongs to a dead process. */
  includeFresh?: boolean;
}

function toSnapshot(job: GenerationJob): GenerationJobSnapshot {
  return {
    id: job.id,
    subjectId: job.subjectId,
    state: job.state as GenerationJobState,
    requestedCount: job.requestedCount,
    acceptedCount: job.acceptedCount,
    planJson: job.planJson,
    heartbeatAt: job.heartbeatAt,
    recoveryCount: job.recoveryCount,
    aiCallCount: job.aiCallCount,
    failureReason: job.failureReason,
    idempotencyKey: job.idempotencyKey,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

function uniqueTargetText(error: unknown): string {
  const meta = (error as { meta?: { target?: unknown } }).meta;
  const target = meta?.target;
  if (Array.isArray(target)) return target.join(',');
  if (typeof target === 'string') return target;
  return error instanceof Error ? error.message : '';
}

function isActiveJobConflict(error: unknown): boolean {
  const target = uniqueTargetText(error);
  if (/idempotencyKey/i.test(target)) return false;
  return target.length === 0 || /GenerationJob_subjectId_active_key|subjectId/i.test(target);
}

function stale(jobId: string): GenerationError {
  return new GenerationError('GENERATION_STALE_WORKER', { jobId });
}

/**
 * Durable job state. No lease columns exist, so recoveryCount is the epoch
 * fence: a recovered worker keeps the old epoch and every guarded write fails.
 */
export class GenerationJobRepository {
  constructor(private readonly prisma: PrismaService) {}

  async createJob(
    input: CreateGenerationJobInput,
  ): Promise<CreateGenerationJobResult> {
    const documentIds = [...new Set(input.documentIds)];
    if (documentIds.length === 0) {
      throw new GenerationError('NO_READY_DOCUMENTS');
    }

    const requestedCount = input.requestedCount ?? QUESTIONS_PER_TEST;
    if (
      !Number.isInteger(requestedCount) ||
      requestedCount < 1 ||
      requestedCount > QUESTIONS_PER_TEST
    ) {
      throw new RangeError(
        `requestedCount must be an integer between 1 and ${QUESTIONS_PER_TEST}.`,
      );
    }

    const idempotencyKey =
      input.idempotencyKey?.trim() || randomUUID();

    if (input.idempotencyKey) {
      const existing = await this.prisma.generationJob.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return this.reuse(existing, input.subjectId);
    }

    try {
      const job = await this.prisma.$transaction(
        async (tx) =>
          tx.generationJob.create({
            data: {
              subjectId: input.subjectId,
              state: 'QUEUED',
              requestedCount,
              idempotencyKey,
              documents: {
                create: documentIds.map((documentId) => ({
                  document: { connect: { id: documentId } },
                })),
              },
            },
          }),
        TX_OPTIONS,
      );
      return { job: toSnapshot(job), created: true };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;

      // An idempotency-key race can be recovered by returning the winner.
      const existing = await this.prisma.generationJob.findUnique({
        where: { idempotencyKey },
      });
      if (existing) return this.reuse(existing, input.subjectId);

      if (isActiveJobConflict(error)) {
        throw new GenerationError('GENERATION_IN_PROGRESS');
      }
      throw new GenerationError('GENERATION_IN_PROGRESS');
    }
  }

  private reuse(
    job: GenerationJob,
    subjectId: string,
  ): CreateGenerationJobResult {
    if (job.subjectId !== subjectId) {
      throw new GenerationError('GENERATION_IN_PROGRESS', { jobId: job.id });
    }
    return { job: toSnapshot(job), created: false };
  }

  /**
   * Single claim path. Claims the oldest QUEUED job, or a STALLED job that
   * still has recoveries left. A STALLED claim advances recoveryCount, so the
   * dead worker's fence no longer matches. The candidate is locked until the
   * update commits, so two claimers cannot take the same row.
   */
  async claimNext(): Promise<ClaimedGenerationJob | null> {
    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
          FROM "GenerationJob"
         WHERE "state" = 'QUEUED'
            OR ("state" = 'STALLED' AND "recoveryCount" < ${MAX_RECOVERIES})
         ORDER BY "createdAt" ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      `;
      const candidate = candidates[0];
      if (!candidate) return null;

      const rows = await tx.$queryRaw<ClaimedRow[]>`
        UPDATE "GenerationJob" AS j
        SET "state" = 'RUNNING',
            "startedAt" = COALESCE(j."startedAt", now()),
            "heartbeatAt" = now(),
            "recoveryCount" = CASE
              WHEN j."state" = 'STALLED' THEN j."recoveryCount" + 1
              ELSE j."recoveryCount"
            END
        WHERE j."id" = ${candidate.id}
          AND j."state" IN ('QUEUED', 'STALLED')
          AND (j."state" = 'QUEUED' OR j."recoveryCount" < ${MAX_RECOVERIES})
        RETURNING j."id" AS "jobId",
                  j."subjectId" AS "subjectId",
                  j."requestedCount" AS "requestedCount",
                  j."acceptedCount" AS "acceptedCount",
                  j."recoveryCount" AS "recoveryCount"
      `;

      return rows[0] ?? null;
    }, TX_OPTIONS);
  }

  async heartbeat(fence: GenerationJobFence): Promise<void> {
    const result = await this.prisma.generationJob.updateMany({
      where: {
        id: fence.jobId,
        state: 'RUNNING',
        recoveryCount: fence.recoveryCount,
      },
      data: { heartbeatAt: new Date() },
    });

    if (result.count === 0) throw stale(fence.jobId);
  }

  async transition(
    fence: GenerationJobFence,
    to: GenerationJobState,
    options: TransitionOptions = {},
  ): Promise<GenerationJobSnapshot> {
    if (!canTransitionGenerationJob(fence.state, to)) {
      throw new GenerationError('GENERATION_INVALID_TRANSITION', {
        jobId: fence.jobId,
      });
    }

    const data: {
      state: GenerationJobState;
      finishedAt?: Date;
      failureReason?: string;
      heartbeatAt?: Date;
    } = { state: to };

    if (to === 'COMPLETED' || to === 'FAILED' || to === 'CANCELLED') {
      data.finishedAt = new Date();
    }
    if (to === 'FAILED') {
      if (!options.failureReason) {
        throw new GenerationError('GENERATION_INVALID_TRANSITION', {
          jobId: fence.jobId,
        });
      }
      data.failureReason = options.failureReason;
    }
    if (to === 'RUNNING' && fence.state === 'STALLED') {
      data.heartbeatAt = new Date();
    }

    const result = await this.prisma.generationJob.updateMany({
      where: {
        id: fence.jobId,
        state: fence.state,
        recoveryCount: fence.recoveryCount,
      },
      data,
    });

    if (result.count === 0) throw stale(fence.jobId);

    return toSnapshot(
      await this.prisma.generationJob.findUniqueOrThrow({
        where: { id: fence.jobId },
      }),
    );
  }

  async finish(
    fence: GenerationJobFence,
    outcome: FinishOutcome,
  ): Promise<GenerationJobSnapshot> {
    return this.transition(fence, outcome.state, {
      failureReason: outcome.failureReason,
    });
  }

  /**
   * Increments acceptedCount only while the job is still RUNNING in the same
   * recovery epoch and below its requested count.
   */
  async incrementAccepted(fence: GenerationJobFence): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ acceptedCount: number }[]>`
      UPDATE "GenerationJob"
      SET "acceptedCount" = "acceptedCount" + 1
      WHERE "id" = ${fence.jobId}
        AND "state" = 'RUNNING'
        AND "recoveryCount" = ${fence.recoveryCount}
        AND "acceptedCount" < "requestedCount"
      RETURNING "acceptedCount"
    `;

    const row = rows[0];
    if (row) return row.acceptedCount;

    const job = await this.prisma.generationJob.findUnique({
      where: { id: fence.jobId },
    });
    if (!job) throw new GenerationError('GENERATION_NOT_FOUND', { jobId: fence.jobId });
    if (job.acceptedCount >= job.requestedCount) {
      throw new GenerationError('GENERATION_ACCEPTED_CAP', {
        jobId: fence.jobId,
      });
    }
    throw stale(fence.jobId);
  }

  /**
   * Reserves one AI call for a job, refusing at the cap. The update only lands
   * while aiCallCount is below the cap, so it doubles as the pre-call budget
   * check. Returns the new count, or null when the job is missing or at cap.
   */
  async reserveAiCall(jobId: string, cap: number): Promise<number | null> {
    const rows = await this.prisma.$queryRaw<{ aiCallCount: number }[]>`
      UPDATE "GenerationJob"
      SET "aiCallCount" = "aiCallCount" + 1
      WHERE "id" = ${jobId}
        AND "aiCallCount" < ${cap}
      RETURNING "aiCallCount"
    `;

    return rows[0]?.aiCallCount ?? null;
  }

  /**
   * Moves stale RUNNING jobs to STALLED without advancing the epoch. The
   * recovery claim (claimNext) advances recoveryCount, so the dead worker's
   * fence stays stale. A heartbeat that lands first makes the row ineligible.
   */
  async markStalled(
    now: Date = new Date(),
    limit = STALL_BATCH,
    options: MarkStalledOptions = {},
  ): Promise<StalledGenerationJob[]> {
    const staleBefore = new Date(
      now.getTime() - (options.stalledAfterMs ?? STALL_AFTER_MS),
    );
    return this.prisma.$queryRaw<StalledGenerationJob[]>`
      UPDATE "GenerationJob" AS j
      SET "state" = 'STALLED'
      FROM (
        SELECT "id"
          FROM "GenerationJob"
         WHERE "state" = 'RUNNING'
           AND (${options.includeFresh ?? false}::boolean
                OR COALESCE("heartbeatAt", "startedAt") < ${staleBefore})
         ORDER BY COALESCE("heartbeatAt", "startedAt") ASC NULLS FIRST
         LIMIT ${limit}
         FOR UPDATE SKIP LOCKED
      ) AS candidate
      WHERE j."id" = candidate."id"
        AND j."state" = 'RUNNING'
        AND (${options.includeFresh ?? false}::boolean
             OR COALESCE(j."heartbeatAt", j."startedAt") < ${staleBefore})
      RETURNING j."id" AS "jobId", j."recoveryCount" AS "recoveryCount"
    `;
  }

  /**
   * STALLED jobs that still wait for the recovery rule. State-filtered and
   * bounded; used to fail jobs left behind by a crashed sweep.
   */
  async listStalled(limit = STALL_BATCH): Promise<StalledGenerationJob[]> {
    const rows = await this.prisma.generationJob.findMany({
      where: { state: 'STALLED' },
      orderBy: [{ recoveryCount: 'desc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true, recoveryCount: true },
    });
    return rows.map((row) => ({
      jobId: row.id,
      recoveryCount: row.recoveryCount,
    }));
  }

  async requestCancel(jobId: string): Promise<GenerationJobSnapshot> {
    const current = await this.prisma.generationJob.findUnique({
      where: { id: jobId },
    });
    if (!current) throw new GenerationError('GENERATION_NOT_FOUND', { jobId });

    if (current.state === 'CANCELLING' || current.state === 'CANCELLED') {
      return toSnapshot(current);
    }
    if (
      current.state !== 'QUEUED' &&
      current.state !== 'RUNNING' &&
      current.state !== 'STALLED'
    ) {
      throw new GenerationError('GENERATION_NOT_CANCELLABLE', { jobId });
    }

    const result = await this.prisma.generationJob.updateMany({
      where: {
        id: jobId,
        state: { in: CANCELLABLE_STATES },
      },
      data: { state: 'CANCELLING' },
    });

    if (result.count === 0) {
      const latest = await this.prisma.generationJob.findUnique({
        where: { id: jobId },
      });
      if (!latest) {
        throw new GenerationError('GENERATION_NOT_FOUND', { jobId });
      }
      if (latest.state === 'CANCELLING' || latest.state === 'CANCELLED') {
        return toSnapshot(latest);
      }
      throw new GenerationError('GENERATION_NOT_CANCELLABLE', { jobId });
    }

    return toSnapshot(
      await this.prisma.generationJob.findUniqueOrThrow({
        where: { id: jobId },
      }),
    );
  }
}

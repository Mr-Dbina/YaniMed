import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { GenerationJob } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { parsePlan } from './adapters/plan-store.js';
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
const ACTIVE_JOB_STATES: readonly GenerationJobState[] = [
  'QUEUED',
  'RUNNING',
  'STALLED',
  'CANCELLING',
];

/** Only failures that can make progress on a retry may be resumed. */
const RESUMABLE_FAILURE_REASONS: ReadonlySet<GenerationFailureReason> = new Set([
  'PROVIDER_UNAVAILABLE',
  'TIMEOUT',
  'VALIDATION_EXHAUSTED',
  'BUDGET_EXHAUSTED',
]);

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

export interface ResumeFailedJobResult {
  job: GenerationJobSnapshot;
  created: false;
  /** True only for the request whose guarded UPDATE won. */
  resumed: boolean;
  previousFailureReason: GenerationFailureReason;
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
@Injectable()
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
   * Resumes the subject's latest job when it failed for a reason a retry can
   * still make progress on. Held questions, the plan and acceptedCount stay;
   * aiCallCount resets so the retry gets a fresh budget. The guarded UPDATE is
   * the race winner: a second request sees zero rows and returns the winner.
   */
  async resumeLatestFailedJob(
    subjectId: string,
  ): Promise<ResumeFailedJobResult | null> {
    const latest = await this.prisma.generationJob.findFirst({
      where: { subjectId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        state: true,
        failureReason: true,
        recoveryCount: true,
        planJson: true,
        subject: { select: { status: true } },
        documents: {
          select: {
            documentId: true,
            document: { select: { status: true } },
          },
        },
      },
    });
    if (latest === null || latest.state !== 'FAILED') return null;

    const reason = latest.failureReason as GenerationFailureReason | null;
    if (reason === null || !RESUMABLE_FAILURE_REASONS.has(reason)) return null;
    if (latest.recoveryCount >= MAX_RECOVERIES) return null;
    if (latest.subject.status !== 'ACTIVE') return null;

    // R2 only allows one active job per subject. A different active row must
    // win, so this request falls through to the create path instead.
    const active = await this.prisma.generationJob.findFirst({
      where: { subjectId, state: { in: [...ACTIVE_JOB_STATES] } },
      select: { id: true },
    });
    if (active !== null) return null;

    const snapshot = latest.documents;
    if (snapshot.length === 0) return null;
    if (snapshot.some((link) => link.document.status !== 'READY')) return null;

    if (latest.planJson !== null) {
      const plan = parsePlan(latest.planJson);
      if (plan === null) return null;
      const pinned = [
        ...new Set(
          plan.slots
            .map((slot) => slot.seedChunkIds[0])
            .filter((id): id is string => id !== undefined),
        ),
      ];
      if (pinned.length > 0) {
        const found = await this.prisma.chunk.count({
          where: { id: { in: pinned } },
        });
        if (found !== pinned.length) return null;
      }
    }

    // A held question that already left QUARANTINED means the job is not in a
    // resumable shape; never touch it.
    const unheld = await this.prisma.mockQuestion.count({
      where: { jobId: latest.id, status: { not: 'QUARANTINED' } },
    });
    if (unheld > 0) return null;

    let updated = 0;
    try {
      const result = await this.prisma.generationJob.updateMany({
        where: {
          id: latest.id,
          state: 'FAILED',
          recoveryCount: latest.recoveryCount,
          failureReason: { in: [...RESUMABLE_FAILURE_REASONS] },
        },
        data: {
          state: 'QUEUED',
          failureReason: null,
          finishedAt: null,
          heartbeatAt: null,
          startedAt: new Date(),
          aiCallCount: 0,
          recoveryCount: { increment: 1 },
        },
      });
      updated = result.count;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      updated = 0;
    }

    if (updated === 0) {
      const winner = await this.prisma.generationJob.findFirst({
        where: { subjectId, state: { in: [...ACTIVE_JOB_STATES] } },
        orderBy: { createdAt: 'desc' },
      });
      if (winner === null) return null;
      return {
        job: toSnapshot(winner),
        created: false,
        resumed: false,
        previousFailureReason: reason,
      };
    }

    const job = await this.prisma.generationJob.findUniqueOrThrow({
      where: { id: latest.id },
    });
    return {
      job: toSnapshot(job),
      created: false,
      resumed: true,
      previousFailureReason: reason,
    };
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
        SELECT j."id"
          FROM "GenerationJob" j
          JOIN "Subject" s ON s."id" = j."subjectId"
         WHERE s."status" = 'ACTIVE'
           AND (j."state" = 'QUEUED'
             OR (j."state" = 'STALLED' AND j."recoveryCount" < ${MAX_RECOVERIES}))
         ORDER BY j."createdAt" ASC
         LIMIT 1
         FOR UPDATE OF j SKIP LOCKED
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
        SELECT j."id"
          FROM "GenerationJob" j
          JOIN "Subject" s ON s."id" = j."subjectId"
         WHERE s."status" = 'ACTIVE'
           AND j."state" = 'RUNNING'
           AND (${options.includeFresh ?? false}::boolean
                OR COALESCE(j."heartbeatAt", j."startedAt") < ${staleBefore})
         ORDER BY COALESCE(j."heartbeatAt", j."startedAt") ASC NULLS FIRST
         LIMIT ${limit}
         FOR UPDATE OF j SKIP LOCKED
      ) AS candidate
      WHERE j."id" = candidate."id"
        AND j."state" = 'RUNNING'
        AND (${options.includeFresh ?? false}::boolean
             OR COALESCE(j."heartbeatAt", j."startedAt") < ${staleBefore})
      RETURNING j."id" AS "jobId", j."recoveryCount" AS "recoveryCount"
    `;
  }

  async listStalled(limit = STALL_BATCH): Promise<StalledGenerationJob[]> {
    const rows = await this.prisma.generationJob.findMany({
      where: { state: 'STALLED', subject: { status: 'ACTIVE' } },
      orderBy: [{ recoveryCount: 'desc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true, recoveryCount: true },
    });
    return rows.map((row) => ({
      jobId: row.id,
      recoveryCount: row.recoveryCount,
    }));
  }

  /**
   * CANCELLING rows no worker owns: no heartbeat yet, or one older than the
   * stall window. Bounded and state-filtered; the caller finishes each row
   * with a fenced transition. A boot passes includeFresh because no worker of
   * this process has run yet.
   */
  async listOrphanedCancels(
    now: Date = new Date(),
    limit = STALL_BATCH,
    options: MarkStalledOptions = {},
  ): Promise<StalledGenerationJob[]> {
    const staleBefore = new Date(
      now.getTime() - (options.stalledAfterMs ?? STALL_AFTER_MS),
    );
    const rows = await this.prisma.generationJob.findMany({
      where: {
        state: 'CANCELLING',
        ...(options.includeFresh === true
          ? {}
          : {
              OR: [
                { heartbeatAt: null },
                { heartbeatAt: { lt: staleBefore } },
              ],
            }),
      },
      orderBy: [{ heartbeatAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
      select: { id: true, recoveryCount: true },
    });
    return rows.map((row) => ({
      jobId: row.id,
      recoveryCount: row.recoveryCount,
    }));
  }

  /**
   * A QUEUED job has no worker, so it finishes in one fenced step. RUNNING and
   * STALLED jobs need their worker to stop, so they go through CANCELLING.
   */
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

    const finished = await this.prisma.generationJob.updateMany({
      where: { id: jobId, state: 'QUEUED' },
      data: { state: 'CANCELLED', finishedAt: new Date() },
    });
    if (finished.count === 1) {
      return toSnapshot(
        await this.prisma.generationJob.findUniqueOrThrow({
          where: { id: jobId },
        }),
      );
    }

    const cancelling = await this.prisma.generationJob.updateMany({
      where: { id: jobId, state: { in: ['RUNNING', 'STALLED'] } },
      data: { state: 'CANCELLING' },
    });

    if (cancelling.count === 0) {
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

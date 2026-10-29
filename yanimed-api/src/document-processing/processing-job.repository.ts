import { randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  LeaseLostError,
  RetryDocumentNotFoundError,
  RetryNotAllowedError,
  type JobContext,
  type ProcessingTransaction,
} from './processing-job.types.js';

export interface ClaimedJob {
  id: string;
  documentId: string;
  attempt: number;
  maxAttempts: number;
  fencingToken: number;
  leaseOwner: string;
}

export interface LatestProcessingJob {
  status: string;
  attempt: number;
  maxAttempts: number;
  nextRunAt: Date;
  errorCode: string | null;
}

function isActiveJobConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; meta?: unknown; message?: unknown };
  const meta = typeof record.meta === 'object' && record.meta !== null
    ? record.meta as { code?: unknown; message?: unknown; target?: unknown }
    : undefined;
  if (record.code === 'P2002' || record.code === '23505') return true;
  if (meta?.code === 'P2002' || meta?.code === '23505') return true;
  const text = [record.message, meta?.message, meta?.target]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return text.includes('ProcessingJob_documentId_active_key')
    || (text.includes('duplicate key value') && text.includes('ProcessingJob'));
}

export interface CompleteJobInput {
  job: ClaimedJob;
  success: boolean;
  errorCode?: string | null;
  errorMessage?: string | null;
  retry?: { delayMs: number };
}

@Injectable()
export class ProcessingJobRepository {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async enqueue(documentId: string, maxAttempts: number): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "public"."ProcessingJob" (
        "id", "documentId", "status", "attempt", "maxAttempts",
        "nextRunAt", "fencingToken", "createdAt", "updatedAt"
      )
      SELECT ${randomUUID()}, d."id", 'QUEUED', 0, ${maxAttempts}::integer, now(), 0, now(), now()
      FROM "public"."Document" d
      WHERE d."id" = ${documentId}
        AND d."status" IN ('QUEUED', 'PROCESSING')
      ON CONFLICT DO NOTHING
      RETURNING "id"
    `;
    return rows[0]?.id ?? null;
  }

  async getLatestJob(documentId: string): Promise<LatestProcessingJob | null> {
    return this.prisma.processingJob.findFirst({
      where: { documentId },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        attempt: true,
        maxAttempts: true,
        nextRunAt: true,
        errorCode: true,
      },
    });
  }

  async retryFailed(documentId: string, maxAttempts: number): Promise<string> {
    try {
      return await this.prisma.$transaction(async tx => {
        const rows = await tx.$queryRaw<Array<{ status: string; hasActiveJob: boolean }>>`
          SELECT d."status" AS "status",
                 EXISTS (
                   SELECT 1
                   FROM "public"."ProcessingJob" j
                   WHERE j."documentId" = d."id"
                     AND j."status" IN ('QUEUED', 'RUNNING', 'RETRY_WAIT')
                 ) AS "hasActiveJob"
          FROM "public"."Document" d
          WHERE d."id" = ${documentId}
          FOR UPDATE OF d
        `;

        const current = rows[0];
        if (!current) throw new RetryDocumentNotFoundError();
        if (current.status !== 'FAILED') throw new RetryNotAllowedError('NOT_FAILED');
        if (current.hasActiveJob) throw new RetryNotAllowedError('RETRY_IN_PROGRESS');

        const inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO "public"."ProcessingJob" (
            "id", "documentId", "status", "attempt", "maxAttempts",
            "nextRunAt", "fencingToken", "createdAt", "updatedAt"
          )
          VALUES (
            ${randomUUID()}, ${documentId}, 'QUEUED', 0, ${maxAttempts}::integer,
            now(), 0, now(), now()
          )
          RETURNING "id"
        `;

        const jobId = inserted[0]?.id;
        if (!jobId) throw new Error('Processing job insert returned no id.');

        await tx.document.update({
          where: { id: documentId },
          data: { status: 'QUEUED', errorMessage: null },
        });

        return jobId;
      }, { timeout: 15_000 });
    } catch (error) {
      if (isActiveJobConflict(error)) throw new RetryNotAllowedError('RETRY_IN_PROGRESS');
      throw error;
    }
  }

  async claimNext(owner: string, leaseMs: number): Promise<ClaimedJob | null> {
    return this.prisma.$transaction(async tx => {
      const expired = await tx.$queryRaw<Array<{ id: string; documentId: string }>>`
        WITH expired AS (
          SELECT "id", "documentId"
          FROM "public"."ProcessingJob"
          WHERE "status" = 'RUNNING'
            AND "leaseUntil" IS NOT NULL
            AND "leaseUntil" <= now()
            AND "attempt" >= "maxAttempts"
          ORDER BY "leaseUntil" ASC
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "public"."ProcessingJob" j
        SET "status" = 'FAILED',
            "leaseOwner" = NULL,
            "leaseUntil" = NULL,
            "errorCode" = 'LEASE_EXPIRED_MAX_ATTEMPTS',
            "errorMessage" = 'Processing lease expired after maximum attempts.',
            "finishedAt" = now(),
            "updatedAt" = now()
        FROM expired e
        WHERE j."id" = e."id"
        RETURNING j."id", j."documentId"
      `;

      if (expired.length > 0) {
        await tx.document.updateMany({
          where: { id: { in: expired.map(row => row.documentId) } },
          data: {
            status: 'FAILED',
            errorMessage: 'Processing lease expired after maximum attempts.',
          },
        });
      }

      const rows = await tx.$queryRaw<ClaimedJob[]>`
        WITH candidate AS (
          SELECT j."id"
          FROM "public"."ProcessingJob" j
          WHERE (
              (j."status" = 'QUEUED' AND j."nextRunAt" <= now())
              OR (j."status" = 'RETRY_WAIT' AND j."nextRunAt" <= now())
              OR (j."status" = 'RUNNING' AND j."leaseUntil" IS NOT NULL AND j."leaseUntil" <= now())
            )
            AND j."attempt" < j."maxAttempts"
          ORDER BY j."nextRunAt" ASC, j."createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "public"."ProcessingJob" j
        SET "status" = 'RUNNING',
            "attempt" = j."attempt" + 1,
            "fencingToken" = j."fencingToken" + 1,
            "leaseOwner" = ${owner},
            "leaseUntil" = now() + (${leaseMs}::double precision * interval '1 millisecond'),
            "startedAt" = COALESCE(j."startedAt", now()),
            "finishedAt" = NULL,
            "errorCode" = NULL,
            "errorMessage" = NULL,
            "updatedAt" = now()
        FROM candidate c
        WHERE j."id" = c."id"
        RETURNING j."id", j."documentId", j."attempt", j."maxAttempts", j."fencingToken", j."leaseOwner"
      `;

      return rows[0] ?? null;
    }, { timeout: 15_000 });
  }

  async heartbeat(job: ClaimedJob, leaseMs: number): Promise<boolean> {
    const count = await this.prisma.$executeRaw`
      UPDATE "public"."ProcessingJob"
      SET "leaseUntil" = now() + (${leaseMs}::double precision * interval '1 millisecond'),
          "updatedAt" = now()
      WHERE "id" = ${job.id}
        AND "documentId" = ${job.documentId}
        AND "status" = 'RUNNING'
        AND "leaseOwner" = ${job.leaseOwner}
        AND "fencingToken" = ${job.fencingToken}
        AND "leaseUntil" IS NOT NULL
        AND "leaseUntil" > now()
    `;
    return count > 0;
  }

  async complete(input: CompleteJobInput): Promise<void> {
    const retry = input.success ? undefined : input.retry;
    const status = input.success ? 'SUCCEEDED' : retry ? 'RETRY_WAIT' : 'FAILED';

    await this.prisma.$transaction(async tx => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "public"."ProcessingJob"
        WHERE "id" = ${input.job.id}
          AND "documentId" = ${input.job.documentId}
          AND "status" = 'RUNNING'
          AND "leaseOwner" = ${input.job.leaseOwner}
          AND "fencingToken" = ${input.job.fencingToken}
          AND "leaseUntil" IS NOT NULL
          AND "leaseUntil" > now()
        FOR UPDATE
      `;

      if (rows.length === 0) throw new LeaseLostError();

      await tx.$executeRaw`
        UPDATE "public"."ProcessingJob"
        SET "status" = ${status}::"public"."ProcessingJobStatus",
            "nextRunAt" = CASE
              WHEN ${Boolean(retry)}::boolean
              THEN now() + (${retry?.delayMs ?? 0}::double precision * interval '1 millisecond')
              ELSE "nextRunAt"
            END,
            "leaseOwner" = NULL,
            "leaseUntil" = NULL,
            "errorCode" = ${input.success ? null : input.errorCode ?? 'PROCESSING_FAILED'},
            "errorMessage" = ${input.success ? null : input.errorMessage ?? null},
            "finishedAt" = CASE WHEN ${Boolean(retry)}::boolean THEN NULL ELSE now() END,
            "updatedAt" = now()
        WHERE "id" = ${input.job.id}
      `;

      const updated = await tx.document.updateMany({
        where: { id: input.job.documentId },
        data: {
          status: input.success ? 'READY' : retry ? 'QUEUED' : 'FAILED',
          errorMessage: input.success ? null : input.errorMessage ?? null,
        },
      });
      if (updated.count === 0) throw new LeaseLostError('Document no longer exists.');
    }, { timeout: 15_000 });
  }

  async fencedDocumentUpdate(
    ctx: JobContext,
    data: Prisma.DocumentUpdateInput,
    tx?: ProcessingTransaction,
  ): Promise<void> {
    if (ctx.lost) throw new LeaseLostError();

    const run = async (client: Prisma.TransactionClient) => {
      const rows = await client.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "public"."ProcessingJob"
        WHERE "id" = ${ctx.jobId}
          AND "documentId" = ${ctx.documentId}
          AND "status" = 'RUNNING'
          AND "leaseOwner" = ${ctx.owner}
          AND "fencingToken" = ${ctx.token}
          AND "leaseUntil" IS NOT NULL
          AND "leaseUntil" > now()
        FOR SHARE
      `;
      if (rows.length === 0) {
        ctx.lost = true;
        throw new LeaseLostError();
      }
      await client.document.update({ where: { id: ctx.documentId }, data });
    };

    if (tx) {
      await run(tx);
      return;
    }
    await this.prisma.$transaction(run, { timeout: 15_000 });
  }

  async findOrphanDocumentIds(limit: number): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT d."id"
      FROM "public"."Document" d
      WHERE d."status" IN ('QUEUED', 'PROCESSING')
        AND NOT EXISTS (
          SELECT 1
          FROM "public"."ProcessingJob" j
          WHERE j."documentId" = d."id"
            AND j."status" IN ('QUEUED', 'RUNNING', 'RETRY_WAIT')
        )
      ORDER BY d."updatedAt" ASC
      LIMIT ${limit}::integer
    `;
    return rows.map(row => row.id);
  }

  createContext(job: ClaimedJob): JobContext {
    const ctx: JobContext = {
      jobId: job.id,
      documentId: job.documentId,
      owner: job.leaseOwner,
      token: job.fencingToken,
      lost: false,
      updateDocument: (data, tx) => this.fencedDocumentUpdate(ctx, data, tx),
    };
    return ctx;
  }
}

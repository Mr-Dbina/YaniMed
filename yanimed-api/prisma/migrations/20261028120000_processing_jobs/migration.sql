-- Additive processing-job queue with DB-backed leases and fencing tokens.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "public"."ProcessingJobStatus" AS ENUM (
    'QUEUED', 'RUNNING', 'RETRY_WAIT', 'SUCCEEDED', 'FAILED'
);

CREATE TABLE "public"."ProcessingJob" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "status" "public"."ProcessingJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 4,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProcessingJob_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProcessingJob_attempt_check" CHECK ("attempt" >= 0 AND "maxAttempts" > 0),
    CONSTRAINT "ProcessingJob_lease_check" CHECK (("leaseOwner" IS NULL) = ("leaseUntil" IS NULL))
);

CREATE INDEX "ProcessingJob_status_nextRunAt_idx" ON "public"."ProcessingJob"("status", "nextRunAt");
CREATE INDEX "ProcessingJob_documentId_idx" ON "public"."ProcessingJob"("documentId");

-- At most one active job per document. Prisma cannot model partial unique
-- indexes, so this definition is maintained manually and must stay in sync.
CREATE UNIQUE INDEX "ProcessingJob_documentId_active_key"
    ON "public"."ProcessingJob"("documentId")
    WHERE "status" IN ('QUEUED', 'RUNNING', 'RETRY_WAIT');

COMMIT;

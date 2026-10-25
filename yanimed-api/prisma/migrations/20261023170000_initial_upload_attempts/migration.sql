-- Additive upload-intent ledger; existing application data is untouched.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TYPE "public"."UploadAttemptStatus" AS ENUM (
    'PENDING', 'UPLOADING', 'AWAITING_RETRY', 'CLEANUP_PENDING', 'UPLOADED'
);

CREATE TABLE "public"."UploadAttempt" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "documentId" TEXT,
    "objectKey" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "fileSha256" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL,
    "status" "public"."UploadAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "etag" TEXT,
    "lastError" TEXT,
    "leaseOwner" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "UploadAttempt_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "UploadAttempt_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UploadAttempt_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "UploadAttempt_file_check" CHECK ("fileSize" > 0 AND "fileSize" <= 268435456 AND "pageCount" > 0),
    CONSTRAINT "UploadAttempt_hash_check" CHECK ("fileSha256" ~ '^[0-9a-f]{64}$' AND "requestHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "UploadAttempt_lease_check" CHECK (("leaseOwner" IS NULL) = ("leaseUntil" IS NULL)),
    CONSTRAINT "UploadAttempt_receipt_check" CHECK ("status" <> 'UPLOADED' OR "documentId" IS NOT NULL)
);
CREATE UNIQUE INDEX "UploadAttempt_idempotencyKey_key" ON "public"."UploadAttempt"("idempotencyKey");
CREATE UNIQUE INDEX "UploadAttempt_subjectId_key" ON "public"."UploadAttempt"("subjectId");
CREATE UNIQUE INDEX "UploadAttempt_documentId_key" ON "public"."UploadAttempt"("documentId");
CREATE UNIQUE INDEX "UploadAttempt_objectKey_key" ON "public"."UploadAttempt"("objectKey");
CREATE INDEX "UploadAttempt_status_nextAttemptAt_idx" ON "public"."UploadAttempt"("status", "nextAttemptAt");
CREATE INDEX "UploadAttempt_leaseUntil_idx" ON "public"."UploadAttempt"("leaseUntil");
COMMIT;

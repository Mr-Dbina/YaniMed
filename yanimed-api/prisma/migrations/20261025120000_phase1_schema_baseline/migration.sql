-- Additive Phase 1 schema baseline. Original PDFs and prior data are preserved.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

ALTER TYPE "public"."DocumentStatus" RENAME VALUE 'UPLOADED' TO 'QUEUED';

CREATE TYPE "public"."SubjectStatus" AS ENUM ('ACTIVE', 'DELETING');
CREATE TYPE "public"."DeletionStage" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'FAILED');

ALTER TABLE "public"."Document"
    ADD COLUMN "pdfObjectId" TEXT;

ALTER TABLE "public"."Subject"
    ADD COLUMN "deletedAt" TIMESTAMP(3),
    ADD COLUMN "status" "public"."SubjectStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE TABLE "public"."PdfObject" (
    "id" TEXT NOT NULL,
    "sha256" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PdfObject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "public"."DeletionJob" (
    "id" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "stage" "public"."DeletionStage" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeletionJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PdfObject_sha256_key" ON "public"."PdfObject"("sha256");
CREATE UNIQUE INDEX "PdfObject_r2Key_key" ON "public"."PdfObject"("r2Key");
CREATE INDEX "DeletionJob_subjectId_idx" ON "public"."DeletionJob"("subjectId");
CREATE INDEX "DeletionJob_stage_idx" ON "public"."DeletionJob"("stage");
CREATE UNIQUE INDEX "Subject_name_key" ON "public"."Subject"("name");

ALTER TABLE "public"."Document"
    ADD CONSTRAINT "Document_pdfObjectId_fkey"
    FOREIGN KEY ("pdfObjectId") REFERENCES "public"."PdfObject"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "public"."DeletionJob"
    ADD CONSTRAINT "DeletionJob_subjectId_fkey"
    FOREIGN KEY ("subjectId") REFERENCES "public"."Subject"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "public"."Document"
    ALTER COLUMN "status" SET DEFAULT 'QUEUED';

COMMIT;

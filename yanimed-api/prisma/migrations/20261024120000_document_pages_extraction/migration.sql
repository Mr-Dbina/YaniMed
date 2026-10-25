-- Additive page-level extraction persistence. Original PDFs remain in R2.
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block.
ALTER TYPE "public"."ExtractionMethod" ADD VALUE IF NOT EXISTS 'HYBRID';

BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "public"."DocumentPage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "extractionMethod" "public"."ExtractionMethod" NOT NULL DEFAULT 'TEXT',
    "needsOcr" BOOLEAN NOT NULL DEFAULT false,
    "ocrUsed" BOOLEAN NOT NULL DEFAULT false,
    "ocrError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DocumentPage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "DocumentPage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "public"."Document"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DocumentPage_page_check" CHECK ("pageNumber" > 0),
    CONSTRAINT "DocumentPage_char_count_check" CHECK ("charCount" >= 0)
);

CREATE UNIQUE INDEX "DocumentPage_documentId_pageNumber_key" ON "public"."DocumentPage"("documentId", "pageNumber");
CREATE INDEX "DocumentPage_documentId_idx" ON "public"."DocumentPage"("documentId");
CREATE INDEX "DocumentPage_documentId_pageNumber_idx" ON "public"."DocumentPage"("documentId", "pageNumber");
COMMIT;

-- Enforce one Document per (Subject, PdfObject) without disallowing null pdfObjectId.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL statement_timeout = '60s';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "public"."Document"
        WHERE "pdfObjectId" IS NOT NULL
        GROUP BY "subjectId", "pdfObjectId"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Cannot add Document_subjectId_pdfObjectId_key: duplicate (subjectId, pdfObjectId) rows exist';
    END IF;
END $$;

CREATE UNIQUE INDEX "Document_subjectId_pdfObjectId_key"
    ON "public"."Document"("subjectId", "pdfObjectId");

COMMIT;

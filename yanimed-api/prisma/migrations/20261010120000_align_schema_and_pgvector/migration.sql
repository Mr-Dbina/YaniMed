-- Aligns the live database with schema.prisma and folds the previously
-- unmanaged prisma/migration.sql into real migration history.
--
-- Every statement is guarded so this migration is idempotent: it applies
-- cleanly to the current Supabase database (where the pgvector objects were
-- created by hand and are therefore NOT tracked in migration history) and to
-- a fresh database built from scratch off the migrations directory.
--
-- The `vector`/`tsvector` columns and their indexes are declared as
-- Unsupported() in schema.prisma, so Prisma cannot model them and would
-- otherwise emit DROP INDEX for chunk_embedding_idx / chunk_tsv_idx.

-- pgvector must exist before any vector(768) column can be declared.
CREATE EXTENSION IF NOT EXISTS vector;

-- Enums. Undefined on the live database; may already exist on a fresh one.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ExtractionMethod') THEN
        CREATE TYPE "ExtractionMethod" AS ENUM ('TEXT', 'OCR');
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AnswerMode') THEN
        CREATE TYPE "AnswerMode" AS ENUM ('GENERATED', 'RETRIEVAL_ONLY', 'NOT_FOUND');
    END IF;
END
$$;

-- Chunk: retrieval columns. embedding/tsv are hand-managed vector objects.
ALTER TABLE "Chunk"
    ADD COLUMN IF NOT EXISTS "embedding" vector(768),
    ADD COLUMN IF NOT EXISTS "tsv" tsvector,
    ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT,
    ADD COLUMN IF NOT EXISTS "extractionMethod" "ExtractionMethod" NOT NULL DEFAULT 'TEXT',
    ADD COLUMN IF NOT EXISTS "needsReview" BOOLEAN NOT NULL DEFAULT false;

-- Document: resumable-ingestion counters.
ALTER TABLE "Document"
    ADD COLUMN IF NOT EXISTS "processedPages" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "embeddedChunks" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS "ocrPages" INTEGER NOT NULL DEFAULT 0;

-- Message: replace the flat citedChapter/citedPage/notFoundInReviewer triple
-- with proper citation rows, and record which OmniRoute model answered.
ALTER TABLE "Message"
    DROP COLUMN IF EXISTS "citedChapter",
    DROP COLUMN IF EXISTS "citedPage",
    DROP COLUMN IF EXISTS "notFoundInReviewer",
    ADD COLUMN IF NOT EXISTS "answerMode" "AnswerMode",
    ADD COLUMN IF NOT EXISTS "provider" TEXT,
    ADD COLUMN IF NOT EXISTS "model" TEXT;

-- Backend-verified citation snapshots (survive chunk re-processing).
CREATE TABLE IF NOT EXISTS "MessageCitation" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "chunkId" TEXT,
    "page" INTEGER NOT NULL,
    "chapter" TEXT,

    CONSTRAINT "MessageCitation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "MessageCitation_messageId_idx" ON "MessageCitation"("messageId");
CREATE INDEX IF NOT EXISTS "MessageCitation_documentId_page_idx" ON "MessageCitation"("documentId", "page");

-- Makes chunk re-processing idempotent so a resumed ingest cannot duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS "Chunk_documentId_chunkIndex_key" ON "Chunk"("documentId", "chunkIndex");

-- Keep tsv in sync with content so keyword search never goes stale.
CREATE OR REPLACE FUNCTION chunk_tsv_update() RETURNS trigger AS $$
BEGIN
    NEW.tsv := to_tsvector('english', NEW.content);
    RETURN NEW;
END
$$ LANGUAGE plpgsql;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'chunk_tsv_trigger') THEN
        CREATE TRIGGER chunk_tsv_trigger
            BEFORE INSERT OR UPDATE OF content ON "Chunk"
            FOR EACH ROW EXECUTE FUNCTION chunk_tsv_update();
    END IF;
END
$$;

-- Hybrid-search indexes: ivfflat for cosine similarity, GIN for tsvector.
-- lists=100 is sized for roughly 100k chunks; revisit (lists ~= rows/1000)
-- if the corpus grows well past that, and REINDEX after large ingests.
DROP INDEX IF EXISTS chunk_embedding_idx;
CREATE INDEX chunk_embedding_idx ON "Chunk"
    USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX IF NOT EXISTS chunk_tsv_idx ON "Chunk" USING gin (tsv);

-- Foreign keys for the new citation table.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageCitation_messageId_fkey') THEN
        ALTER TABLE "MessageCitation" ADD CONSTRAINT "MessageCitation_messageId_fkey"
            FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageCitation_documentId_fkey') THEN
        ALTER TABLE "MessageCitation" ADD CONSTRAINT "MessageCitation_documentId_fkey"
            FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'MessageCitation_chunkId_fkey') THEN
        ALTER TABLE "MessageCitation" ADD CONSTRAINT "MessageCitation_chunkId_fkey"
            FOREIGN KEY ("chunkId") REFERENCES "Chunk"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;
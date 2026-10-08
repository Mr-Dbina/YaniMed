-- Run this AFTER `prisma migrate dev` has created the Document/Chunk tables.
-- Prisma has no native `vector` or `tsvector` type, so these are added by hand
-- and tracked as a manual migration (prisma migrate dev --create-only, then
-- paste this in, or run directly via `prisma db execute`).

-- 1. Enable pgvector (Supabase has this available, just needs enabling once)
CREATE EXTENSION IF NOT EXISTS vector;

-- 2. Add the embedding column
-- 768 = Gemini text-embedding-004 default output dimension
ALTER TABLE "Chunk" ADD COLUMN embedding vector(768);

-- 3. Add the full-text search column
ALTER TABLE "Chunk" ADD COLUMN tsv tsvector;

-- 4. Keep tsv in sync automatically whenever content changes
CREATE FUNCTION chunk_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.tsv := to_tsvector('english', NEW.content);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER chunk_tsv_trigger
  BEFORE INSERT OR UPDATE OF content ON "Chunk"
  FOR EACH ROW EXECUTE FUNCTION chunk_tsv_update();

-- 5. Indexes for hybrid search
-- IVFFlat for vector similarity (good default; switch to HNSW later if pgvector
-- version on Supabase supports it and recall/speed needs tuning)
CREATE INDEX chunk_embedding_idx ON "Chunk"
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- GIN index for full-text keyword search
CREATE INDEX chunk_tsv_idx ON "Chunk" USING gin (tsv);

-- Note on `lists = 100`: this is a starting value for IVFFlat, reasonable up to
-- ~100k rows. If your chunk count grows well beyond that, revisit this number
-- (rule of thumb: lists ≈ rows / 1000, recompute the index after large ingests).

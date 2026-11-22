-- Add embedding and embeddingModel to MockQuestion
ALTER TABLE "MockQuestion" ADD COLUMN IF NOT EXISTS "embedding" vector(768);
ALTER TABLE "MockQuestion" ADD COLUMN IF NOT EXISTS "embeddingModel" TEXT;

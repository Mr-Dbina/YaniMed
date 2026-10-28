import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { isTransientNetworkError } from '../document-processing/processing-error.js';
import { LeaseLostError, type JobContext } from '../document-processing/processing-job.types.js';

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;

type EmbeddingErrorCode = 'EMBEDDING_TRANSIENT' | 'EMBEDDING_PERMANENT';

function tagEmbeddingError(error: unknown, code: EmbeddingErrorCode): Error {
  if (error instanceof Error) {
    (error as Error & { code?: string }).code = code;
    return error;
  }
  const wrapped = new Error(String(error));
  (wrapped as Error & { code?: string }).code = code;
  return wrapped;
}

function embeddingError(message: string, code: EmbeddingErrorCode): Error {
  return tagEmbeddingError(new Error(message), code);
}

export interface EmbeddingResult {
  documentId: string;
  totalChunks: number;
  embeddedChunks: number;
  skippedChunks: number;
  failedChunks: number;
}

export interface EmbeddingIntegrityResult {
  totalChunks: number;
  embeddedChunks: number;
  missingChunks: string[];
  invalidDimensionChunks: string[];
  modelMismatchChunks: string[];
  isComplete: boolean;
}

export interface EmbeddingServiceOptions {
  requestsPerMinute?: number;
  maxAttempts?: number;
}

@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private readonly apiKey: string | undefined;
  private readonly requestsPerMinute: number;
  private readonly maxAttempts: number;
  private lastRequestAt = 0;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    @Optional() private readonly prisma?: PrismaService,
    @Optional() private readonly options?: EmbeddingServiceOptions,
  ) {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.requestsPerMinute = this.options?.requestsPerMinute ?? 60;
    this.maxAttempts = this.options?.maxAttempts ?? 5;
  }

  private async withDocumentLock<T>(documentId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(documentId) ?? Promise.resolve();
    let resolveLock!: () => void;
    const current = new Promise<void>(resolve => { resolveLock = resolve; });
    const lockPromise = previous.then(() => current);
    this.locks.set(documentId, lockPromise);
    try {
      await previous;
      return await work();
    } finally {
      resolveLock();
      if (this.locks.get(documentId) === lockPromise) {
        this.locks.delete(documentId);
      }
    }
  }

  async embedText(text: string, taskType?: string): Promise<number[]> {
    if (!this.apiKey) throw embeddingError('GEMINI_API_KEY is not configured.', 'EMBEDDING_PERMANENT');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${this.apiKey}`;
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        await this.waitForRateLimit();
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: `models/${EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            outputDimensionality: EMBEDDING_DIMENSIONS,
            ...(taskType ? { taskType } : {}),
          }),
        });
        if (!response.ok) {
          const body = await response.text();
          if (response.status === 429 || response.status >= 500) {
            lastError = embeddingError(`Gemini embedding request failed (${response.status}): ${body}`, 'EMBEDDING_TRANSIENT');
            await this.sleep(this.backoff(attempt) + this.jitter());
            continue;
          }
          throw embeddingError(`Gemini embedding request failed (${response.status}): ${body}`, 'EMBEDDING_PERMANENT');
        }
        const json = (await response.json()) as { embedding?: { values?: unknown } };
        const values = json?.embedding?.values;
        if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
          throw embeddingError(`Gemini embedding returned ${Array.isArray(values) ? values.length : 'invalid'} dimensions; expected ${EMBEDDING_DIMENSIONS}.`, 'EMBEDDING_PERMANENT');
        }
        if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) {
          throw embeddingError('Gemini embedding returned non-finite values.', 'EMBEDDING_PERMANENT');
        }
        return values as number[];
      } catch (error) {
        lastError = isTransientNetworkError(error)
          ? tagEmbeddingError(error, 'EMBEDDING_TRANSIENT')
          : error;
        if (attempt === this.maxAttempts - 1) break;
        if (error instanceof Error && /Gemini embedding request failed \([4]/.test(error.message)) {
          throw error;
        }
        await this.sleep(this.backoff(attempt) + this.jitter());
      }
    }
    throw lastError instanceof Error
      ? lastError
      : embeddingError('Gemini embedding request failed.', 'EMBEDDING_TRANSIENT');
  }

  async embedDocument(documentId: string, ctx?: JobContext): Promise<EmbeddingResult> {
    if (!this.prisma) throw new Error('PrismaService is not available.');
    return this.withDocumentLock(documentId, async () => {
      const document = await this.prisma!.document.findUnique({
        where: { id: documentId },
        include: { chunks: { orderBy: { chunkIndex: 'asc' } } },
      });
      if (!document) throw new NotFoundException(`Document ${documentId} not found.`);

      const writeDocument = (data: Prisma.DocumentUpdateInput) =>
        ctx
          ? ctx.updateDocument(data)
          : this.prisma!.document.update({ where: { id: document.id }, data });

      await writeDocument({ status: 'PROCESSING', errorMessage: null });

      let embeddedChunks = 0;
      let skippedChunks = 0;
      const failures: unknown[] = [];
      for (const chunk of document.chunks) {
        if (ctx?.lost) throw new LeaseLostError();
        try {
          if (await this.hasValidEmbedding(chunk.id)) {
            skippedChunks += 1;
            embeddedChunks += 1;
            continue;
          }
          const vector = await this.embedText(chunk.content);
          if (ctx?.lost) throw new LeaseLostError();
          await this.persistEmbedding(chunk.id, vector);
          embeddedChunks += 1;
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          failures.push(error);
        }
      }

      const failedChunks = failures.length;
      const firstFailure = failures[0];
      const firstFailureMessage = firstFailure instanceof Error ? firstFailure.message : String(firstFailure);
      if (ctx?.lost) throw new LeaseLostError();
      await writeDocument({
        embeddedChunks,
        status: failedChunks > 0 ? 'FAILED' : 'PROCESSING',
        errorMessage: failedChunks > 0 ? firstFailureMessage : null,
      });

      if (failedChunks > 0) {
        if (firstFailure instanceof Error) throw firstFailure;
        throw new Error(String(firstFailure));
      }

      return {
        documentId: document.id,
        totalChunks: document.chunks.length,
        embeddedChunks,
        skippedChunks,
        failedChunks,
      };
    });
  }

  async verifyDocumentEmbeddings(documentId: string): Promise<EmbeddingIntegrityResult> {
    if (!this.prisma) throw new Error('PrismaService is not available.');
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; has_embedding: boolean; dims: number | null; model: string | null }>
    >`
      SELECT "id",
             ("embedding" IS NOT NULL) AS has_embedding,
             CASE WHEN "embedding" IS NULL THEN NULL ELSE vector_dims("embedding") END AS dims,
             "embeddingModel" AS model
      FROM "Chunk"
      WHERE "documentId" = ${documentId}
    `;
    const missingChunks: string[] = [];
    const invalidDimensionChunks: string[] = [];
    const modelMismatchChunks: string[] = [];
    let embeddedChunks = 0;
    for (const row of rows) {
      if (!row.has_embedding) {
        missingChunks.push(row.id);
        continue;
      }
      embeddedChunks += 1;
      if (row.dims !== EMBEDDING_DIMENSIONS) invalidDimensionChunks.push(row.id);
      if (row.model !== EMBEDDING_MODEL) modelMismatchChunks.push(row.id);
    }
    return {
      totalChunks: rows.length,
      embeddedChunks,
      missingChunks,
      invalidDimensionChunks,
      modelMismatchChunks,
      isComplete:
        rows.length > 0 &&
        missingChunks.length === 0 &&
        invalidDimensionChunks.length === 0 &&
        modelMismatchChunks.length === 0,
    };
  }

  private async hasValidEmbedding(chunkId: string): Promise<boolean> {
    const rows = await this.prisma!.$queryRaw<Array<{ has_embedding: boolean; model: string | null }>>`
      SELECT ("embedding" IS NOT NULL) AS has_embedding, "embeddingModel" AS model
      FROM "Chunk"
      WHERE "id" = ${chunkId}
    `;
    return rows[0]?.has_embedding === true && rows[0]?.model === EMBEDDING_MODEL;
  }

  private async persistEmbedding(chunkId: string, vector: number[]): Promise<void> {
    const literal = `[${vector.join(',')}]`;
    await this.prisma!.$executeRaw`
      UPDATE "Chunk"
      SET "embedding" = ${literal}::vector,
          "embeddingModel" = ${EMBEDDING_MODEL}
      WHERE "id" = ${chunkId}
    `;
  }

  private async waitForRateLimit(): Promise<void> {
    const minInterval = Math.ceil(60000 / this.requestsPerMinute);
    const now = Date.now();
    const wait = this.lastRequestAt + minInterval - now;
    if (wait > 0) await this.sleep(wait);
    this.lastRequestAt = Date.now();
  }

  private backoff(attempt: number): number {
    return Math.min(30000, 1000 * 2 ** attempt);
  }

  private jitter(): number {
    return Math.floor(Math.random() * 250);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { EmbeddingService as GeminiEmbeddingService };

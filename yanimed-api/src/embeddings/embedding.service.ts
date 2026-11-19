import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { isTransientNetworkError } from '../document-processing/processing-error.js';
import { LeaseLostError, type JobContext } from '../document-processing/processing-job.types.js';

export const EMBEDDING_MODEL = 'gemini-embedding-001';
export const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_REQUEST_TIMEOUT_MS = 30_000;
const EMBEDDING_PROGRESS_EVERY = 25;

type EmbeddingErrorCode =
  | 'EMBEDDING_TRANSIENT'
  | 'EMBEDDING_PERMANENT'
  | 'EMBEDDING_QUOTA_EXHAUSTED';

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}

function parseRetryDelaySeconds(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

/**
 * A 429 is per-day when any QuotaFailure violation names a PerDay quota, or
 * when RetryInfo asks for a wait longer than a minute. The body is untrusted:
 * any parse failure means "not per-day" and the caller retries as before.
 */
function perDayQuotaRetryAfterSec(
  body: string,
  retryAfterMs: number | null,
): { retryAfterSec: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const root = isRecord(parsed) ? parsed : null;
  const error = root && isRecord(root.error) ? root.error : root;
  if (!error || !Array.isArray(error.details)) return null;

  let perDay = false;
  let retryDelaySec: number | null = null;
  for (const detail of error.details) {
    if (!isRecord(detail)) continue;
    if (Array.isArray(detail.violations)) {
      for (const violation of detail.violations) {
        if (
          isRecord(violation) &&
          typeof violation.quotaId === 'string' &&
          violation.quotaId.includes('PerDay')
        ) {
          perDay = true;
        }
      }
    }
    const parsedDelay = parseRetryDelaySeconds(detail.retryDelay);
    if (parsedDelay !== null) retryDelaySec = parsedDelay;
  }

  if (!perDay && (retryDelaySec === null || retryDelaySec <= 60)) return null;

  const retryAfterSec =
    retryDelaySec ??
    (retryAfterMs === null ? null : Math.ceil(retryAfterMs / 1000));
  return { retryAfterSec };
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  );
}

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
          signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
        });
        if (!response.ok) {
          const body = await response.text();
          if (response.status === 429 || response.status >= 500) {
            const retryAfter =
              response.status === 429 ? this.retryAfterMs(response) : null;
            if (response.status === 429) {
              const quota = perDayQuotaRetryAfterSec(body, retryAfter);
              if (quota !== null) {
                this.logger.warn(
                  `embedding.quota_exhausted ${JSON.stringify({ retryAfterSec: quota.retryAfterSec })}`,
                );
                throw embeddingError(
                  'Gemini embedding daily quota exhausted.',
                  'EMBEDDING_QUOTA_EXHAUSTED',
                );
              }
            }
            lastError = embeddingError(`Gemini embedding request failed (${response.status}): ${body}`, 'EMBEDDING_TRANSIENT');
            const waitMs = retryAfter ?? this.backoff(attempt) + this.jitter();
            if (response.status === 429) {
              this.logger.warn(
                `embedding.rate_limited ${JSON.stringify({ attempt: attempt + 1, waitMs })}`,
              );
            }
            await this.sleep(waitMs);
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
        if (
          typeof error === 'object' &&
          error !== null &&
          (error as { code?: unknown }).code === 'EMBEDDING_QUOTA_EXHAUSTED'
        ) {
          throw error;
        }
        lastError = isTransientNetworkError(error) || isAbortError(error)
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

      const total = document.chunks.length;
      const alreadyEmbedded = document.chunks.filter(
        chunk => chunk.embeddingModel === EMBEDDING_MODEL,
      ).length;
      this.logger.log(
        `embedding.started ${JSON.stringify({ documentId, total, alreadyEmbedded })}`,
      );

      let embeddedChunks = 0;
      let skippedChunks = 0;
      let done = 0;
      const failures: unknown[] = [];
      for (const chunk of document.chunks) {
        if (ctx?.lost) throw new LeaseLostError();
        try {
          if (await this.hasValidEmbedding(chunk.id)) {
            skippedChunks += 1;
            embeddedChunks += 1;
          } else {
            const vector = await this.embedText(chunk.content);
            if (ctx?.lost) throw new LeaseLostError();
            await this.persistEmbedding(chunk.id, vector);
            embeddedChunks += 1;
          }
        } catch (error) {
          if (error instanceof LeaseLostError) throw error;
          failures.push(error);
        }

        done += 1;
        if (done % EMBEDDING_PROGRESS_EVERY === 0) {
          await writeDocument({ embeddedChunks });
          this.logger.log(
            `embedding.progress ${JSON.stringify({ done, total, failures: failures.length })}`,
          );
        }
      }

      this.logger.log(
        `embedding.finished ${JSON.stringify({ done, failures: failures.length })}`,
      );

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

  private retryAfterMs(response: { headers?: { get(name: string): string | null } }): number | null {
    const raw = response.headers?.get('Retry-After')?.trim();
    if (!raw) return null;
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(60_000, Math.round(seconds * 1000));
    }
    const at = Date.parse(raw);
    if (Number.isFinite(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
    return null;
  }

  private jitter(): number {
    return Math.floor(Math.random() * 250);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

export { EmbeddingService as GeminiEmbeddingService };

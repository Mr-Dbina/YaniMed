import { Inject, Injectable, Optional } from '@nestjs/common';
import type { AiCallPurpose } from '@prisma/client';
import {
  EmbeddingService,
  EMBEDDING_MODEL,
} from '../../../embeddings/embedding.service.js';
import {
  AI_CALL_RETRIES,
  AI_CALL_TIMEOUT_MS,
  AI_CALLS_PER_JOB,
  AI_DAILY_BUDGET,
  AI_RETRY_BACKOFF_MS,
} from '../generation.constants.js';
import { GenerationError } from '../generation.errors.js';
import { GenerationJobRepository } from '../generation-job.repository.js';
import { AiCallLogRepository, manilaDayStart } from './ai-call-log.repository.js';
import { CircuitBreaker } from './circuit-breaker.js';

export const GENERATION_AI_OPTIONS = 'GENERATION_AI_OPTIONS';

const MAX_ATTEMPTS = AI_CALL_RETRIES + 1;
const MAX_JITTER_MS = 250;
const MAX_RETRY_AFTER_MS = 120_000;

export type GenerationAiPurpose = Extract<
  AiCallPurpose,
  'PLAN' | 'DRAFT' | 'VERIFY'
>;

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompleteInput {
  purpose: GenerationAiPurpose;
  jobId: string;
  subjectId?: string;
  messages: readonly AiMessage[];
  temperature?: number;
  jsonMode?: boolean;
  signal?: AbortSignal;
}

export interface CompleteResult {
  text: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
}

export interface EmbedInput {
  jobId: string;
  text: string;
}

export interface AiHttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type AiFetch = (
  url: string,
  init: RequestInit,
) => Promise<AiHttpResponse>;

export interface GenerationAiConfig {
  baseUrl: string;
  apiKey: string;
  primaryModel: string;
  verifierModel: string | null;
}

export interface GenerationAiOptions {
  /** Overrides the env-derived config. Tests use this. */
  config?: GenerationAiConfig;
  fetchImpl?: AiFetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  breaker?: CircuitBreaker;
  /** Test hook; production uses AI_CALL_TIMEOUT_MS. */
  timeoutMs?: number;
}

export function readGenerationAiConfig(
  env: NodeJS.ProcessEnv = process.env,
): GenerationAiConfig {
  return {
    baseUrl: (env.OMNIROUTE_BASE_URL ?? '')
      .trim()
      .replace(/\/+$/, '')
      .replace(/\/v1$/, ''),
    apiKey: env.OMNIROUTE_API_KEY ?? '',
    primaryModel: (env.OMNIROUTE_PRIMARY_MODEL ?? '').trim(),
    verifierModel: env.OMNIROUTE_VERIFIER_MODEL?.trim() || null,
  };
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/** Retry-After is either delta-seconds or an HTTP date. */
function parseRetryAfter(
  value: string | null,
  now: number,
): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(value);
  if (!Number.isNaN(date)) {
    return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
  }
  return null;
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Generation AI call aborted.');
  error.name = 'AbortError';
  return error;
}

/**
 * Single gateway for every M5 generation call. Owns the budgets, retries,
 * breaker, verifier model and the AiCallLog rows; callers only see text or a
 * stable GenerationError code.
 */
@Injectable()
export class GenerationAiService {
  private readonly config: GenerationAiConfig;
  private readonly fetchImpl: AiFetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly jobRepository: GenerationJobRepository,
    private readonly callLogs: AiCallLogRepository,
    @Optional() private readonly embeddings?: EmbeddingService,
    @Optional()
    @Inject(GENERATION_AI_OPTIONS)
    options: GenerationAiOptions = {},
  ) {
    this.config = options.config ?? readGenerationAiConfig();
    this.fetchImpl =
      options.fetchImpl ??
      ((url, init) => fetch(url, init) as unknown as Promise<AiHttpResponse>);
    this.now = options.now ?? (() => Date.now());
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? AI_CALL_TIMEOUT_MS;
    this.breaker =
      options.breaker ?? new CircuitBreaker(this.now);
  }

  /**
   * VERIFY must never fall back to the primary model: that would let the
   * generator grade its own work.
   */
  assertReady(): void {
    if (
      !this.config.verifierModel ||
      this.config.verifierModel === this.config.primaryModel
    ) {
      throw new GenerationError('GENERATION_VERIFIER_NOT_CONFIGURED');
    }
  }

  async complete(input: CompleteInput): Promise<CompleteResult> {
    if (input.signal?.aborted) throw abortReason(input.signal);

    const model =
      input.purpose === 'VERIFY'
        ? this.resolveVerifier()
        : this.config.primaryModel;
    if (!this.config.baseUrl || !this.config.apiKey || !model) {
      throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
        jobId: input.jobId,
      });
    }

    const url = `${this.config.baseUrl}/v1/chat/completions`;
    const body = JSON.stringify({
      model,
      messages: input.messages,
      temperature: input.temperature ?? 0,
      stream: false,
      ...(input.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    });

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (input.signal?.aborted) throw abortReason(input.signal);

      const gate = this.breaker.gate();
      if (!gate.allowed) {
        throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
          jobId: input.jobId,
          details: { breakerOpen: 1 },
        });
      }
      await this.reserveBudget(input.jobId, gate);

      const startedAt = this.now();
      const timed = this.withTimeout(input.signal);
      let response: AiHttpResponse;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body,
          signal: timed.signal,
        });
      } catch {
        timed.clear();
        const latencyMs = this.now() - startedAt;
        if (input.signal?.aborted) {
          await this.log(input.jobId, input.purpose, model, null, null, latencyMs, 'ABORTED', 'ABORTED');
          throw abortReason(input.signal);
        }
        const timedOut = timed.timedOut();
        const errorCode = timedOut ? 'TIMEOUT' : 'NETWORK_ERROR';
        await this.log(input.jobId, input.purpose, model, null, null, latencyMs, errorCode, errorCode);
        this.breaker.recordFailure();
        if (attempt === MAX_ATTEMPTS - 1) {
          throw new GenerationError(
            timedOut ? 'GENERATION_AI_TIMEOUT' : 'GENERATION_PROVIDER_UNAVAILABLE',
            { jobId: input.jobId, details: { attempts: attempt + 1 } },
          );
        }
        await this.sleep(this.backoff(attempt));
        continue;
      }
      timed.clear();
      const latencyMs = this.now() - startedAt;

      if (!response.ok) {
        const errorCode = `HTTP_${response.status}`;
        await this.log(
          input.jobId,
          input.purpose,
          model,
          null,
          null,
          latencyMs,
          response.status === 429 ? 'RATE_LIMITED' : 'HTTP_ERROR',
          errorCode,
        );
        this.breaker.recordFailure();

        if (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS - 1) {
          throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
            jobId: input.jobId,
            details: { status: response.status },
          });
        }
        const retryAfter = parseRetryAfter(
          response.headers.get('retry-after'),
          this.now(),
        );
        await this.sleep(retryAfter ?? this.backoff(attempt));
        continue;
      }

      let payload: {
        model?: unknown;
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: {
          prompt_tokens?: unknown;
          completion_tokens?: unknown;
        };
      };
      let text: unknown;
      try {
        payload = (await response.json()) as typeof payload;
        text = payload.choices?.[0]?.message?.content;
      } catch {
        payload = {};
        text = undefined;
      }
      if (typeof text !== 'string' || text.trim().length === 0) {
        await this.log(
          input.jobId,
          input.purpose,
          model,
          null,
          null,
          latencyMs,
          'INVALID_RESPONSE',
          'INVALID_RESPONSE',
        );
        this.breaker.recordFailure();
        throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
          jobId: input.jobId,
        });
      }

      const tokensIn = tokenCount(payload.usage?.prompt_tokens);
      const tokensOut = tokenCount(payload.usage?.completion_tokens);
      await this.log(
        input.jobId,
        input.purpose,
        model,
        tokensIn,
        tokensOut,
        latencyMs,
        'SUCCESS',
        null,
      );
      this.breaker.recordSuccess();

      return {
        text,
        model:
          typeof payload.model === 'string' && payload.model.length > 0
            ? payload.model
            : model,
        tokensIn,
        tokensOut,
        latencyMs,
      };
    }

    throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
      jobId: input.jobId,
      details: { attempts: MAX_ATTEMPTS },
    });
  }

  async embed(input: EmbedInput): Promise<number[]> {
    if (!this.embeddings) {
      throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
        jobId: input.jobId,
      });
    }

    const gate = this.breaker.gate();
    if (!gate.allowed) {
      throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
        jobId: input.jobId,
        details: { breakerOpen: 1 },
      });
    }
    await this.reserveBudget(input.jobId, gate);

    const startedAt = this.now();
    try {
      const vector = await this.embeddings.embedText(input.text);
      const latencyMs = this.now() - startedAt;
      await this.log(
        input.jobId,
        'EMBED',
        EMBEDDING_MODEL,
        null,
        null,
        latencyMs,
        'SUCCESS',
        null,
      );
      this.breaker.recordSuccess();
      return vector;
    } catch {
      const latencyMs = this.now() - startedAt;
      await this.log(
        input.jobId,
        'EMBED',
        EMBEDDING_MODEL,
        null,
        null,
        latencyMs,
        'ERROR',
        'EMBEDDING_FAILED',
      );
      this.breaker.recordFailure();
      throw new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
        jobId: input.jobId,
      });
    }
  }

  private resolveVerifier(): string {
    // The guard runs before any network or budget effect.
    this.assertReady();
    return this.config.verifierModel!;
  }

  /**
   * Daily check first (read-only), then the atomic per-job reservation so a
   * rejected attempt never inflates the job counter.
   */
  private async reserveBudget(
    jobId: string,
    gate: { probe: boolean },
  ): Promise<void> {
    try {
      const usedToday = await this.callLogs.countSince(manilaDayStart(this.now()));
      if (usedToday >= AI_DAILY_BUDGET) {
        throw new GenerationError('GENERATION_BUDGET_EXHAUSTED', {
          jobId,
          details: { limit: AI_DAILY_BUDGET },
        });
      }

      const usedForJob = await this.jobRepository.reserveAiCall(
        jobId,
        AI_CALLS_PER_JOB,
      );
      if (usedForJob === null) {
        throw new GenerationError('GENERATION_BUDGET_EXHAUSTED', {
          jobId,
          details: { limit: AI_CALLS_PER_JOB },
        });
      }
    } catch (error) {
      if (gate.probe) this.breaker.releaseProbe();
      throw error;
    }
  }

  private async log(
    jobId: string,
    purpose: AiCallPurpose,
    model: string,
    promptTokens: number | null,
    completionTokens: number | null,
    latencyMs: number,
    outcome: string,
    errorCode: string | null,
  ): Promise<void> {
    // Never pass prompt or completion text through this path.
    await this.callLogs.insert({
      jobId,
      purpose,
      model,
      promptTokens,
      completionTokens,
      latencyMs,
      outcome,
      errorCode,
    });
  }

  private backoff(attempt: number): number {
    const base = AI_RETRY_BACKOFF_MS[attempt] ?? AI_RETRY_BACKOFF_MS[0];
    return base + Math.floor(this.random() * MAX_JITTER_MS);
  }

  private withTimeout(caller?: AbortSignal): {
    signal: AbortSignal;
    timedOut: () => boolean;
    clear: () => void;
  } {
    const controller = new AbortController();
    let timedOut = false;
    if (caller?.aborted) controller.abort(caller.reason);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = () => controller.abort(caller?.reason);
    caller?.addEventListener('abort', onAbort, { once: true });

    return {
      signal: controller.signal,
      timedOut: () => timedOut,
      clear: () => {
        clearTimeout(timer);
        caller?.removeEventListener('abort', onAbort);
      },
    };
  }
}

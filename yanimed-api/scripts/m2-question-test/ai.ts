import type { ChatMessage } from './prompts.js';
import { redactSecret, sleep } from './text.js';
import type { AiCallCounts, FailureCounts } from './types.js';

// Spec 9: limits shared by chat and embedding calls.
const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_AI_CALLS = 500;
const MAX_RETRIES = 3;
const BACKOFF_MS = [2_000, 4_000, 8_000];
const BREAKER_FAILURES = 5;
const BREAKER_COOLDOWN_MS = 60_000;
const RATE_LIMIT_DEFAULT_WAIT_MS = 30_000;
const RATE_LIMIT_MAX_WAIT_MS = 120_000;
export const WATCHDOG_TIMEOUT_MS = 5 * 60_000;

const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 768;
const EMBEDDING_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export type AiPurpose = 'topic' | 'draft' | 'verify' | 'embed';

export class AiCapReachedError extends Error {
  constructor() {
    super(`AI call cap of ${MAX_AI_CALLS} reached.`);
    this.name = 'AiCapReachedError';
  }
}

export class StallWatchdogError extends Error {
  constructor() {
    super('stalled-no-ai-response');
    this.name = 'StallWatchdogError';
  }
}

export type CallUsage = AiCallCounts;

export interface CallLogEntry {
  time: string;
  purpose: AiPurpose;
  slotNumber: number | string;
  attempt: number;
  elapsedMs: number;
  outcome: string;
}

export interface AiFailureDetail {
  errorType: string;
  status: number | null;
  bodySnippet: string;
}

export class AiCallError extends Error {
  readonly detail: AiFailureDetail;

  constructor(detail: AiFailureDetail) {
    super(AiCallError.describeDetail(detail));
    this.name = 'AiCallError';
    this.detail = detail;
  }

  describe(): string {
    return AiCallError.describeDetail(this.detail);
  }

  private static describeDetail(detail: AiFailureDetail): string {
    const status = detail.status === null ? 'no-status' : `HTTP ${detail.status}`;
    return `${detail.errorType} (${status})${detail.bodySnippet ? `: ${detail.bodySnippet}` : ''}`;
  }
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<FetchLikeResponse>;

export interface AiClientOptions {
  fetchImpl?: FetchLike;
  delayImpl?: (ms: number) => Promise<void>;
  delayMs?: number;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function jitter(): number {
  return Math.floor(Math.random() * 250);
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

// Spec 9: one counter and one breaker for every AI call in the run.
export class AiClient {
  private total = 0;
  private chatCalls = 0;
  private embeddingCalls = 0;
  private byPurpose: Record<string, number> = {};
  private consecutiveFailures = 0;
  private cooldownUntil = 0;
  private breakerOpen = false;
  private lastActivityAt = Date.now();
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;
  private readonly callLogs: string[] = [];
  private readonly failureDetails: AiFailureDetail[] = [];
  private failureCounts: FailureCounts = { byStatus: {}, byType: {} };

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly primaryModel: string;
  private readonly verifierModel: string | null;
  private readonly geminiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly delayImpl: (ms: number) => Promise<void>;
  private readonly successDelayMs: number;

  constructor(env: NodeJS.ProcessEnv = process.env, options: AiClientOptions = {}) {
    this.baseUrl = (env.OMNIROUTE_BASE_URL ?? '').trim().replace(/\/+$/, '').replace(/\/v1$/, '');
    this.apiKey = env.OMNIROUTE_API_KEY ?? '';
    this.primaryModel = env.OMNIROUTE_PRIMARY_MODEL ?? '';
    this.verifierModel = env.OMNIROUTE_VERIFIER_MODEL?.trim() || null;
    this.geminiKey = env.GEMINI_API_KEY;
    this.fetchImpl =
      options.fetchImpl ?? ((url, init) => fetch(url, init) as unknown as Promise<FetchLikeResponse>);
    this.delayImpl = options.delayImpl ?? sleep;
    this.successDelayMs = nonNegativeNumber(options.delayMs);
  }

  getUsage(): CallUsage {
    return {
      total: this.total,
      chat: this.chatCalls,
      embedding: this.embeddingCalls,
      byPurpose: { ...this.byPurpose },
    };
  }

  // Rehydrate cumulative counters from checkpoint.json so metrics cover every process.
  restoreUsage(usage: Partial<CallUsage> | undefined): void {
    if (!usage) return;
    this.total = nonNegativeNumber(usage.total);
    this.chatCalls = nonNegativeNumber(usage.chat);
    this.embeddingCalls = nonNegativeNumber(usage.embedding);
    this.byPurpose = {};
    for (const [purpose, count] of Object.entries(usage.byPurpose ?? {})) {
      this.byPurpose[purpose] = nonNegativeNumber(count);
    }
  }

  restoreFailureCounts(counts: FailureCounts | undefined): void {
    if (!counts) return;
    this.failureCounts = { byStatus: { ...counts.byStatus }, byType: { ...counts.byType } };
  }

  getVerifierMode(): 'dedicated' | 'same-model-fallback' {
    return this.verifierModel ? 'dedicated' : 'same-model-fallback';
  }

  getLastLogs(count = 3): string[] {
    return this.callLogs.slice(-count);
  }

  getFailureDetails(): AiFailureDetail[] {
    return [...this.failureDetails];
  }

  getFailureCounts(): FailureCounts {
    return {
      byStatus: { ...this.failureCounts.byStatus },
      byType: { ...this.failureCounts.byType },
    };
  }

  checkWatchdog(timeoutMs = WATCHDOG_TIMEOUT_MS): void {
    if (Date.now() - this.lastActivityAt > timeoutMs) {
      throw new StallWatchdogError();
    }
  }

  resetWatchdog(): void {
    this.lastActivityAt = Date.now();
  }

  // The timer is the only guard that works while a fetch hangs forever.
  startWatchdog(
    onStall: () => void,
    options: { timeoutMs?: number; intervalMs?: number } = {},
  ): void {
    this.stopWatchdog();
    const timeoutMs = options.timeoutMs ?? WATCHDOG_TIMEOUT_MS;
    const intervalMs = options.intervalMs ?? Math.max(1_000, Math.floor(timeoutMs / 10));
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastActivityAt <= timeoutMs) return;
      this.stopWatchdog();
      onStall();
    }, intervalMs);
  }

  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private recordCallLog(entry: CallLogEntry): void {
    const line = `[${entry.time}] ${entry.purpose} slot:${entry.slotNumber} try:${entry.attempt} ${entry.elapsedMs}ms -> ${entry.outcome}`;
    this.callLogs.push(line);
    console.log(line);
  }

  private async reserveCall(purpose: AiPurpose, kind: 'chat' | 'embedding'): Promise<void> {
    this.checkWatchdog();
    if (this.total >= MAX_AI_CALLS) throw new AiCapReachedError();

    if (this.breakerOpen) {
      const wait = this.cooldownUntil - Date.now();
      if (wait > 0) await this.delayImpl(wait);
      this.breakerOpen = false;
      console.log(`[CircuitBreaker] probe: cooldown elapsed at ${new Date().toISOString()}; probing now.`);
    }

    this.checkWatchdog();
    this.total += 1;
    if (kind === 'chat') this.chatCalls += 1;
    else this.embeddingCalls += 1;
    this.byPurpose[purpose] = (this.byPurpose[purpose] ?? 0) + 1;
  }

  private recordSuccess(): void {
    this.lastActivityAt = Date.now();
    this.consecutiveFailures = 0;
  }

  private recordFailure(detail: AiFailureDetail): void {
    this.lastActivityAt = Date.now();
    this.failureDetails.push(detail);
    const statusKey = detail.status === null ? 'none' : String(detail.status);
    this.failureCounts.byStatus[statusKey] = (this.failureCounts.byStatus[statusKey] ?? 0) + 1;
    this.failureCounts.byType[detail.errorType] = (this.failureCounts.byType[detail.errorType] ?? 0) + 1;

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_FAILURES && !this.breakerOpen) {
      this.cooldownUntil = Date.now() + BREAKER_COOLDOWN_MS;
      this.consecutiveFailures = 0;
      this.breakerOpen = true;
      const probeIso = new Date(this.cooldownUntil).toISOString();
      console.log(
        `[CircuitBreaker] OPEN: ${BREAKER_FAILURES} consecutive failures. Next probe at ${probeIso}.`,
      );
    }
  }

  private async fetchWithRetries(
    url: string,
    init: RequestInit,
    purpose: AiPurpose,
    kind: 'chat' | 'embedding',
    slotNumber: number | string = 'n/a',
  ): Promise<FetchLikeResponse> {
    let lastDetail: AiFailureDetail | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.reserveCall(purpose, kind);
      const callStart = Date.now();
      this.recordCallLog({
        time: new Date(callStart).toISOString(),
        purpose,
        slotNumber,
        attempt: attempt + 1,
        elapsedMs: 0,
        outcome: 'start',
      });

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);

      try {
        const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
        const elapsed = Date.now() - callStart;

        if (response.ok) {
          this.recordSuccess();
          this.recordCallLog({
            time: new Date().toISOString(),
            purpose,
            slotNumber,
            attempt: attempt + 1,
            elapsedMs: elapsed,
            outcome: `OK (HTTP ${response.status})`,
          });
          clearTimeout(timer);
          if (this.successDelayMs > 0) {
            await this.delayImpl(this.successDelayMs);
            this.lastActivityAt = Date.now();
          }
          return response;
        }

        let bodyText = '';
        try {
          bodyText = await response.text();
        } catch {
          bodyText = '';
        }
        const rateLimited = response.status === 429;
        const detail: AiFailureDetail = {
          errorType: rateLimited ? 'rate-limited' : `HTTP_${response.status}`,
          status: response.status,
          bodySnippet: redactSecret(bodyText).slice(0, 200).trim(),
        };
        lastDetail = detail;
        this.recordFailure(detail);
        // Keep the log line free of response text; the detail carries it.
        this.recordCallLog({
          time: new Date().toISOString(),
          purpose,
          slotNumber,
          attempt: attempt + 1,
          elapsedMs: elapsed,
          outcome: rateLimited ? 'rate-limited' : `HTTP ${response.status}`,
        });

        if (rateLimited) {
          if (attempt === MAX_RETRIES) break;
          const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
          const waitMs =
            retryAfter === null
              ? RATE_LIMIT_DEFAULT_WAIT_MS
              : Math.min(retryAfter, RATE_LIMIT_MAX_WAIT_MS);
          clearTimeout(timer);
          await this.delayImpl(waitMs);
          // A deliberate rate-limit wait is not a stall.
          this.lastActivityAt = Date.now();
          continue;
        }

        if (response.status >= 500) {
          if (attempt === MAX_RETRIES) break;
          await this.delayImpl(BACKOFF_MS[attempt] + jitter());
          continue;
        }

        // Client errors (401/403/404/422) are permanent: retrying cannot help.
        throw new AiCallError(detail);
      } catch (error) {
        if (
          error instanceof AiCallError ||
          error instanceof AiCapReachedError ||
          error instanceof StallWatchdogError
        ) {
          throw error;
        }

        const elapsed = Date.now() - callStart;
        const errorType = timedOut
          ? 'timeout'
          : error instanceof Error && error.name
            ? error.name
            : typeof error;
        const message = timedOut
          ? `Request timed out after ${REQUEST_TIMEOUT_MS} ms.`
          : error instanceof Error
            ? error.message
            : String(error);
        const detail: AiFailureDetail = {
          errorType,
          status: null,
          bodySnippet: redactSecret(message).slice(0, 200).trim(),
        };
        lastDetail = detail;
        this.recordFailure(detail);
        this.recordCallLog({
          time: new Date().toISOString(),
          purpose,
          slotNumber,
          attempt: attempt + 1,
          elapsedMs: elapsed,
          outcome: errorType,
        });

        if (attempt === MAX_RETRIES) break;
        await this.delayImpl(BACKOFF_MS[attempt] + jitter());
      } finally {
        clearTimeout(timer);
      }
    }

    throw new AiCallError(
      lastDetail ?? { errorType: 'unknown', status: null, bodySnippet: 'AI call failed.' },
    );
  }

  // Spec 9 and 13: one GET used by --dry to list gateway models.
  async listModels(): Promise<{ ids: string[]; error: string | null }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/v1/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
      if (!res.ok) return { ids: [], error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      const ids = (body.data ?? [])
        .map(item => (typeof item?.id === 'string' ? item.id : null))
        .filter((id): id is string => Boolean(id));
      return { ids, error: null };
    } catch (error) {
      return { ids: [], error: error instanceof Error ? error.message : 'unknown error' };
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(
    messages: ChatMessage[],
    purpose: AiPurpose,
    options: { temperature: number; verifier: boolean; slotNumber?: number | string },
  ): Promise<string> {
    const model = options.verifier ? (this.verifierModel ?? this.primaryModel) : this.primaryModel;
    if (!this.baseUrl || !this.apiKey || !model) {
      throw new Error('OmniRoute configuration is incomplete.');
    }

    const response = await this.fetchWithRetries(
      `${this.baseUrl}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature,
          stream: false,
        }),
      },
      purpose,
      'chat',
      options.slotNumber ?? 'n/a',
    );

    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim().length === 0) {
      const detail: AiFailureDetail = {
        errorType: 'empty-completion',
        status: response.status,
        bodySnippet: 'OmniRoute returned an empty completion.',
      };
      this.recordFailure(detail);
      throw new AiCallError(detail);
    }
    return content;
  }

  // Same embedding request the app uses; only the purpose label differs.
  async embed(text: string, slotNumber: number | string = 'n/a'): Promise<number[]> {
    if (!this.geminiKey) throw new Error('GEMINI_API_KEY is not configured.');
    const url = `${EMBEDDING_URL}/${EMBEDDING_MODEL}:embedContent?key=${this.geminiKey}`;

    const response = await this.fetchWithRetries(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: EMBEDDING_DIMENSIONS,
        }),
      },
      'embed',
      'embedding',
      slotNumber,
    );

    const body = (await response.json()) as { embedding?: { values?: unknown } };
    const values = body.embedding?.values;
    if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
      const detail: AiFailureDetail = {
        errorType: 'invalid-embedding',
        status: response.status,
        bodySnippet: `Expected ${EMBEDDING_DIMENSIONS} values.`,
      };
      this.recordFailure(detail);
      throw new AiCallError(detail);
    }
    if (!values.every(value => typeof value === 'number' && Number.isFinite(value))) {
      const detail: AiFailureDetail = {
        errorType: 'invalid-embedding',
        status: response.status,
        bodySnippet: 'Gemini embedding returned non-finite values.',
      };
      this.recordFailure(detail);
      throw new AiCallError(detail);
    }
    return values as number[];
  }
}

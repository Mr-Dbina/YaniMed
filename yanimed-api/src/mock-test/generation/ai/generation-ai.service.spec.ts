import { describe, expect, it, vi } from 'vitest';
import { EMBEDDING_MODEL, type EmbeddingService } from '../../../embeddings/embedding.service.js';
import {
  AI_CALLS_PER_JOB,
  AI_DAILY_BUDGET,
} from '../generation.constants.js';
import type { GenerationJobRepository } from '../generation-job.repository.js';
import type {
  AiCallLogEntry,
  AiCallLogRepository,
} from './ai-call-log.repository.js';
import { CircuitBreaker } from './circuit-breaker.js';
import {
  GenerationAiService,
  type AiFetch,
  type AiHttpResponse,
  type GenerationAiConfig,
} from './generation-ai.service.js';

const CONFIG: GenerationAiConfig = {
  baseUrl: 'https://gateway.test',
  apiKey: 'test-api-key',
  primaryModel: 'primary-model',
  verifierModel: 'verifier-model',
};

const JOB_ID = 'job-1';
const MESSAGES = [{ role: 'user' as const, content: 'generate something' }];

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): AiHttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function okResponse(
  text = 'answer',
  options: {
    model?: string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } = {},
): AiHttpResponse {
  return jsonResponse(200, {
    model: options.model ?? 'served-model',
    choices: [{ message: { content: text } }],
    ...(options.usage ? { usage: options.usage } : {}),
  });
}

function fakeLogs(initialCount = 0) {
  const rows: AiCallLogEntry[] = [];
  const state = { dailyCount: initialCount };
  return {
    rows,
    state,
    insert: vi.fn(async (entry: AiCallLogEntry) => {
      rows.push(entry);
    }),
    countSince: vi.fn(async () => state.dailyCount),
  };
}

function fakeJobs(start = 0) {
  const state = { calls: start };
  return {
    state,
    reserveAiCall: vi.fn(async (_jobId: string, cap: number) => {
      if (state.calls >= cap) return null;
      state.calls += 1;
      return state.calls;
    }),
  };
}

interface HarnessOptions {
  config?: Partial<GenerationAiConfig>;
  fetchImpl?: AiFetch;
  logs?: ReturnType<typeof fakeLogs>;
  jobs?: ReturnType<typeof fakeJobs>;
  embeddings?: { embedText: (text: string) => Promise<number[]> };
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  breaker?: CircuitBreaker;
  timeoutMs?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const logs = options.logs ?? fakeLogs();
  const jobs = options.jobs ?? fakeJobs();
  const fetchImpl = options.fetchImpl ?? vi.fn();
  const sleep = options.sleep ?? vi.fn(async () => {});
  const service = new GenerationAiService(
    jobs as unknown as GenerationJobRepository,
    logs as unknown as AiCallLogRepository,
    options.embeddings as unknown as EmbeddingService,
    {
      config: { ...CONFIG, ...options.config },
      fetchImpl,
      now: options.now ?? (() => 1_000),
      sleep,
      random: () => 0,
      breaker: options.breaker ?? new CircuitBreaker(() => 1_000),
      timeoutMs: options.timeoutMs,
    },
  );
  return { service, logs, jobs, fetchImpl, sleep };
}

function completeInput(overrides: Record<string, unknown> = {}) {
  return {
    purpose: 'PLAN' as const,
    jobId: JOB_ID,
    messages: MESSAGES,
    ...overrides,
  };
}

describe('GenerationAiService model selection', () => {
  it('uses the primary model for PLAN and DRAFT and the verifier for VERIFY', async () => {
    const bodies: Array<{ model: string }> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as { model: string });
      return okResponse();
    });
    const { service } = makeHarness({ fetchImpl: fetchImpl as AiFetch });

    await service.complete(completeInput({ purpose: 'PLAN' }));
    await service.complete(completeInput({ purpose: 'DRAFT' }));
    await service.complete(completeInput({ purpose: 'VERIFY' }));

    expect(bodies.map((body) => body.model)).toEqual([
      'primary-model',
      'primary-model',
      'verifier-model',
    ]);
  });

  it('sends temperature, json mode and a bearer key', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, _init: RequestInit) => okResponse(),
    );
    const { service } = makeHarness({ fetchImpl: fetchImpl as AiFetch });

    await service.complete(
      completeInput({ temperature: 0.2, jsonMode: true }),
    );

    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.temperature).toBe(0.2);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${CONFIG.apiKey}`,
    );
  });
});

describe('GenerationAiService verifier guard', () => {
  it.each([null, '', 'primary-model'])(
    'refuses VERIFY when the verifier model is %s',
    async (verifierModel) => {
      const fetchImpl = vi.fn();
      const { service, logs, jobs } = makeHarness({
        config: { verifierModel },
        fetchImpl: fetchImpl as AiFetch,
      });

      await expect(
        service.complete(completeInput({ purpose: 'VERIFY' })),
      ).rejects.toMatchObject({ code: 'GENERATION_VERIFIER_NOT_CONFIGURED' });
      expect(() => service.assertReady()).toThrow(
        'Generation error: GENERATION_VERIFIER_NOT_CONFIGURED',
      );
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(jobs.reserveAiCall).not.toHaveBeenCalled();
      expect(logs.insert).not.toHaveBeenCalled();
    },
  );
});

describe('GenerationAiService budgets', () => {
  it('counts retries toward the 400 per-job cap', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(429, {}, { 'retry-after': '1' }),
    );
    const { service, logs, jobs, sleep } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
      jobs: fakeJobs(AI_CALLS_PER_JOB - 1),
    });

    await expect(service.complete(completeInput())).rejects.toMatchObject({
      code: 'GENERATION_BUDGET_EXHAUSTED',
      details: { limit: AI_CALLS_PER_JOB },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(jobs.state.calls).toBe(AI_CALLS_PER_JOB);
    expect(logs.rows).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('allows the 1499th daily call and refuses the 1500th before the network', async () => {
    const allowed = makeHarness({
      fetchImpl: vi.fn(async () => okResponse()) as unknown as AiFetch,
      logs: fakeLogs(AI_DAILY_BUDGET - 1),
    });
    await expect(allowed.service.complete(completeInput())).resolves.toMatchObject(
      { text: 'answer' },
    );
    expect(allowed.fetchImpl).toHaveBeenCalledTimes(1);

    const denied = makeHarness({
      logs: fakeLogs(AI_DAILY_BUDGET),
    });
    await expect(denied.service.complete(completeInput())).rejects.toMatchObject({
      code: 'GENERATION_BUDGET_EXHAUSTED',
      details: { limit: AI_DAILY_BUDGET },
    });
    expect(denied.fetchImpl).not.toHaveBeenCalled();
    expect(denied.jobs.reserveAiCall).not.toHaveBeenCalled();
  });
});

describe('GenerationAiService retries', () => {
  it('retries 5xx with 2 s backoff and jitter', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(okResponse('done'));
    const { service, logs, sleep } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
    });

    const result = await service.complete(completeInput());

    expect(result.text).toBe('done');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(logs.rows.map((row) => row.outcome)).toEqual([
      'HTTP_ERROR',
      'SUCCESS',
    ]);
  });

  it.each<[string, number]>([
    ['5', 5_000],
    [new Date(1_000 + 7_000).toUTCString(), 7_000],
  ])('honours Retry-After %s', async (header, expectedWait) => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { 'retry-after': header }))
      .mockResolvedValueOnce(okResponse());
    const { service, sleep } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
    });

    await service.complete(completeInput());

    expect(sleep).toHaveBeenCalledWith(expectedWait);
  });

  it.each([400, 401, 403])('never retries HTTP %i', async (status) => {
    const fetchImpl = vi.fn(async () => jsonResponse(status, {}));
    const { service, logs, sleep } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
    });

    await expect(service.complete(completeInput())).rejects.toMatchObject({
      code: 'GENERATION_PROVIDER_UNAVAILABLE',
      details: { status },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logs.rows[0].errorCode).toBe(`HTTP_${status}`);
  });

  it('times out every attempt at exactly 60 s', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<AiHttpResponse>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
      );
      const { service, logs } = makeHarness({ fetchImpl: fetchImpl as AiFetch });

      const promise = service.complete(completeInput());
      const settled = vi.fn();
      promise.then(settled, settled);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(settled).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000 * 4);
      await expect(promise).rejects.toMatchObject({
        code: 'GENERATION_AI_TIMEOUT',
      });
      expect(fetchImpl).toHaveBeenCalledTimes(4);
      expect(logs.rows).toHaveLength(4);
      expect(logs.rows.every((row) => row.errorCode === 'TIMEOUT')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('GenerationAiService circuit breaker', () => {
  it('fails fast after five consecutive provider failures', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(503, {}));
    const { service, logs } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
    });

    await expect(service.complete(completeInput())).rejects.toMatchObject({
      code: 'GENERATION_PROVIDER_UNAVAILABLE',
    });
    // Four failed attempts, then the second call's first attempt is the fifth.
    await expect(service.complete(completeInput())).rejects.toMatchObject({
      code: 'GENERATION_PROVIDER_UNAVAILABLE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);

    await expect(service.complete(completeInput())).rejects.toMatchObject({
      code: 'GENERATION_PROVIDER_UNAVAILABLE',
      details: { breakerOpen: 1 },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(logs.insert).toHaveBeenCalledTimes(5);
  });
});

describe('GenerationAiService call log', () => {
  it('writes one whitelisted row per attempt and no secrets', async () => {
    const promptBody = 'PROMPT-BODY-MUST-NOT-LEAK';
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, {}))
      .mockResolvedValueOnce(
        okResponse('answer', {
          usage: { prompt_tokens: 11, completion_tokens: 22 },
        }),
      );
    const { service, logs } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
    });

    const result = await service.complete(
      completeInput({ messages: [{ role: 'user', content: promptBody }] }),
    );

    expect(result).toMatchObject({
      text: 'answer',
      model: 'served-model',
      tokensIn: 11,
      tokensOut: 22,
      latencyMs: 0,
    });
    expect(logs.rows).toHaveLength(2);
    expect(logs.rows[0]).toMatchObject({
      jobId: JOB_ID,
      purpose: 'PLAN',
      model: 'primary-model',
      promptTokens: null,
      completionTokens: null,
      outcome: 'HTTP_ERROR',
      errorCode: 'HTTP_503',
    });
    expect(logs.rows[1]).toMatchObject({
      promptTokens: 11,
      completionTokens: 22,
      outcome: 'SUCCESS',
      errorCode: null,
    });

    const serialized = JSON.stringify(logs.rows);
    expect(serialized).not.toContain(promptBody);
    expect(serialized).not.toContain(CONFIG.apiKey);
  });

  it('keeps tokens null when the provider reports no usage', async () => {
    const fetchImpl = vi.fn(async () => okResponse('plain'));
    const { service, logs } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
    });

    const result = await service.complete(completeInput());

    expect(result.tokensIn).toBeNull();
    expect(result.tokensOut).toBeNull();
    expect(logs.rows[0].promptTokens).toBeNull();
    expect(logs.rows[0].completionTokens).toBeNull();
  });

  it('rejects an invalid JSON body and logs one row', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => 'not json',
      json: async () => {
        throw new SyntaxError('bad json');
      },
    }));
    const { service, logs } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
    });

    await expect(service.complete(completeInput())).rejects.toMatchObject({
      code: 'GENERATION_PROVIDER_UNAVAILABLE',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logs.rows[0]).toMatchObject({
      outcome: 'INVALID_RESPONSE',
      errorCode: 'INVALID_RESPONSE',
    });
  });
});

describe('GenerationAiService cancellation', () => {
  it('stops retrying when the caller aborts mid-flight', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<AiHttpResponse>((_resolve, reject) => {
          const abort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (init.signal?.aborted) {
            abort();
            return;
          }
          init.signal?.addEventListener('abort', abort);
        }),
    );
    const { service, logs, sleep } = makeHarness({
      fetchImpl: fetchImpl as AiFetch,
    });

    const promise = service.complete(
      completeInput({ signal: controller.signal }),
    );
    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(logs.rows).toHaveLength(1);
    expect(logs.rows[0]).toMatchObject({
      outcome: 'ABORTED',
      errorCode: 'ABORTED',
    });
  });

  it('does nothing when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const { service, logs, jobs, fetchImpl } = makeHarness();

    await expect(
      service.complete(completeInput({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(jobs.reserveAiCall).not.toHaveBeenCalled();
    expect(logs.insert).not.toHaveBeenCalled();
  });
});

describe('GenerationAiService embeddings', () => {
  it('logs EMBED calls and returns the vector', async () => {
    const embeddings = { embedText: vi.fn(async () => [0.1, 0.2]) };
    const { service, logs, jobs } = makeHarness({ embeddings });

    await expect(
      service.embed({ jobId: JOB_ID, text: 'chunk text' }),
    ).resolves.toEqual([0.1, 0.2]);
    expect(jobs.state.calls).toBe(1);
    expect(logs.rows[0]).toMatchObject({
      purpose: 'EMBED',
      model: EMBEDDING_MODEL,
      promptTokens: null,
      completionTokens: null,
      outcome: 'SUCCESS',
      errorCode: null,
    });
  });

  it('maps embedding failures to PROVIDER_UNAVAILABLE', async () => {
    const embeddings = {
      embedText: vi.fn(async () => {
        throw new Error('embedding boom');
      }),
    };
    const { service, logs } = makeHarness({ embeddings });

    await expect(
      service.embed({ jobId: JOB_ID, text: 'chunk text' }),
    ).rejects.toMatchObject({ code: 'GENERATION_PROVIDER_UNAVAILABLE' });
    expect(logs.rows[0]).toMatchObject({
      outcome: 'ERROR',
      errorCode: 'EMBEDDING_FAILED',
    });
  });

  it('refuses EMBED without an embedding service', async () => {
    const { service, jobs, logs } = makeHarness();

    await expect(
      service.embed({ jobId: JOB_ID, text: 'chunk text' }),
    ).rejects.toMatchObject({ code: 'GENERATION_PROVIDER_UNAVAILABLE' });
    expect(jobs.reserveAiCall).not.toHaveBeenCalled();
    expect(logs.insert).not.toHaveBeenCalled();
  });
});

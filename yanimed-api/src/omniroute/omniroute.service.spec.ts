import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OmniRouteService } from './omniroute.service.js';

const CONFIG_VALUES: Record<string, string> = {
  omnirouteBaseUrl: 'https://gateway.test/v1',
  omnirouteApiKey: 'secret-api-key',
  omniroutePrimaryModel: 'yanimed',
  omnirouteDrafterModel: 'yanimed-draft',
  omnirouteVerifierModel: 'yanimed-verify',
};

const ENV_KEYS = ['OMNIROUTE_BASE_URL', 'OMNIROUTE_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};

function makeService(): OmniRouteService {
  return new OmniRouteService({
    get: (key: string) => CONFIG_VALUES[key],
  } as unknown as ConfigService);
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    process.env[key] = key === 'OMNIROUTE_API_KEY' ? 'secret-api-key' : 'https://gateway.test/v1';
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('OmniRouteService model selection', () => {
  it('sends the chat combo for answer generation', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '',
      json: async () => ({
        model: 'served-model',
        choices: [{ message: { content: 'answer' } }],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const service = makeService();
    service.onModuleInit();
    const result = await service.complete('question');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gateway.test/v1/chat/completions');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'yanimed' });
    expect(result.content).toBe('answer');
  });

  it('logs the resolved combo names without the API key', () => {
    const log = vi.spyOn(Logger.prototype, 'log');

    makeService().onModuleInit();

    const logged = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain('chat=yanimed');
    expect(logged).toContain('drafter=yanimed-draft');
    expect(logged).toContain('verifier=yanimed-verify');
    expect(logged).not.toContain('secret-api-key');
  });
});

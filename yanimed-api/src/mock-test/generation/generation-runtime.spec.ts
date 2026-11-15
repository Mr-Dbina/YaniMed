import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import {
  createGenerationRuntime,
  isUnderTestBoot,
} from './generation-runtime.js';

function fakeComponents(calls: string[]) {
  return {
    reconciler: {
      recoverOnBoot: vi.fn(async () => {
        calls.push('recoverOnBoot');
        return { stalled: [], requeued: [], failed: [], cancelled: [] };
      }),
      start: vi.fn(() => {
        calls.push('reconciler.start');
      }),
      stop: vi.fn(() => {
        calls.push('reconciler.stop');
      }),
    },
    worker: {
      start: vi.fn(() => {
        calls.push('worker.start');
      }),
      stop: vi.fn(async () => {
        calls.push('worker.stop');
      }),
    },
  };
}

describe('createGenerationRuntime', () => {
  it('runs boot recovery, then the reconciler, then the worker', async () => {
    const calls: string[] = [];
    const runtime = createGenerationRuntime({
      components: fakeComponents(calls),
      enabled: true,
      underTest: false,
    });

    await runtime.bootstrap();

    expect(calls).toEqual([
      'recoverOnBoot',
      'reconciler.start',
      'worker.start',
    ]);
  });

  it('does not start when the flag is off', async () => {
    const calls: string[] = [];
    const components = fakeComponents(calls);
    const runtime = createGenerationRuntime({
      components,
      enabled: false,
      underTest: false,
    });

    await runtime.bootstrap();

    expect(calls).toEqual([]);
    expect(components.reconciler.recoverOnBoot).not.toHaveBeenCalled();
  });

  it('does not start under the test runner', async () => {
    const calls: string[] = [];
    const runtime = createGenerationRuntime({
      components: fakeComponents(calls),
      enabled: true,
      underTest: true,
    });

    await runtime.bootstrap();

    expect(calls).toEqual([]);
  });

  it('starts only once on a repeated bootstrap', async () => {
    const calls: string[] = [];
    const runtime = createGenerationRuntime({
      components: fakeComponents(calls),
      enabled: true,
      underTest: false,
    });

    await Promise.all([runtime.bootstrap(), runtime.bootstrap()]);

    expect(calls).toEqual([
      'recoverOnBoot',
      'reconciler.start',
      'worker.start',
    ]);
  });

  it('stops the worker before the reconciler', async () => {
    const calls: string[] = [];
    const runtime = createGenerationRuntime({
      components: fakeComponents(calls),
      enabled: true,
      underTest: false,
    });
    await runtime.bootstrap();
    calls.length = 0;

    await runtime.shutdown();

    expect(calls).toEqual(['worker.stop', 'reconciler.stop']);
  });

  it('logs the start and the skip reason', async () => {
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn() };

    await createGenerationRuntime({
      components: fakeComponents([]),
      enabled: false,
      underTest: false,
      logger,
    }).bootstrap();
    expect(info).toHaveBeenCalledWith('generation.runtime.skipped', {
      enabled: 0,
      underTest: 0,
    });

    info.mockClear();
    await createGenerationRuntime({
      components: fakeComponents([]),
      enabled: true,
      underTest: true,
      logger,
    }).bootstrap();
    expect(info).toHaveBeenCalledWith('generation.runtime.skipped', {
      enabled: 1,
      underTest: 1,
    });

    info.mockClear();
    await createGenerationRuntime({
      components: fakeComponents([]),
      enabled: true,
      underTest: false,
      logger,
    }).bootstrap();
    expect(info).toHaveBeenCalledWith('generation.runtime.started');
  });
});

describe('isUnderTestBoot', () => {
  function configWith(nodeEnv: string | undefined): ConfigService {
    return { get: () => nodeEnv } as unknown as ConfigService;
  }

  it('does not treat a missing NODE_ENV as the test runner', () => {
    expect(isUnderTestBoot(configWith(undefined))).toBe(false);
  });

  it('treats NODE_ENV=test as the test runner', () => {
    expect(isUnderTestBoot(configWith('test'))).toBe(true);
  });

  it('treats a dev boot as real work', () => {
    expect(isUnderTestBoot(configWith('development'))).toBe(false);
    expect(isUnderTestBoot(configWith('e2e'))).toBe(false);
  });

  it('treats no ConfigService as a bare test module', () => {
    expect(isUnderTestBoot(undefined)).toBe(true);
  });
});

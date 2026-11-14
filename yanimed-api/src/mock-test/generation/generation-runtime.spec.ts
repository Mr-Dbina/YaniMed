import { describe, expect, it, vi } from 'vitest';
import { createGenerationRuntime } from './generation-runtime.js';

function fakeComponents(calls: string[]) {
  return {
    reconciler: {
      recoverOnBoot: vi.fn(async () => {
        calls.push('recoverOnBoot');
        return { stalled: [], requeued: [], failed: [] };
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
});

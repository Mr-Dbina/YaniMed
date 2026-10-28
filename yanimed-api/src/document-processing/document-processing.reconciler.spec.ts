import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DocumentProcessingReconciler } from './document-processing.reconciler.js';

function makeProcessing() {
  return {
    enqueueOrphans: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DocumentProcessingReconciler', () => {
  it('enqueues orphans before draining a bounded batch', async () => {
    const processing = makeProcessing();
    const reconciler = new DocumentProcessingReconciler(processing as never);

    await reconciler.tick();

    expect(processing.enqueueOrphans).toHaveBeenCalledWith(20);
    expect(processing.drain).toHaveBeenCalledWith(5);
    expect(processing.enqueueOrphans.mock.invocationCallOrder[0])
      .toBeLessThan(processing.drain.mock.invocationCallOrder[0]);
  });

  it('never selects documents directly, including FAILED ones', async () => {
    const processing = makeProcessing();
    const guarded = new Proxy(processing, {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        throw new Error(`unexpected reconciler access: ${String(property)}`);
      },
    });
    const reconciler = new DocumentProcessingReconciler(guarded as never);

    await reconciler.tick();

    expect(processing.enqueueOrphans).toHaveBeenCalledTimes(1);
    expect(processing.drain).toHaveBeenCalledTimes(1);
  });

  it('logs the underlying error name, code and first line without a stack or connection string', async () => {
    const processing = makeProcessing();
    const error = Object.assign(
      new Error('database unavailable postgresql://user:secret@example.invalid:5432/db\nsecond line'),
      { code: 'DB_TRANSIENT' },
    );
    processing.enqueueOrphans.mockRejectedValue(error);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const reconciler = new DocumentProcessingReconciler(processing as never);

    await expect(reconciler.tick()).resolves.toBeUndefined();

    const logged = warn.mock.calls.map(call => String(call[0])).join('\n');
    expect(logged).toContain('name=Error');
    expect(logged).toContain('code=DB_TRANSIENT');
    expect(logged).toContain('database unavailable');
    expect(logged).not.toContain('postgresql://');
    expect(logged).not.toContain('second line');
    expect(logged).not.toMatch(/\n\s+at /);
    warn.mockRestore();
  });

  it('coalesces overlapping ticks while a sweep is running', async () => {
    const processing = makeProcessing();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    processing.enqueueOrphans.mockImplementation(async () => { await gate; });
    const reconciler = new DocumentProcessingReconciler(processing as never);

    const first = reconciler.tick();
    const second = reconciler.tick();

    expect(second).toBe(first);
    expect(processing.enqueueOrphans).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);

    expect(processing.drain).toHaveBeenCalledTimes(1);
  });
});

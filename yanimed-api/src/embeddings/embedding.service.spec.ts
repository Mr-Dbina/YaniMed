import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbeddingService, EMBEDDING_DIMENSIONS } from './embedding.service.js';

const originalFetch = global.fetch;

function makePrisma(chunks: Array<{ id: string; content: string; chunkIndex: number }>) {
  return {
    document: {
      findUnique: vi.fn().mockResolvedValue({ id: 'doc-1', chunks }),
      update: vi.fn().mockResolvedValue({}),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn().mockResolvedValue(1),
  };
}

describe('EmbeddingService', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-key';
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.GEMINI_API_KEY;
    vi.restoreAllMocks();
  });

  it('generates and persists a valid embedding', async () => {
    const prisma = makePrisma([{ id: 'chunk-1', content: 'medical text', chunkIndex: 0 }]);
    prisma.$queryRaw.mockResolvedValue([{ has_embedding: false, model: null }]);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: Array(EMBEDDING_DIMENSIONS).fill(0.25) } }),
    });
    const service = new EmbeddingService(prisma as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    const result = await service.embedDocument('doc-1');
    expect(result.embeddedChunks).toBe(1);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    const statuses = (prisma.document.update as ReturnType<typeof vi.fn>).mock.calls.map((c: any) => c[0]?.data?.status);
    expect(statuses).not.toContain('READY');
  });

  it('rejects invalid embedding dimensions', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    });
    const service = new EmbeddingService(undefined as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    await expect(service.embedText('text')).rejects.toThrow(/dimensions/);
  });

  it('rejects non-finite embedding values', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: Array(EMBEDDING_DIMENSIONS).fill(NaN) } }),
    });
    const service = new EmbeddingService(undefined as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    await expect(service.embedText('text')).rejects.toThrow(/non-finite/);
  });

  it('retries rate-limited requests', async () => {
    (global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: async () => 'rate limited',
        headers: { get: () => '0' },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embedding: { values: Array(EMBEDDING_DIMENSIONS).fill(0.5) } }),
      });
    const service = new EmbeddingService(undefined as never, { requestsPerMinute: 100000, maxAttempts: 2 });
    const vector = await service.embedText('text');
    expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('skips already valid embeddings', async () => {
    const prisma = makePrisma([
      { id: 'chunk-1', content: 'already', chunkIndex: 0 },
      { id: 'chunk-2', content: 'new', chunkIndex: 1 },
    ]);
    prisma.$queryRaw
      .mockResolvedValueOnce([{ has_embedding: true, model: 'gemini-embedding-001' }])
      .mockResolvedValueOnce([{ has_embedding: false, model: null }]);
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: Array(EMBEDDING_DIMENSIONS).fill(0.1) } }),
    });
    const service = new EmbeddingService(prisma as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    const result = await service.embedDocument('doc-1');
    expect(result.skippedChunks).toBe(1);
    expect(result.embeddedChunks).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('marks document FAILED and throws on persistence failure', async () => {
    const prisma = makePrisma([{ id: 'chunk-1', content: 'text', chunkIndex: 0 }]);
    prisma.$queryRaw.mockResolvedValue([{ has_embedding: false, model: null }]);
    prisma.$executeRaw.mockRejectedValue(new Error('db write failed'));
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ embedding: { values: Array(EMBEDDING_DIMENSIONS).fill(0.1) } }),
    });
    const service = new EmbeddingService(prisma as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    await expect(service.embedDocument('doc-1')).rejects.toThrow(/db write failed/);
    const statuses = (prisma.document.update as ReturnType<typeof vi.fn>).mock.calls.map((c: any) => c[0]?.data?.status);
    expect(statuses).toContain('FAILED');
  });

  it('verifies embedding integrity', async () => {
    const prisma = makePrisma([]);
    prisma.$queryRaw.mockResolvedValue([
      { id: 'chunk-1', has_embedding: true, dims: EMBEDDING_DIMENSIONS, model: 'gemini-embedding-001' },
    ]);
    const service = new EmbeddingService(prisma as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    const result = await service.verifyDocumentEmbeddings('doc-1');
    expect(result.isComplete).toBe(true);
    expect(result.missingChunks).toEqual([]);
  });

  it('withDocumentLock releases its in-process lock after overlapping calls', async () => {
    const service = new EmbeddingService(undefined as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstCall = (service as any).withDocumentLock('doc-1', async () => { await firstGate; return 'first'; });
    await Promise.resolve();
    const secondCall = (service as any).withDocumentLock('doc-1', async () => 'second');
    expect((service as any).locks.size).toBe(1);
    releaseFirst();
    await expect(firstCall).resolves.toBe('first');
    await expect(secondCall).resolves.toBe('second');
    expect((service as any).locks.size).toBe(0);
    await (service as any).withDocumentLock('doc-1', async () => 'third');
    expect((service as any).locks.size).toBe(0);
  });

  it('withDocumentLock releases its lock when work throws', async () => {
    const service = new EmbeddingService(undefined as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    await expect((service as any).withDocumentLock('doc-1', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect((service as any).locks.size).toBe(0);
  });

  it('withDocumentLock serializes queued third call and cleans up lock', async () => {
    const service = new EmbeddingService(undefined as never, { requestsPerMinute: 100000, maxAttempts: 1 });
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const firstCall = (service as any).withDocumentLock('doc-1', async () => {
      const index = gates.length + 1;
      order.push(`start-${index}`);
      await new Promise<void>(resolve => { gates.push(resolve); });
      order.push(`end-${index}`);
      return `result-${index}`;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    const secondCall = (service as any).withDocumentLock('doc-1', async () => {
      const index = gates.length + 1;
      order.push(`start-${index}`);
      await new Promise<void>(resolve => { gates.push(resolve); });
      order.push(`end-${index}`);
      return `result-${index}`;
    });
    const thirdCall = (service as any).withDocumentLock('doc-1', async () => {
      const index = gates.length + 1;
      order.push(`start-${index}`);
      await new Promise<void>(resolve => { gates.push(resolve); });
      order.push(`end-${index}`);
      return `result-${index}`;
    });
    expect(gates.length).toBe(1);
    gates[0]();
    await firstCall;
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(gates.length).toBe(2);
    expect(order.indexOf('start-2')).toBeGreaterThan(order.indexOf('end-1'));
    gates[1]();
    await secondCall;
    expect((service as any).locks.has('doc-1')).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 0));
    if (gates.length < 3) await new Promise(resolve => setTimeout(resolve, 0));
    gates[2]();
    await thirdCall;
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2', 'start-3', 'end-3']);
    expect((service as any).locks.size).toBe(0);
  });
});

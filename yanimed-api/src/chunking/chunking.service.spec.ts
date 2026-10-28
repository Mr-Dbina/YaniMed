import { describe, expect, it, vi } from 'vitest';
import { ChunkingService } from './chunking.service.js';
import { LeaseLostError } from '../document-processing/processing-job.types.js';

function makePrisma(pages: Array<{ pageNumber: number; text: string; extractionMethod?: string; needsOcr?: boolean }>) {
  const chunks: any[] = [];
  const prisma = {
    document: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'doc-1',
        pages: pages.map(p => ({
          pageNumber: p.pageNumber,
          text: p.text,
          extractionMethod: p.extractionMethod ?? 'TEXT',
          needsOcr: p.needsOcr ?? false,
        })),
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    chunk: {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockImplementation(async ({ data }: { data: any[] }) => {
        chunks.push(...data);
        return { count: data.length };
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => work(prisma)),
  };
  return { prisma, chunks };
}

describe('ChunkingService', () => {
  it('chunks a single page and preserves page number', async () => {
    const { prisma, chunks } = makePrisma([{ pageNumber: 1, text: 'Hello world. This is a test.' }]);
    const service = new ChunkingService(prisma as never);
    const result = await service.chunkDocument('doc-1');
    expect(result.chunkCount).toBeGreaterThan(0);
    expect(chunks.every(c => c.page === 1)).toBe(true);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].content).toContain('Hello');
  });

  it('preserves physical page numbers across pages', async () => {
    const { prisma, chunks } = makePrisma([
      { pageNumber: 1, text: 'Page one content.' },
      { pageNumber: 2, text: 'Page two content.' },
    ]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(chunks.some(c => c.page === 1 && c.content.includes('Page one'))).toBe(true);
    expect(chunks.some(c => c.page === 2 && c.content.includes('Page two'))).toBe(true);
    const indexes = chunks.map(c => c.chunkIndex);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('skips blank pages', async () => {
    const { prisma, chunks } = makePrisma([
      { pageNumber: 1, text: '' },
      { pageNumber: 2, text: 'Visible text.' },
    ]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(chunks.every(c => c.page === 2)).toBe(true);
  });

  it('does not recreate existing chunks on rerun', async () => {
    const { prisma } = makePrisma([{ pageNumber: 1, text: 'Stable text.' }]);
    prisma.chunk.findMany.mockResolvedValue([{ id: 'chunk-0', documentId: 'doc-1', content: 'Stable text.', page: 1, chunkIndex: 0, extractionMethod: 'TEXT', needsReview: false }]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(prisma.chunk.createMany).not.toHaveBeenCalled();
    expect(prisma.chunk.deleteMany).not.toHaveBeenCalled();
  });

  it('does not cross page boundaries', async () => {
    const { prisma, chunks } = makePrisma([
      { pageNumber: 1, text: 'A'.repeat(500) + '.' },
      { pageNumber: 2, text: 'B'.repeat(500) + '.' },
    ]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1', { maxChars: 100, overlapChars: 10 });
    for (const chunk of chunks) {
      expect(chunk.content.includes('A') === chunk.content.includes('B')).toBe(false);
    }
  });

  it('preserves OCR method and needsReview', async () => {
    const { prisma, chunks } = makePrisma([{ pageNumber: 1, text: 'Scanned text.', extractionMethod: 'OCR', needsOcr: true }]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(chunks[0].extractionMethod).toBe('OCR');
    expect(chunks[0].needsReview).toBe(true);
  });

  it('re-running chunkDocument does not duplicate chunks', async () => {
    const { prisma } = makePrisma([{ pageNumber: 1, text: 'Stable text.' }]);
    prisma.chunk.findMany.mockResolvedValue([{ id: 'chunk-0', documentId: 'doc-1', content: 'Stable text.', page: 1, chunkIndex: 0, extractionMethod: 'TEXT', needsReview: false }]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(prisma.chunk.createMany).not.toHaveBeenCalled();
  });

  it('unchanged chunks keep embeddings', async () => {
    const { prisma } = makePrisma([{ pageNumber: 1, text: 'Stable text.' }]);
    prisma.chunk.findMany.mockResolvedValue([{ id: 'chunk-1', documentId: 'doc-1', content: 'Stable text.', page: 1, chunkIndex: 0, extractionMethod: 'TEXT', needsReview: false, embeddingModel: 'gemini-embedding-001', embedding: [0.1] }]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(prisma.chunk.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ embeddingModel: null }) }));
  });

  it('fewer chunks removes stale rows', async () => {
    const { prisma } = makePrisma([{ pageNumber: 1, text: 'Short.' }]);
    prisma.chunk.findMany.mockResolvedValue([
      { id: 'chunk-0', documentId: 'doc-1', content: 'Short.', page: 1, chunkIndex: 0, extractionMethod: 'TEXT', needsReview: false },
      { id: 'chunk-1', documentId: 'doc-1', content: 'Old extra.', page: 1, chunkIndex: 1, extractionMethod: 'TEXT', needsReview: false },
    ]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(prisma.chunk.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: { in: ['chunk-1'] } } }));
  });

  it('changed chunk content clears embedding', async () => {
    const { prisma } = makePrisma([{ pageNumber: 1, text: 'New text.' }]);
    prisma.chunk.findMany.mockResolvedValue([{ id: 'chunk-1', documentId: 'doc-1', content: 'Old text.', page: 1, chunkIndex: 0, extractionMethod: 'TEXT', needsReview: false, embeddingModel: 'gemini-embedding-001', embedding: [0.1] }]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(prisma.chunk.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ content: 'New text.', embeddingModel: null }) }));
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('empty page produces no chunk', async () => {
    const { prisma, chunks } = makePrisma([{ pageNumber: 1, text: '' }]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(chunks).toHaveLength(0);
  });

  it('metadata-only update keeps embedding', async () => {
    const { prisma } = makePrisma([{ pageNumber: 2, text: 'Stable text.', extractionMethod: 'OCR', needsOcr: true }]);
    prisma.chunk.findMany.mockResolvedValue([{ id: 'chunk-1', documentId: 'doc-1', content: 'Stable text.', page: 1, chunkIndex: 0, extractionMethod: 'TEXT', needsReview: false, embeddingModel: 'gemini-embedding-001', embedding: [0.1] }]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    expect(prisma.chunk.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ page: 2, extractionMethod: 'OCR', needsReview: true }) }));
    expect(prisma.chunk.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ embeddingModel: null }) }));
  });

  it('uses the job context to fence the document write inside the chunk transaction', async () => {
    const { prisma } = makePrisma([{ pageNumber: 1, text: 'Stable text.' }]);
    const ctx = {
      jobId: 'job-1',
      documentId: 'doc-1',
      owner: 'owner-1',
      token: 1,
      lost: false,
      updateDocument: vi.fn().mockResolvedValue(undefined),
    };
    const service = new ChunkingService(prisma as never);

    await service.chunkDocument('doc-1', {}, ctx);

    expect(ctx.updateDocument).toHaveBeenCalledWith({ status: 'PROCESSING' }, prisma);
    expect(prisma.document.update).not.toHaveBeenCalled();
  });

  it('does not write chunks when the job context is already lost', async () => {
    const { prisma } = makePrisma([{ pageNumber: 1, text: 'Stable text.' }]);
    const ctx = {
      jobId: 'job-1',
      documentId: 'doc-1',
      owner: 'owner-1',
      token: 1,
      lost: true,
      updateDocument: vi.fn().mockResolvedValue(undefined),
    };
    const service = new ChunkingService(prisma as never);

    await expect(service.chunkDocument('doc-1', {}, ctx)).rejects.toBeInstanceOf(LeaseLostError);
    expect(prisma.chunk.createMany).not.toHaveBeenCalled();
    expect(prisma.document.update).not.toHaveBeenCalled();
  });
});

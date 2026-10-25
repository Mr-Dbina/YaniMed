import { describe, expect, it, vi } from 'vitest';
import { ChunkingService } from './chunking.service.js';

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
      deleteMany: vi.fn().mockResolvedValue({}),
      createMany: vi.fn().mockImplementation(async ({ data }: { data: any[] }) => {
        chunks.push(...data);
        return { count: data.length };
      }),
    },
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

  it('is idempotent: deletes existing chunks before recreating', async () => {
    const { prisma } = makePrisma([{ pageNumber: 1, text: 'Text.' }]);
    const service = new ChunkingService(prisma as never);
    await service.chunkDocument('doc-1');
    await service.chunkDocument('doc-1');
    expect(prisma.chunk.deleteMany).toHaveBeenCalledTimes(2);
    expect(prisma.chunk.createMany).toHaveBeenCalledTimes(2);
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
});

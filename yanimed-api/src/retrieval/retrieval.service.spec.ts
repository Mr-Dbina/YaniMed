import { describe, expect, it, vi } from 'vitest';
import { RetrievalService } from './retrieval.service.js';
import { ForbiddenException } from '@nestjs/common';

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    subject: { findUnique: vi.fn().mockResolvedValue({ id: 'subject-1' }) },
    document: { count: vi.fn().mockResolvedValue(1) },
    $queryRaw: vi.fn(),
    ...overrides,
  };
}

describe('RetrievalService', () => {
  it('returns authorized subject-scoped matches', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { chunkId: 'chunk-1', documentId: 'doc-1', documentTitle: 'doc.pdf', pageNumber: 2, content: 'passage', extractionMethod: 'TEXT', score: 0.9 },
      ])
      .mockResolvedValueOnce([{ exists: true }]);
    const embeddings = { embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)) };
    const service = new RetrievalService(prisma as never, embeddings as never);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].pageNumber).toBe(2);
    expect(result.matches[0].documentId).toBe('doc-1');
    expect(embeddings.embedText).toHaveBeenCalledWith('question', 'RETRIEVAL_QUERY');
  });

  it('throws for inaccessible subjects', async () => {
    const prisma = makePrisma({ subject: { findUnique: vi.fn().mockResolvedValue(null) } });
    const embeddings = { embedText: vi.fn() };
    const service = new RetrievalService(prisma as never, embeddings as never);
    await expect(service.retrieve('missing', 'question')).rejects.toThrow(ForbiddenException);
    expect(embeddings.embedText).not.toHaveBeenCalled();
  });

  it('returns empty result when subject has no READY documents', async () => {
    const prisma = makePrisma();
    prisma.document.count.mockResolvedValue(0);
    const embeddings = { embedText: vi.fn() };
    const service = new RetrievalService(prisma as never, embeddings as never);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toEqual([]);
    expect(result.hasReadyDocuments).toBe(false);
  });

  it('excludes matches below minScore', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { chunkId: 'chunk-1', documentId: 'doc-1', documentTitle: 'doc.pdf', pageNumber: 1, content: 'passage', extractionMethod: 'TEXT', score: 0.1 },
      ])
      .mockResolvedValueOnce([{ exists: true }]);
    const embeddings = { embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)) };
    const service = new RetrievalService(prisma as never, embeddings as never);
    const result = await service.retrieve('subject-1', 'question', { minScore: 0.5 });
    expect(result.matches).toEqual([]);
  });

  it('excludes orphaned page references', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { chunkId: 'chunk-1', documentId: 'doc-1', documentTitle: 'doc.pdf', pageNumber: 99, content: 'passage', extractionMethod: 'TEXT', score: 0.9 },
      ])
      .mockResolvedValueOnce([{ exists: false }]);
    const embeddings = { embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)) };
    const service = new RetrievalService(prisma as never, embeddings as never);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toEqual([]);
  });

  it('ranks equal scores deterministically by chunk id', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        { chunkId: 'chunk-2', documentId: 'doc-1', documentTitle: 'doc.pdf', pageNumber: 1, content: 'b', extractionMethod: 'TEXT', score: 0.8 },
        { chunkId: 'chunk-1', documentId: 'doc-1', documentTitle: 'doc.pdf', pageNumber: 1, content: 'a', extractionMethod: 'TEXT', score: 0.8 },
      ])
      .mockResolvedValueOnce([{ exists: true }])
      .mockResolvedValueOnce([{ exists: true }]);
    const embeddings = { embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)) };
    const service = new RetrievalService(prisma as never, embeddings as never);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches.map(m => m.chunkId)).toEqual(['chunk-1', 'chunk-2']);
  });

  it('rejects empty questions', async () => {
    const prisma = makePrisma();
    const embeddings = { embedText: vi.fn() };
    const service = new RetrievalService(prisma as never, embeddings as never);
    await expect(service.retrieve('subject-1', '   ')).rejects.toThrow();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { RetrievalService } from './retrieval.service.js';
import { ForbiddenException } from '@nestjs/common';

interface Row {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  pageNumber: number;
  content: string;
  extractionMethod: string;
}

interface VectorRow extends Row {
  score: number;
}

function row(chunkId: string, overrides: Partial<Row> = {}): Row {
  return {
    chunkId,
    documentId: 'doc-1',
    documentTitle: 'doc.pdf',
    pageNumber: 1,
    content: `content-${chunkId}`,
    extractionMethod: 'TEXT',
    ...overrides,
  };
}

function vectorRow(chunkId: string, score: number, overrides: Partial<Row> = {}): VectorRow {
  return { ...row(chunkId, overrides), score };
}

function page(documentId = 'doc-1', pageNumber = 1): { documentId: string; pageNumber: number } {
  return { documentId, pageNumber };
}

function makeRaw(options: {
  vector?: VectorRow[];
  keyword?: Row[];
  pages?: Array<{ documentId: string; pageNumber: number }>;
  backfill?: Array<{ chunkId: string; score: number }>;
} = {}) {
  const vector = options.vector ?? [];
  const keyword = options.keyword ?? [];
  const pages = options.pages ?? [];
  const backfill = options.backfill ?? [];
  const calls = {
    vector: [] as string[],
    keyword: [] as string[],
    pages: [] as string[],
    backfill: [] as string[],
  };
  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('c."tsv"')) {
      calls.keyword.push(sql);
      return keyword;
    }
    if (sql.includes('"documentTitle"')) {
      calls.vector.push(sql);
      return vector;
    }
    if (sql.includes('FROM "DocumentPage"')) {
      calls.pages.push(sql);
      return pages;
    }
    if (sql.includes('<=>')) {
      calls.backfill.push(sql);
      return backfill;
    }
    throw new Error(`Unhandled SQL: ${sql}`);
  });
  return { queryRaw, calls };
}

function makePrisma(queryRaw: ReturnType<typeof vi.fn>, overrides: Record<string, any> = {}) {
  return {
    subject: { findUnique: vi.fn().mockResolvedValue({ id: 'subject-1' }) },
    document: { count: vi.fn().mockResolvedValue(1) },
    $queryRaw: queryRaw,
    ...overrides,
  };
}

function makeService(queryRaw: ReturnType<typeof vi.fn>, overrides: Record<string, any> = {}) {
  const prisma = makePrisma(queryRaw, overrides);
  const embeddings = { embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)) };
  return {
    service: new RetrievalService(prisma as never, embeddings as never),
    embeddings,
    prisma,
  };
}

describe('RetrievalService', () => {
  it('returns authorized subject-scoped matches with fused metadata', async () => {
    const { queryRaw, calls } = makeRaw({
      vector: [vectorRow('chunk-1', 0.9, { pageNumber: 2 })],
      pages: [page('doc-1', 2)],
    });
    const { service, embeddings } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].pageNumber).toBe(2);
    expect(result.matches[0].documentId).toBe('doc-1');
    expect(result.matches[0].matchedBy).toBe('vector');
    expect(result.matches[0].fusedScore).toBeCloseTo(1 / 61, 10);
    expect(embeddings.embedText).toHaveBeenCalledWith('question', 'RETRIEVAL_QUERY');
    expect(calls.vector[0]).toContain('d."subjectId"');
    expect(calls.keyword[0]).toContain('d."subjectId"');
  });

  it('throws for inaccessible subjects', async () => {
    const { queryRaw } = makeRaw();
    const { service, embeddings } = makeService(queryRaw, {
      subject: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(service.retrieve('missing', 'question')).rejects.toThrow(ForbiddenException);
    expect(embeddings.embedText).not.toHaveBeenCalled();
  });

  it('returns empty result when subject has no READY documents', async () => {
    const { queryRaw } = makeRaw();
    const { service, prisma } = makeService(queryRaw);
    prisma.document.count.mockResolvedValue(0);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toEqual([]);
    expect(result.hasReadyDocuments).toBe(false);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('adds a keyword-only hit and marks it matchedBy keyword', async () => {
    const { queryRaw } = makeRaw({
      vector: [vectorRow('chunk-vector', 0.6)],
      keyword: [row('chunk-keyword')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-keyword', score: 0.4 }],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question');
    const keywordHit = result.matches.find(match => match.chunkId === 'chunk-keyword');
    expect(keywordHit).toBeDefined();
    expect(keywordHit?.matchedBy).toBe('keyword');
    expect(keywordHit?.score).toBeCloseTo(0.4, 10);
  });

  it('marks a chunk in both legs as both and outranks single-leg hits', async () => {
    const { queryRaw } = makeRaw({
      vector: [vectorRow('chunk-both', 0.8), vectorRow('chunk-vector', 0.7)],
      keyword: [row('chunk-both'), row('chunk-keyword')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-keyword', score: 0.2 }],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches.map(match => match.chunkId)).toEqual([
      'chunk-both',
      'chunk-vector',
      'chunk-keyword',
    ]);
    expect(result.matches.map(match => match.matchedBy)).toEqual([
      'both',
      'vector',
      'keyword',
    ]);
  });

  it('orders by hand-computed RRF k=60 scores', async () => {
    // k=60:
    // B = 1/(60+2) + 1/(60+2) = 0.0322580645
    // A = 1/(60+1) + 1/(60+4) = 0.0320184426
    // D = 1/(60+1)               = 0.0163934426
    // E = 1/(60+3)               = 0.0158730159
    const { queryRaw } = makeRaw({
      vector: [vectorRow('A', 0.9), vectorRow('B', 0.9)],
      keyword: [row('D'), row('B'), row('E'), row('A')],
      pages: [page()],
      backfill: [
        { chunkId: 'D', score: 0.1 },
        { chunkId: 'E', score: 0.1 },
      ],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question', { topK: 4 });
    expect(result.matches.map(match => match.chunkId)).toEqual(['B', 'A', 'D', 'E']);
    expect(result.matches[0].fusedScore).toBeCloseTo(1 / 62 + 1 / 62, 10);
    expect(result.matches[1].fusedScore).toBeCloseTo(1 / 61 + 1 / 64, 10);
    expect(result.matches[2].fusedScore).toBeCloseTo(1 / 61, 10);
    expect(result.matches[3].fusedScore).toBeCloseTo(1 / 63, 10);
  });

  it('returns vector results only when the tsquery leg is empty', async () => {
    const { queryRaw, calls } = makeRaw({
      vector: [vectorRow('chunk-1', 0.8)],
      keyword: [],
      pages: [page()],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'the and of');
    expect(result.matches.map(match => match.chunkId)).toEqual(['chunk-1']);
    expect(result.matches[0].matchedBy).toBe('vector');
    expect(calls.keyword[0]).toContain('websearch_to_tsquery');
    expect(calls.backfill).toHaveLength(0);
  });

  it('applies minScore to vector-only hits but exempts keyword hits', async () => {
    const { queryRaw } = makeRaw({
      vector: [vectorRow('chunk-both', 0.9), vectorRow('chunk-low-vector', 0.2)],
      keyword: [row('chunk-low-keyword'), row('chunk-both')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-low-keyword', score: 0.1 }],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question', { minScore: 0.5 });
    expect(result.matches.map(match => match.chunkId)).toEqual([
      'chunk-both',
      'chunk-low-keyword',
    ]);
    expect(result.matches[1].score).toBeCloseTo(0.1, 10);
    expect(result.matches[1].matchedBy).toBe('keyword');
  });

  it('keeps subject and READY predicates in both SQL legs', async () => {
    const { queryRaw, calls } = makeRaw({
      vector: [vectorRow('chunk-1', 0.9)],
      keyword: [row('chunk-1')],
      pages: [page()],
    });
    const { service } = makeService(queryRaw);
    await service.retrieve('subject-1', 'question');
    for (const sql of [calls.vector[0], calls.keyword[0]]) {
      expect(sql).toContain('d."subjectId"');
      expect(sql).toContain('d."status" = \'READY\'');
    }
    expect(calls.vector[0]).toContain('<=>');
    expect(calls.keyword[0]).toContain('websearch_to_tsquery');
    expect(calls.keyword[0]).toContain('ts_rank_cd');
  });

  it('excludes matches below minScore', async () => {
    const { queryRaw, calls } = makeRaw({
      vector: [vectorRow('chunk-1', 0.1)],
      pages: [page()],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question', { minScore: 0.5 });
    expect(result.matches).toEqual([]);
    expect(calls.pages).toHaveLength(0);
  });

  it('excludes orphaned page references with one batched page query', async () => {
    const { queryRaw, calls } = makeRaw({
      vector: [vectorRow('chunk-1', 0.9, { pageNumber: 99 })],
      pages: [page('doc-1', 1)],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toEqual([]);
    expect(calls.pages).toHaveLength(1);
  });

  it('dedupes a chunk returned by both legs', async () => {
    const { queryRaw } = makeRaw({
      vector: [vectorRow('chunk-1', 0.8)],
      keyword: [row('chunk-1')],
      pages: [page()],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].chunkId).toBe('chunk-1');
    expect(result.matches[0].matchedBy).toBe('both');
  });

  it('ranks equal fused scores by cosine score', async () => {
    const { queryRaw } = makeRaw({
      vector: [vectorRow('chunk-a', 0.7)],
      keyword: [row('chunk-z')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-z', score: 0.8 }],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches.map(match => match.chunkId)).toEqual(['chunk-z', 'chunk-a']);
  });

  it('ranks equal fused and cosine scores by chunk id', async () => {
    const { queryRaw } = makeRaw({
      vector: [vectorRow('chunk-z', 0.8)],
      keyword: [row('chunk-a')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-a', score: 0.8 }],
    });
    const { service } = makeService(queryRaw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches.map(match => match.chunkId)).toEqual(['chunk-a', 'chunk-z']);
  });

  it('rejects empty questions', async () => {
    const { queryRaw } = makeRaw();
    const { service } = makeService(queryRaw);
    await expect(service.retrieve('subject-1', '   ')).rejects.toThrow();
  });
});

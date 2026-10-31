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
    prismaVector: [] as string[],
    txVector: [] as string[],
    keyword: [] as string[],
    prismaKeyword: [] as string[],
    txKeyword: [] as string[],
    pages: [] as string[],
    backfill: [] as string[],
    execute: [] as string[],
    order: [] as string[],
    transactionOptions: undefined as unknown,
  };
  const dispatch = (client: 'prisma' | 'tx') => vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('c."tsv"')) {
      calls.keyword.push(sql);
      if (client === 'tx') {
        calls.txKeyword.push(sql);
        calls.order.push('txKeyword');
      } else {
        calls.prismaKeyword.push(sql);
        calls.order.push('prismaKeyword');
      }
      return keyword;
    }
    if (sql.includes('"documentTitle"')) {
      calls.vector.push(sql);
      if (client === 'tx') {
        calls.txVector.push(sql);
        calls.order.push('txVector');
      } else {
        calls.prismaVector.push(sql);
        calls.order.push('prismaVector');
      }
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
  const queryRaw = dispatch('prisma');
  const txQueryRaw = dispatch('tx');
  const executeRawUnsafe = vi.fn(async (sql: string) => {
    calls.execute.push(sql);
    calls.order.push('executeRawUnsafe');
  });
  const tx = { $queryRaw: txQueryRaw, $executeRawUnsafe: executeRawUnsafe };
  const transaction = vi.fn(async (work: (client: typeof tx) => Promise<unknown>, options?: unknown) => {
    calls.order.push('transaction');
    calls.transactionOptions = options;
    return work(tx);
  });
  return { queryRaw, txQueryRaw, executeRawUnsafe, transaction, tx, calls };
}

function makePrisma(raw: ReturnType<typeof makeRaw>, overrides: Record<string, any> = {}) {
  return {
    subject: { findUnique: vi.fn().mockResolvedValue({ id: 'subject-1' }) },
    document: { count: vi.fn().mockResolvedValue(1) },
    $queryRaw: raw.queryRaw,
    $transaction: raw.transaction,
    ...overrides,
  };
}

function makeService(raw: ReturnType<typeof makeRaw>, overrides: Record<string, any> = {}) {
  const prisma = makePrisma(raw, overrides);
  const embeddings = { embedText: vi.fn().mockResolvedValue(Array(768).fill(0.1)) };
  return {
    service: new RetrievalService(prisma as never, embeddings as never),
    embeddings,
    prisma,
  };
}

describe('RetrievalService', () => {
  it('returns authorized subject-scoped matches with fused metadata', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-1', 0.9, { pageNumber: 2 })],
      pages: [page('doc-1', 2)],
    });
    const { service, embeddings } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].pageNumber).toBe(2);
    expect(result.matches[0].documentId).toBe('doc-1');
    expect(result.matches[0].matchedBy).toBe('vector');
    expect(result.matches[0].fusedScore).toBeCloseTo(1 / 61, 10);
    expect(embeddings.embedText).toHaveBeenCalledWith('question', 'RETRIEVAL_QUERY');
    expect(raw.calls.vector[0]).toContain('d."subjectId"');
    expect(raw.calls.keyword[0]).toContain('d."subjectId"');
  });

  it('throws for inaccessible subjects', async () => {
    const raw = makeRaw();
    const { service, embeddings } = makeService(raw, {
      subject: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(service.retrieve('missing', 'question')).rejects.toThrow(ForbiddenException);
    expect(embeddings.embedText).not.toHaveBeenCalled();
  });

  it('returns empty result when subject has no READY documents', async () => {
    const raw = makeRaw();
    const { service, prisma } = makeService(raw);
    prisma.document.count.mockResolvedValue(0);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toEqual([]);
    expect(result.hasReadyDocuments).toBe(false);
    expect(raw.queryRaw).not.toHaveBeenCalled();
  });

  it('T1 runs SET LOCAL before the tx vector query and keeps keyword on prisma', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-vector', 0.9)],
      keyword: [row('chunk-keyword')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-keyword', score: 0.3 }],
    });
    const { service } = makeService(raw);
    await service.retrieve('subject-1', 'question');

    expect(raw.transaction).toHaveBeenCalledTimes(1);
    expect(raw.calls.transactionOptions).toEqual({ timeout: 15000, maxWait: 10000 });
    expect(raw.executeRawUnsafe).toHaveBeenCalledTimes(1);
    expect(raw.executeRawUnsafe).toHaveBeenCalledWith('SET LOCAL ivfflat.probes = 100');
    expect(raw.txQueryRaw).toHaveBeenCalledTimes(1);
    expect(raw.calls.txVector).toHaveLength(1);
    expect(raw.calls.prismaVector).toHaveLength(0);
    expect(raw.calls.txKeyword).toHaveLength(0);
    expect(raw.calls.prismaKeyword).toHaveLength(1);
    expect(raw.calls.order.indexOf('executeRawUnsafe')).toBeLessThan(
      raw.calls.order.indexOf('txVector'),
    );
  });

  it('T2 ranks an exact keyword hit above a higher-cosine vector-only hit', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-vector', 0.6)],
      keyword: [row('chunk-keyword')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-keyword', score: 0.4 }],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches.map(match => match.chunkId)).toEqual([
      'chunk-keyword',
      'chunk-vector',
    ]);
    expect(result.matches[0].fusedScore).toBeCloseTo(2 / 61, 10);
    expect(result.matches[1].fusedScore).toBeCloseTo(1 / 61, 10);
  });

  it('T3 scores a both-legs hit with weighted keyword RRF', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-both', 0.8)],
      keyword: [row('chunk-both')],
      pages: [page()],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches[0].chunkId).toBe('chunk-both');
    expect(result.matches[0].matchedBy).toBe('both');
    expect(result.matches[0].fusedScore).toBeCloseTo(1 / 61 + 2 / 61, 10);
  });

  it('adds a keyword-only hit and marks it matchedBy keyword', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-vector', 0.6)],
      keyword: [row('chunk-keyword')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-keyword', score: 0.4 }],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    const keywordHit = result.matches.find(match => match.chunkId === 'chunk-keyword');
    expect(keywordHit).toBeDefined();
    expect(keywordHit?.matchedBy).toBe('keyword');
    expect(keywordHit?.score).toBeCloseTo(0.4, 10);
  });

  it('marks a chunk in both legs as both and outranks single-leg hits', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-both', 0.8), vectorRow('chunk-vector', 0.7)],
      keyword: [row('chunk-both'), row('chunk-keyword')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-keyword', score: 0.2 }],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches.map(match => match.chunkId)).toEqual([
      'chunk-both',
      'chunk-keyword',
      'chunk-vector',
    ]);
    expect(result.matches.map(match => match.matchedBy)).toEqual([
      'both',
      'keyword',
      'vector',
    ]);
  });

  it('orders by hand-computed weighted RRF k=60 scores', async () => {
    // k=60:
    // B = 1/(60+2) + 2/(60+2) = 0.0483870968
    // A = 1/(60+1) + 2/(60+4) = 0.0476434426
    // D = 2/(60+1)             = 0.0327868852
    // E = 2/(60+3)             = 0.0317460317
    const raw = makeRaw({
      vector: [vectorRow('A', 0.9), vectorRow('B', 0.9)],
      keyword: [row('D'), row('B'), row('E'), row('A')],
      pages: [page()],
      backfill: [
        { chunkId: 'D', score: 0.1 },
        { chunkId: 'E', score: 0.1 },
      ],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question', { topK: 4 });
    expect(result.matches.map(match => match.chunkId)).toEqual(['B', 'A', 'D', 'E']);
    expect(result.matches[0].fusedScore).toBeCloseTo(1 / 62 + 2 / 62, 10);
    expect(result.matches[1].fusedScore).toBeCloseTo(1 / 61 + 2 / 64, 10);
    expect(result.matches[2].fusedScore).toBeCloseTo(2 / 61, 10);
    expect(result.matches[3].fusedScore).toBeCloseTo(2 / 63, 10);
  });

  it('returns vector results only when the tsquery leg is empty', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-1', 0.8)],
      keyword: [],
      pages: [page()],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'the and of');
    expect(result.matches.map(match => match.chunkId)).toEqual(['chunk-1']);
    expect(result.matches[0].matchedBy).toBe('vector');
    expect(raw.calls.keyword[0]).toContain('websearch_to_tsquery');
    expect(raw.calls.backfill).toHaveLength(0);
  });

  it('T4 applies minScore to vector-only hits but exempts keyword hits', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-both', 0.9), vectorRow('chunk-low-vector', 0.2)],
      keyword: [row('chunk-low-keyword'), row('chunk-both')],
      pages: [page()],
      backfill: [{ chunkId: 'chunk-low-keyword', score: 0.1 }],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question', { minScore: 0.5 });
    expect(result.matches.map(match => match.chunkId)).toEqual([
      'chunk-both',
      'chunk-low-keyword',
    ]);
    expect(result.matches.some(match => match.chunkId === 'chunk-low-vector')).toBe(false);
    expect(result.matches[1].score).toBeCloseTo(0.1, 10);
    expect(result.matches[1].matchedBy).toBe('keyword');
    expect(result.matches[1].fusedScore).toBeCloseTo(2 / 61, 10);
  });

  it('keeps subject and READY predicates in both SQL legs', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-1', 0.9)],
      keyword: [row('chunk-1')],
      pages: [page()],
    });
    const { service } = makeService(raw);
    await service.retrieve('subject-1', 'question');
    for (const sql of [raw.calls.vector[0], raw.calls.keyword[0]]) {
      expect(sql).toContain('d."subjectId"');
      expect(sql).toContain('d."status" = \'READY\'');
    }
    expect(raw.calls.vector[0]).toContain('<=>');
    expect(raw.calls.keyword[0]).toContain('websearch_to_tsquery');
    expect(raw.calls.keyword[0]).toContain('ts_rank_cd');
  });

  it('excludes matches below minScore', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-1', 0.1)],
      pages: [page()],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question', { minScore: 0.5 });
    expect(result.matches).toEqual([]);
    expect(raw.calls.pages).toHaveLength(0);
  });

  it('excludes orphaned page references with one batched page query', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-1', 0.9, { pageNumber: 99 })],
      pages: [page('doc-1', 1)],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toEqual([]);
    expect(raw.calls.pages).toHaveLength(1);
  });

  it('dedupes a chunk returned by both legs', async () => {
    const raw = makeRaw({
      vector: [vectorRow('chunk-1', 0.8)],
      keyword: [row('chunk-1')],
      pages: [page()],
    });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].chunkId).toBe('chunk-1');
    expect(result.matches[0].matchedBy).toBe('both');
  });

  it('ranks equal fused scores by cosine score', async () => {
    const vector = Array.from({ length: 24 }, (_, index) => vectorRow(`chunk-v${index + 1}`, 0.1));
    vector[2] = vectorRow('chunk-cosine-loser', 0.7);
    vector[23] = vectorRow('chunk-cosine-winner', 0.8);
    const keyword = Array.from({ length: 12 }, (_, index) => row(`chunk-k${index + 1}`));
    keyword[2] = row('chunk-cosine-winner');
    keyword[11] = row('chunk-cosine-loser');

    const raw = makeRaw({ vector, keyword, pages: [page()] });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches[0].chunkId).toBe('chunk-cosine-winner');
    expect(result.matches[1].chunkId).toBe('chunk-cosine-loser');
    expect(result.matches[0].fusedScore).toBeCloseTo(1 / 84 + 2 / 63, 10);
    expect(result.matches[1].fusedScore).toBeCloseTo(1 / 63 + 2 / 72, 10);
  });

  it('ranks equal fused and cosine scores by chunk id', async () => {
    const vector = Array.from({ length: 24 }, (_, index) => vectorRow(`chunk-v${index + 1}`, 0.1));
    vector[2] = vectorRow('chunk-z', 0.8);
    vector[23] = vectorRow('chunk-a', 0.8);
    const keyword = Array.from({ length: 12 }, (_, index) => row(`chunk-k${index + 1}`));
    keyword[2] = row('chunk-a');
    keyword[11] = row('chunk-z');

    const raw = makeRaw({ vector, keyword, pages: [page()] });
    const { service } = makeService(raw);
    const result = await service.retrieve('subject-1', 'question');
    expect(result.matches[0].chunkId).toBe('chunk-a');
    expect(result.matches[1].chunkId).toBe('chunk-z');
    expect(result.matches[0].fusedScore).toBeCloseTo(1 / 84 + 2 / 63, 10);
    expect(result.matches[1].fusedScore).toBeCloseTo(1 / 63 + 2 / 72, 10);
  });

  it('rejects empty questions', async () => {
    const raw = makeRaw();
    const { service } = makeService(raw);
    await expect(service.retrieve('subject-1', '   ')).rejects.toThrow();
  });
});

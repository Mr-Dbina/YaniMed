import { describe, expect, it } from 'vitest';
import {
  pageKey,
  pagesByKey,
  resolveStyleHint,
  toPlannerChunk,
  type SnapshotChunkRow,
} from './job-source.js';

function chunkRow(overrides: Partial<SnapshotChunkRow> = {}): SnapshotChunkRow {
  return {
    id: 'chunk-1',
    documentId: 'doc-1',
    content: 'ZZ-m5 chunk body',
    page: 3,
    chunkIndex: 0,
    needsReview: false,
    embeddingText: null,
    ...overrides,
  };
}

describe('job source mapping', () => {
  it('parses a vector from pgvector text', () => {
    const chunk = toPlannerChunk(
      chunkRow({ embeddingText: '[0.5,-0.25,1]' }),
    );

    expect(chunk.embedding).toEqual([0.5, -0.25, 1]);
    expect(chunk).toMatchObject({
      id: 'chunk-1',
      documentId: 'doc-1',
      content: 'ZZ-m5 chunk body',
      page: 3,
      chunkIndex: 0,
      needsReview: false,
    });
  });

  it('gives a null embedding for a missing vector', () => {
    expect(toPlannerChunk(chunkRow({ embeddingText: null })).embedding).toBeNull();
    expect(toPlannerChunk(chunkRow({ embeddingText: '' })).embedding).toBeNull();
  });

  it('gives a null embedding when no value parses', () => {
    expect(
      toPlannerChunk(chunkRow({ embeddingText: 'not-a-vector' })).embedding,
    ).toBeNull();
  });

  it('keeps the values that do parse in a partly broken vector', () => {
    expect(
      toPlannerChunk(chunkRow({ embeddingText: '[0.1,oops,0.3]' })).embedding,
    ).toEqual([0.1, 0.3]);
  });

  it('keys pages by document id and page number', () => {
    expect(pageKey('doc-1', 7)).toBe('doc-1:7');
  });

  it('treats an OCR page as needing OCR and keeps missing pages absent', () => {
    const pages = pagesByKey([
      {
        documentId: 'doc-1',
        pageNumber: 1,
        text: 'ZZ-m5 OCR page',
        needsOcr: false,
        ocrUsed: true,
      },
      {
        documentId: 'doc-1',
        pageNumber: 2,
        text: 'ZZ-m5 plain page',
        needsOcr: false,
        ocrUsed: false,
      },
    ]);

    expect(pages.get('doc-1:1')).toEqual({
      text: 'ZZ-m5 OCR page',
      needsOcr: true,
    });
    expect(pages.get('doc-1:2')).toEqual({
      text: 'ZZ-m5 plain page',
      needsOcr: false,
    });
    expect(pages.has('doc-1:3')).toBe(false);
    expect(pages.size).toBe(2);
  });

  it('resolves every subject to the clinical stem placeholder', () => {
    expect(resolveStyleHint('Pediatrics')).toBe('CLINICAL_STEM');
    expect(resolveStyleHint('')).toBe('CLINICAL_STEM');
  });
});

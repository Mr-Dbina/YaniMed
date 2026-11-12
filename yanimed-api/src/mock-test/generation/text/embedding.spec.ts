import { describe, expect, it } from 'vitest';
import { parseEmbedding } from './embedding.js';

describe('parseEmbedding', () => {
  it('returns an empty array for missing input', () => {
    expect(parseEmbedding(null)).toEqual([]);
    expect(parseEmbedding(undefined)).toEqual([]);
    expect(parseEmbedding('')).toEqual([]);
    expect(parseEmbedding('[]')).toEqual([]);
  });

  it('parses a pgvector string', () => {
    expect(parseEmbedding('[1,2,3]')).toEqual([1, 2, 3]);
    expect(parseEmbedding(' [1, 2, 3] ')).toEqual([1, 2, 3]);
  });

  it('drops non-finite entries', () => {
    expect(parseEmbedding('[1, abc, 3]')).toEqual([1, 3]);
    expect(parseEmbedding('[NaN, 2]')).toEqual([2]);
  });

  it('parses negative and decimal values', () => {
    expect(parseEmbedding('[-0.5,0.25]')).toEqual([-0.5, 0.25]);
  });
});

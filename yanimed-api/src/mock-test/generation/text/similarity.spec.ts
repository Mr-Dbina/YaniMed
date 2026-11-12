import { describe, expect, it } from 'vitest';
import {
  cosine,
  fuzzyQuoteSimilarity,
  normalizeForMatch,
} from './similarity.js';

describe('normalizeForMatch', () => {
  it('lowercases, strips punctuation and collapses whitespace', () => {
    expect(normalizeForMatch('  Niño,  with FIEBRE! ')).toBe(
      'niño with fiebre',
    );
  });
});

describe('cosine', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it('returns 0 for empty, mismatched or zero vectors', () => {
    expect(cosine([], [])).toBe(0);
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
    expect(cosine([0, 0], [1, 2])).toBe(0);
  });
});

describe('fuzzyQuoteSimilarity', () => {
  it('returns 1 for an exact substring after normalization', () => {
    expect(
      fuzzyQuoteSimilarity(
        'Fever is common in children.',
        'fever is common',
      ),
    ).toBe(1);
  });

  it('returns a high score for light OCR noise', () => {
    const score = fuzzyQuoteSimilarity(
      'The child has a fever and a rash on the trunk.',
      'The child has a fever and rash on the trunk.',
    );
    expect(score).toBeGreaterThan(0.8);
    expect(score).toBeLessThan(1);
  });

  it('returns 0 for an empty quote or a page shorter than the quote', () => {
    expect(fuzzyQuoteSimilarity('Some page text.', '')).toBe(0);
    expect(fuzzyQuoteSimilarity('short', 'a much longer quote')).toBe(0);
  });

  it('caps the page before scanning', () => {
    const page = `${'x '.repeat(1000)}the target quote is here`;
    expect(
      fuzzyQuoteSimilarity(page, 'the target quote is here', {
        maxPageChars: 100,
      }),
    ).toBe(0);
    expect(
      fuzzyQuoteSimilarity(page, 'the target quote is here', {
        maxPageChars: 20_000,
      }),
    ).toBe(1);
  });

  it('handles unicode text', () => {
    expect(
      fuzzyQuoteSimilarity('Fiebre alta en el niño.', 'fiebre alta'),
    ).toBe(1);
  });
});

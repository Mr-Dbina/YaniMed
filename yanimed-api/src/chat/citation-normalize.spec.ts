import { describe, expect, it } from 'vitest';
import { normalizeCitationBrackets } from './citation-normalize.js';

describe('normalizeCitationBrackets', () => {
  it('H1 converts 【S3】 to [S3]', () => {
    expect(normalizeCitationBrackets('【S3】')).toBe('[S3]');
  });

  it('H2 converts ［S2］ to [S2]', () => {
    expect(normalizeCitationBrackets('［S2］')).toBe('[S2]');
  });

  it('H3 converts 【 S1 】 to [S1]', () => {
    expect(normalizeCitationBrackets('【 S1 】')).toBe('[S1]');
  });

  it('H4 converts multiple markers in one sentence', () => {
    expect(normalizeCitationBrackets('a【S1】 b［S12］.')).toBe('a[S1] b[S12].');
  });

  it('H5 leaves unsupported marker forms unchanged', () => {
    const unchanged = ['【Note】', '【S】', '【S1x】', '【S1］', '【s1】', '【S1'];
    for (const value of unchanged) {
      expect(normalizeCitationBrackets(value)).toBe(value);
    }
  });

  it('H6 leaves ASCII markers and plain text unchanged', () => {
    expect(normalizeCitationBrackets('[S1] plain text')).toBe('[S1] plain text');
  });

  it('H7 returns an empty string unchanged', () => {
    expect(normalizeCitationBrackets('')).toBe('');
  });
});

import { describe, expect, it } from 'vitest';
import {
  LETTER_MAX,
  LETTER_MIN,
  QUESTIONS_PER_TEST,
} from '../generation.constants.js';
import { allocateLetters } from './letters.js';
import { createSeededRng } from './rng.js';

describe('allocateLetters', () => {
  it('returns one letter per question', () => {
    expect(allocateLetters(createSeededRng(1))).toHaveLength(
      QUESTIONS_PER_TEST,
    );
  });

  it('uses the 6/6/6/7 pattern', () => {
    const letters = allocateLetters(createSeededRng(2));
    const counts = ['A', 'B', 'C', 'D'].map(
      (letter) => letters.filter((value) => value === letter).length,
    );

    expect(counts.sort((a, b) => a - b)).toEqual([6, 6, 6, 7]);
  });

  it('keeps every letter inside 5 to 8', () => {
    const letters = allocateLetters(createSeededRng(3));
    for (const letter of ['A', 'B', 'C', 'D']) {
      const count = letters.filter((value) => value === letter).length;
      expect(count).toBeGreaterThanOrEqual(LETTER_MIN);
      expect(count).toBeLessThanOrEqual(LETTER_MAX);
    }
  });

  it('is deterministic for the same seed', () => {
    expect(allocateLetters(createSeededRng(9))).toEqual(
      allocateLetters(createSeededRng(9)),
    );
  });

  it('changes with the seed', () => {
    expect(allocateLetters(createSeededRng(9))).not.toEqual(
      allocateLetters(createSeededRng(10)),
    );
  });
});

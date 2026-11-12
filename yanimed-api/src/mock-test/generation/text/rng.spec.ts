import { describe, expect, it } from 'vitest';
import {
  createSeededRng,
  seedFromString,
  shuffle,
} from './rng.js';

describe('createSeededRng', () => {
  it('returns the same sequence for the same seed', () => {
    const first = createSeededRng(42);
    const second = createSeededRng(42);
    const a = Array.from({ length: 8 }, () => first());
    const b = Array.from({ length: 8 }, () => second());

    expect(a).toEqual(b);
    for (const value of a) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('returns a different sequence for a different seed', () => {
    expect(createSeededRng(1)()).not.toBe(createSeededRng(2)());
  });
});

describe('seedFromString', () => {
  it('is stable and distinguishes strings', () => {
    expect(seedFromString('slot-1')).toBe(seedFromString('slot-1'));
    expect(seedFromString('slot-1')).not.toBe(seedFromString('slot-2'));
  });

  it('handles empty and unicode strings', () => {
    expect(Number.isInteger(seedFromString(''))).toBe(true);
    expect(Number.isInteger(seedFromString('Niño – fiebre'))).toBe(true);
  });
});

describe('shuffle', () => {
  it('preserves every element and is deterministic', () => {
    const input = [1, 2, 3, 4, 5];
    const first = shuffle(input, createSeededRng(7));
    const second = shuffle(input, createSeededRng(7));

    expect(first).toEqual(second);
    expect([...first].sort((a, b) => a - b)).toEqual(input);
    expect(input).toEqual([1, 2, 3, 4, 5]);
  });
});

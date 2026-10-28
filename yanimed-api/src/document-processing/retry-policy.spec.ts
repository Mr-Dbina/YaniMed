import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './retry-policy.js';

describe('retryDelayMs', () => {
  it.each([
    [1, 30_000],
    [2, 120_000],
    [3, 600_000],
    [4, 600_000],
  ])('uses the base delay for attempt %i', (attempt, base) => {
    expect(retryDelayMs(attempt, () => 0)).toBe(base);
    expect(retryDelayMs(attempt, () => 0.5)).toBe(base + base * 0.1);
    expect(retryDelayMs(attempt, () => 1)).toBe(base + base * 0.2);
  });

  it('keeps jitter within 0-20 percent of the base delay', () => {
    for (const attempt of [1, 2, 3, 4]) {
      const base = retryDelayMs(attempt, () => 0);
      expect(retryDelayMs(attempt, () => 0.25)).toBeGreaterThanOrEqual(base);
      expect(retryDelayMs(attempt, () => 0.25)).toBeLessThanOrEqual(base * 1.2);
      expect(retryDelayMs(attempt, () => 0.75)).toBeGreaterThanOrEqual(base);
      expect(retryDelayMs(attempt, () => 0.75)).toBeLessThanOrEqual(base * 1.2);
    }
  });
});

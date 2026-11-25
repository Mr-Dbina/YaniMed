import { describe, expect, it } from 'vitest';
import {
  accuracyPercent,
  sortByWeakestTopic,
  rangeDays,
  isAnalyticsRange,
} from './analytics.logic.js';
import type { AnalyticsTopicMetricDto } from './analytics.dto.js';

function topic(overrides: Partial<AnalyticsTopicMetricDto>): AnalyticsTopicMetricDto {
  return {
    subjectId: 'subject-1',
    subject: 'Subject',
    topicKey: 'topic',
    topic: 'Topic',
    totalAnswered: 10,
    correctCount: 5,
    accuracyPercent: 50,
    ...overrides,
  };
}

describe('accuracyPercent', () => {
  it.each([
    [5, 10, 50],
    [1, 3, 33],
    [2, 3, 67],
    [5, 5, 100],
    [0, 10, 0],
    [7, 10, 70],
    [8, 10, 80],
    [9, 10, 90],
  ])('calculates %i/%i = %i%%', (correct, total, expected) => {
    expect(accuracyPercent(correct, total)).toBe(expected);
  });

  it('returns null for zero or negative total', () => {
    expect(accuracyPercent(5, 0)).toBeNull();
    expect(accuracyPercent(5, -1)).toBeNull();
  });

  it('returns null for non-finite inputs', () => {
    expect(accuracyPercent(NaN, 10)).toBeNull();
    expect(accuracyPercent(5, Infinity)).toBeNull();
  });
});

describe('sortByWeakestTopic', () => {
  it('orders by lowest accuracy first', () => {
    const rows = [
      topic({ topicKey: 'a', accuracyPercent: 90, totalAnswered: 10, correctCount: 9 }),
      topic({ topicKey: 'b', accuracyPercent: 50, totalAnswered: 10, correctCount: 5 }),
      topic({ topicKey: 'c', accuracyPercent: 70, totalAnswered: 10, correctCount: 7 }),
    ];
    expect(sortByWeakestTopic(rows).map((r) => r.topicKey)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties by higher total answered', () => {
    const rows = [
      topic({ topicKey: 'low-total', accuracyPercent: 50, totalAnswered: 10, correctCount: 5 }),
      topic({ topicKey: 'high-total', accuracyPercent: 50, totalAnswered: 20, correctCount: 10 }),
    ];
    expect(sortByWeakestTopic(rows).map((r) => r.topicKey)).toEqual(['high-total', 'low-total']);
  });

  it('breaks ties by topic key for determinism', () => {
    const rows = [
      topic({ topicKey: 'z-topic', accuracyPercent: 50, totalAnswered: 10, correctCount: 5 }),
      topic({ topicKey: 'a-topic', accuracyPercent: 50, totalAnswered: 10, correctCount: 5 }),
    ];
    expect(sortByWeakestTopic(rows).map((r) => r.topicKey)).toEqual(['a-topic', 'z-topic']);
  });

  it('treats null accuracy as 100 (excluded from weak areas)', () => {
    const rows = [
      topic({ topicKey: 'no-answers', accuracyPercent: null, totalAnswered: 0, correctCount: 0 }),
      topic({ topicKey: 'bad', accuracyPercent: 30, totalAnswered: 10, correctCount: 3 }),
    ];
    expect(sortByWeakestTopic(rows).map((r) => r.topicKey)).toEqual(['bad', 'no-answers']);
  });

  it('returns empty array for empty input', () => {
    expect(sortByWeakestTopic([])).toEqual([]);
  });
});

describe('rangeDays', () => {
  it('maps ranges to day counts', () => {
    expect(rangeDays('7')).toBe(7);
    expect(rangeDays('30')).toBe(30);
    expect(rangeDays('90')).toBe(90);
    expect(rangeDays('all')).toBeNull();
  });
});

describe('isAnalyticsRange', () => {
  it('accepts valid ranges', () => {
    expect(isAnalyticsRange('7')).toBe(true);
    expect(isAnalyticsRange('30')).toBe(true);
    expect(isAnalyticsRange('90')).toBe(true);
    expect(isAnalyticsRange('all')).toBe(true);
  });

  it('rejects invalid ranges', () => {
    expect(isAnalyticsRange('14')).toBe(false);
    expect(isAnalyticsRange('60')).toBe(false);
    expect(isAnalyticsRange('')).toBe(false);
    expect(isAnalyticsRange(null)).toBe(false);
    expect(isAnalyticsRange(undefined)).toBe(false);
  });
});
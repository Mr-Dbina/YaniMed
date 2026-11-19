import { describe, expect, it } from 'vitest';
import {
  addDays,
  ageDays,
  averagePercent,
  currentStreak,
  labelForPercent,
  manilaDateKey,
  percentFromScore,
  rangeDays,
  roundPercent,
  selectFocusTopics,
  type FocusTopicRow,
} from './dashboard.logic.js';

function topic(overrides: Partial<FocusTopicRow>): FocusTopicRow {
  return {
    subjectId: 'subject-1',
    subjectName: 'Subject',
    topicKey: 'topic',
    topicName: 'Topic',
    correct: 0,
    total: 2,
    ...overrides,
  };
}

describe('score bands', () => {
  it.each([
    [59, 'BAD'],
    [60, 'GOOD'],
    [79, 'GOOD'],
    [80, 'EXCELLENT'],
  ])('labels %i as %s', (percent, label) => {
    expect(labelForPercent(percent)).toBe(label);
  });

  it('rounds percent from score and total', () => {
    expect(percentFromScore(2, 3)).toBe(67);
    expect(percentFromScore(1, 3)).toBe(33);
    expect(percentFromScore(5, 5)).toBe(100);
    expect(percentFromScore(0, 0)).toBe(0);
  });

  it('rounds a mean and returns null for no attempts', () => {
    expect(averagePercent([60, 61])).toBe(61);
    expect(averagePercent([59.4])).toBe(59);
    expect(averagePercent([])).toBeNull();
    expect(roundPercent(79.5)).toBe(80);
  });
});

describe('Manila dates', () => {
  it('maps a UTC evening to the next Manila day', () => {
    expect(manilaDateKey('2026-11-18T16:30:00.000Z')).toBe('2026-11-19');
    expect(manilaDateKey('2026-11-18T15:59:59.000Z')).toBe('2026-11-18');
  });

  it('adds days across a month boundary', () => {
    expect(addDays('2026-11-01', -1)).toBe('2026-10-31');
  });
});

describe('currentStreak', () => {
  it('counts back from today', () => {
    expect(currentStreak(['2026-11-17', '2026-11-18', '2026-11-19'], '2026-11-19')).toBe(3);
  });

  it('counts back from yesterday when today has no activity', () => {
    expect(currentStreak(['2026-11-17', '2026-11-18'], '2026-11-19')).toBe(2);
  });

  it('stops at a gap', () => {
    expect(currentStreak(['2026-11-16', '2026-11-18', '2026-11-19'], '2026-11-19')).toBe(2);
  });

  it('returns 0 when neither today nor yesterday has activity', () => {
    expect(currentStreak(['2026-11-15', '2026-11-16'], '2026-11-19')).toBe(0);
    expect(currentStreak([], '2026-11-19')).toBe(0);
  });
});

describe('range', () => {
  it('maps the three ranges to day counts', () => {
    expect(rangeDays('7')).toBe(7);
    expect(rangeDays('30')).toBe(30);
    expect(rangeDays('all')).toBeNull();
  });
});

describe('focusTopics', () => {
  it('excludes exactly 80% and a topic with one answer', () => {
    const rows = [
      topic({ topicKey: 'at-80', correct: 8, total: 10 }),
      topic({ topicKey: 'below-80', correct: 7, total: 10 }),
      topic({ topicKey: 'one', correct: 0, total: 1 }),
    ];
    expect(selectFocusTopics(rows).map((row) => row.topicKey)).toEqual(['below-80']);
  });

  it('orders by lowest accuracy first and breaks ties by higher total', () => {
    const rows = [
      topic({ topicKey: 'high-total', correct: 10, total: 20 }),
      topic({ topicKey: 'low-total', correct: 5, total: 10 }),
      topic({ topicKey: 'worse', correct: 1, total: 10 }),
    ];
    expect(selectFocusTopics(rows).map((row) => row.topicKey)).toEqual([
      'worse',
      'high-total',
      'low-total',
    ]);
  });

  it('keeps at most five topics', () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      topic({ topicKey: `topic-${index}`, correct: index, total: 10 }),
    );
    expect(selectFocusTopics(rows)).toHaveLength(5);
  });

  it('returns an empty list when nothing qualifies', () => {
    expect(selectFocusTopics([])).toEqual([]);
  });
});

describe('ageDays', () => {
  const now = new Date('2026-11-19T12:00:00.000Z');

  it('keeps 14 days at 14 and crosses at 15', () => {
    expect(ageDays('2026-11-05T12:00:00.000Z', now)).toBe(14);
    expect(ageDays('2026-11-04T12:00:00.000Z', now)).toBe(15);
  });

  it('floors a partial day and clamps a future timestamp', () => {
    expect(ageDays('2026-11-19T11:59:00.000Z', now)).toBe(0);
    expect(ageDays('2026-11-20T12:00:00.000Z', now)).toBe(0);
  });
});

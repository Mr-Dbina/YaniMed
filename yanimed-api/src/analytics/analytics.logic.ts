/** Pure helpers for analytics computations. The service imports no Prisma here. */
import type { AnalyticsTopicMetricDto } from './analytics.dto.js';

/** Rounds a ratio to a percent, or null when there are no answered questions. */
export function accuracyPercent(correctCount: number, totalAnswered: number): number | null {
  if (!Number.isFinite(correctCount) || !Number.isFinite(totalAnswered)) return null;
  if (totalAnswered <= 0) return null;
  return Math.round((correctCount / totalAnswered) * 100);
}

/** Lowest accuracy first, then higher total answered, then topic key for determinism. */
export function sortByWeakestTopic<T extends AnalyticsTopicMetricDto>(topics: readonly T[]): T[] {
  return [...topics].sort((a, b) => {
    const aAcc = a.accuracyPercent ?? 100;
    const bAcc = b.accuracyPercent ?? 100;
    return (
      aAcc - bAcc ||
      b.totalAnswered - a.totalAnswered ||
      a.topicKey.localeCompare(b.topicKey)
    );
  });
}

export type AnalyticsRange = '7' | '30' | '90' | 'all';

export function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return value === '7' || value === '30' || value === '90' || value === 'all';
}

export function rangeDays(range: AnalyticsRange): number | null {
  return range === 'all' ? null : Number(range);
}

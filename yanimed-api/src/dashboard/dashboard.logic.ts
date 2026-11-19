export type DashboardRange = '7' | '30' | 'all';
export type ScoreLabel = 'BAD' | 'GOOD' | 'EXCELLENT' | 'NO_DATA';

export const DASHBOARD_TIMEZONE = 'Asia/Manila';
const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isDashboardRange(value: unknown): value is DashboardRange {
  return value === '7' || value === '30' || value === 'all';
}

/** Days back for a range, or null for all history. */
export function rangeDays(range: DashboardRange): number | null {
  return range === 'all' ? null : Number(range);
}

/** Asia/Manila is a fixed +08:00 offset with no DST. */
export function manilaDateKey(value: Date | string): string {
  const ms = typeof value === 'string' ? Date.parse(value) : value.getTime();
  if (!Number.isFinite(ms)) return '';
  return new Date(ms + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

export function manilaToday(now: Date = new Date()): string {
  return manilaDateKey(now);
}

export function percentFromScore(score: number, total: number): number {
  if (!Number.isFinite(score) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.round((score / total) * 100);
}

export function roundPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

export function labelForPercent(percent: number): ScoreLabel {
  if (percent < 60) return 'BAD';
  if (percent < 80) return 'GOOD';
  return 'EXCELLENT';
}

/** Mean of per-attempt percents, rounded; null when there is no attempt. */
export function averagePercent(percents: readonly number[]): number | null {
  if (percents.length === 0) return null;
  const sum = percents.reduce((total, value) => total + value, 0);
  return roundPercent(sum / percents.length);
}

export function addDays(dateKey: string, days: number): string {
  const ms = Date.parse(`${dateKey}T00:00:00.000Z`);
  return new Date(ms + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Consecutive study days ending today, or ending yesterday when today has no
 * activity. Any gap before that stops the streak.
 */
export function currentStreak(studyDays: readonly string[], today: string): number {
  const days = new Set(studyDays.filter((day) => day !== ''));
  const yesterday = addDays(today, -1);
  let cursor: string;
  if (days.has(today)) cursor = today;
  else if (days.has(yesterday)) cursor = yesterday;
  else return 0;

  let streak = 0;
  while (days.has(cursor)) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

export interface FocusTopicRow {
  subjectId: string;
  subjectName: string;
  topicKey: string;
  topicName: string;
  correct: number;
  total: number;
}

/** Lowest accuracy first, then higher total. Exactly 80% is excluded. */
export function selectFocusTopics(
  rows: readonly FocusTopicRow[],
  limit = 5,
): FocusTopicRow[] {
  return rows
    .filter((row) => row.total >= 2 && row.correct / row.total < 0.8)
    .sort(
      (a, b) =>
        a.correct / a.total - b.correct / b.total ||
        b.total - a.total ||
        a.topicKey.localeCompare(b.topicKey),
    )
    .slice(0, limit);
}

/** Whole days between createdAt and now; 14 stays 14, 15 crosses the line. */
export function ageDays(createdAt: Date | string, now: Date = new Date()): number {
  const created =
    typeof createdAt === 'string' ? Date.parse(createdAt) : createdAt.getTime();
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((now.getTime() - created) / DAY_MS));
}

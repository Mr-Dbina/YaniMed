const RETRY_BASE_DELAYS_MS = [30_000, 120_000, 600_000] as const;
const RETRY_JITTER_RATIO = 0.2;

export function retryDelayMs(attempt: number, random: () => number = Math.random): number {
  const index = Math.min(Math.max(Math.trunc(attempt), 1), RETRY_BASE_DELAYS_MS.length) - 1;
  const base = RETRY_BASE_DELAYS_MS[index];
  return Math.round(base * (1 + RETRY_JITTER_RATIO * random()));
}

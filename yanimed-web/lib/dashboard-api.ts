import { API_BASE_URL } from "@/lib/api";

export type DashboardRange = "7" | "30" | "all";

export type DashboardBandLabel = "BAD" | "GOOD" | "EXCELLENT" | "NO_DATA";

export interface DashboardTotals {
  testsTaken: number;
  questionsAnswered: number;
}

export interface DashboardHeatmapDay {
  date: string;
  count: number;
}

export interface DashboardStudy {
  currentStreak: number;
  heatmap: DashboardHeatmapDay[];
}

export interface DashboardSubject {
  subjectId: string;
  name: string;
  averagePercent: number | null;
  label: DashboardBandLabel;
}

export interface DashboardFocusTopic {
  topicKey: string;
  topicName: string;
  subjectId: string;
  subjectName: string;
}

export interface DashboardRecentTest {
  attemptId: string;
  subjectId: string;
  subjectName: string;
  percent: number;
  label: DashboardBandLabel;
  completedAt: string;
}

export interface DashboardUnfinished {
  attemptId: string;
  subjectId: string;
  subjectName: string;
  status: string;
  answered: number;
  total: number;
  lastActivityAt: string;
  ageDays: number;
  overFourteenDays: boolean;
}

export interface DashboardData {
  generatedAt: string;
  timezone: string;
  range: DashboardRange;
  totals: DashboardTotals;
  study: DashboardStudy;
  subjects: DashboardSubject[];
  focusTopics: DashboardFocusTopic[];
  recentTests: DashboardRecentTest[];
  unfinished: DashboardUnfinished[];
}

export class DashboardApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DashboardApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isDashboardData(value: unknown): value is DashboardData {
  if (!isRecord(value) || !isRecord(value.totals) || !isRecord(value.study)) return false;
  return (
    typeof value.generatedAt === "string" &&
    typeof value.timezone === "string" &&
    typeof value.totals.testsTaken === "number" &&
    typeof value.totals.questionsAnswered === "number" &&
    typeof value.study.currentStreak === "number" &&
    Array.isArray(value.study.heatmap) &&
    Array.isArray(value.subjects) &&
    Array.isArray(value.focusTopics) &&
    Array.isArray(value.recentTests) &&
    Array.isArray(value.unfinished)
  );
}

export async function getDashboard(
  range: DashboardRange,
  signal?: AbortSignal,
): Promise<DashboardData> {
  let response: Response;
  try {
    response = await fetch(
      `${API_BASE_URL}/dashboard?range=${encodeURIComponent(range)}`,
      { signal, cache: "no-store" },
    );
  } catch {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    throw new DashboardApiError(
      `Could not reach the API at ${API_BASE_URL}. Check the server and try again.`,
    );
  }

  if (!response.ok) {
    throw new DashboardApiError(
      `Dashboard request failed with status ${response.status}.`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DashboardApiError("The API returned an invalid JSON response.");
  }

  if (!isDashboardData(body)) {
    throw new DashboardApiError("The API returned an invalid dashboard response.");
  }
  return body;
}

import { API_BASE_URL } from "@/lib/api";

export type AnalyticsRange = "7" | "30" | "90" | "all";

export interface AnalyticsBySubjectItem {
  subjectId: string;
  subject: string;
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number | null;
}

export interface AnalyticsByTopicItem {
  subjectId: string;
  subject: string;
  topicKey: string;
  topic: string;
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number | null;
}

export interface AnalyticsAvailableTopicItem {
  topicKey: string;
  topic: string;
}

export interface AnalyticsOverall {
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number | null;
  completedTestsCount: number;
}

export interface AnalyticsSummaryResponse {
  generatedAt: string;
  range: AnalyticsRange;
  subjectId: string | null;
  topic: string | null;
  overall: AnalyticsOverall;
  bySubject: AnalyticsBySubjectItem[];
  byTopic: AnalyticsByTopicItem[];
  availableTopics: AnalyticsAvailableTopicItem[];
}

export class AnalyticsApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AnalyticsApiError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return value === "7" || value === "30" || value === "90" || value === "all";
}

function isAnalyticsBySubjectItem(value: unknown): value is AnalyticsBySubjectItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.subjectId === "string" &&
    typeof value.subject === "string" &&
    typeof value.totalAnswered === "number" &&
    typeof value.correctCount === "number" &&
    isNullableNumber(value.accuracyPercent)
  );
}

function isAnalyticsByTopicItem(value: unknown): value is AnalyticsByTopicItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.subjectId === "string" &&
    typeof value.subject === "string" &&
    typeof value.topicKey === "string" &&
    typeof value.topic === "string" &&
    typeof value.totalAnswered === "number" &&
    typeof value.correctCount === "number" &&
    isNullableNumber(value.accuracyPercent)
  );
}

function isAnalyticsAvailableTopicItem(value: unknown): value is AnalyticsAvailableTopicItem {
  if (!isRecord(value)) return false;
  return typeof value.topicKey === "string" && typeof value.topic === "string";
}

function isAnalyticsOverall(value: unknown): value is AnalyticsOverall {
  if (!isRecord(value)) return false;
  return (
    typeof value.totalAnswered === "number" &&
    typeof value.correctCount === "number" &&
    isNullableNumber(value.accuracyPercent) &&
    typeof value.completedTestsCount === "number"
  );
}

export function isAnalyticsSummaryResponse(value: unknown): value is AnalyticsSummaryResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.generatedAt === "string" &&
    isAnalyticsRange(value.range) &&
    (value.subjectId === null || typeof value.subjectId === "string") &&
    (value.topic === null || typeof value.topic === "string") &&
    isAnalyticsOverall(value.overall) &&
    Array.isArray(value.bySubject) &&
    value.bySubject.every(isAnalyticsBySubjectItem) &&
    Array.isArray(value.byTopic) &&
    value.byTopic.every(isAnalyticsByTopicItem) &&
    Array.isArray(value.availableTopics) &&
    value.availableTopics.every(isAnalyticsAvailableTopicItem)
  );
}

export interface GetAnalyticsSummaryParams {
  subjectId?: string;
  topic?: string;
  range?: AnalyticsRange;
}

export async function getAnalyticsSummary(
  params: GetAnalyticsSummaryParams = {},
  signal?: AbortSignal,
): Promise<AnalyticsSummaryResponse> {
  const searchParams = new URLSearchParams();
  if (params.subjectId) searchParams.set("subjectId", params.subjectId);
  if (params.topic) searchParams.set("topic", params.topic);
  if (params.range) searchParams.set("range", params.range);

  let response: Response;
  try {
    response = await fetch(
      `${API_BASE_URL}/analytics/summary?${searchParams.toString()}`,
      { signal, cache: "no-store" },
    );
  } catch {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    throw new AnalyticsApiError(
      `Could not reach the API at ${API_BASE_URL}. Check the server and try again.`,
    );
  }

  if (!response.ok) {
    throw new AnalyticsApiError(
      `Analytics request failed with status ${response.status}.`,
      response.status,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AnalyticsApiError("The API returned an invalid JSON response.");
  }

  if (!isAnalyticsSummaryResponse(body)) {
    throw new AnalyticsApiError("The API returned an invalid analytics response.");
  }
  return body;
}

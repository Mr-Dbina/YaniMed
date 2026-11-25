import { API_BASE_URL } from "@/lib/api";

export type AnalyticsRange = "7" | "30" | "90" | "all";

export interface AnalyticsBySubjectItem {
  subjectId: string;
  subject: string;
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number;
}

export interface AnalyticsByTopicItem {
  subject: string;
  topic: string;
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number;
}

export interface AnalyticsSummaryResponse {
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number;
  completedTestsCount: number;
  bySubject: AnalyticsBySubjectItem[];
  byTopic: AnalyticsByTopicItem[];
  availableTopics: string[];
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

function isAnalyticsBySubjectItem(value: unknown): value is AnalyticsBySubjectItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.subjectId === "string" &&
    typeof value.subject === "string" &&
    typeof value.totalAnswered === "number" &&
    typeof value.correctCount === "number" &&
    typeof value.accuracyPercent === "number"
  );
}

function isAnalyticsByTopicItem(value: unknown): value is AnalyticsByTopicItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.subject === "string" &&
    typeof value.topic === "string" &&
    typeof value.totalAnswered === "number" &&
    typeof value.correctCount === "number" &&
    typeof value.accuracyPercent === "number"
  );
}

function isAnalyticsSummaryResponse(value: unknown): value is AnalyticsSummaryResponse {
  if (!isRecord(value)) return false;
  return (
    typeof value.totalAnswered === "number" &&
    typeof value.correctCount === "number" &&
    typeof value.accuracyPercent === "number" &&
    typeof value.completedTestsCount === "number" &&
    Array.isArray(value.bySubject) &&
    value.bySubject.every(isAnalyticsBySubjectItem) &&
    Array.isArray(value.byTopic) &&
    value.byTopic.every(isAnalyticsByTopicItem) &&
    Array.isArray(value.availableTopics) &&
    value.availableTopics.every((item): item is string => typeof item === "string")
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
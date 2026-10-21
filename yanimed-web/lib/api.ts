import type { ChatAnswerResponse, ChatCitation } from "@/lib/types";

export const MAX_PROMPT_LENGTH = 2000;
const REQUEST_TIMEOUT_MS = 70_000;

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const API_BASE_URL = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000").replace(
  /\/+$/,
  "",
);

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string | string[] };
    if (Array.isArray(body.message)) return body.message.join(" ");
    if (typeof body.message === "string" && body.message) return body.message;
  } catch {
    // Non-JSON error bodies fall through to the generic status message.
  }
  return `Request failed with status ${res.status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCitation(value: unknown): value is ChatCitation {
  return isRecord(value) && typeof value.sourceId === "string" &&
    value.sourceId.trim().length > 0 &&
    (value.chapter === null || typeof value.chapter === "string") &&
    typeof value.page === "number" && Number.isInteger(value.page) && value.page > 0 &&
    (value.snippet === undefined || typeof value.snippet === "string");
}

function isAnswer(value: unknown): value is ChatAnswerResponse {
  if (!isRecord(value) || typeof value.answer !== "string" || !value.answer.trim() ||
      !Array.isArray(value.citations) || !value.citations.every(isCitation) ||
      !["ungrounded", "grounded", "insufficient_evidence"].includes(String(value.grounding)) ||
      !isRecord(value.metadata)) return false;
  const metadata = value.metadata;
  return metadata.gateway === "omniroute" &&
    typeof metadata.requestedModel === "string" && metadata.requestedModel.trim().length > 0 &&
    (metadata.servedModel === null || typeof metadata.servedModel === "string") &&
    (metadata.provider === null || typeof metadata.provider === "string") &&
    typeof metadata.durationMs === "number" && Number.isFinite(metadata.durationMs) &&
    metadata.durationMs >= 0 && (value.grounding !== "ungrounded" || value.citations.length === 0);
}

/**
 * Development-only endpoint. No retrieval grounding and no citations yet, so a
 * returned answer is the model's own text and nothing more.
 */
export async function requestAnswer(
  prompt: string,
  signal?: AbortSignal,
): Promise<ChatAnswerResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE_URL}/chat/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.trim() }),
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(await errorMessage(res));

    const body: unknown = await res.json();
    if (!isAnswer(body)) throw new ApiError("The API returned an invalid chat response. Please try again.");
    return body;
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    if (timedOut) throw new ApiError("The answer timed out after 70 seconds. Please try again.");
    if (err instanceof ApiError) throw err;
    if (err instanceof SyntaxError) throw new ApiError("The API returned an invalid JSON response.");
    throw new ApiError(
      `Could not reach the API at ${API_BASE_URL}. Check the server and allowed frontend origin, then try again.`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

import { API_BASE_URL, ApiError, errorDetails, isRecord } from "@/lib/api";

const REQUEST_TIMEOUT_MS = 15_000;

export type DocumentProcessingStatus = "QUEUED" | "PROCESSING" | "READY" | "FAILED";

export interface BackendSubject {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  documentCount: number;
}

export interface BackendDocument {
  documentId: string;
  subjectId: string;
  filename: string;
  status: DocumentProcessingStatus;
  createdAt: string;
  updatedAt: string;
  pageCount: number | null;
  processedPages: number;
  embeddedChunks: number;
  ocrPages: number;
}

export interface BackendDocumentProcessing {
  attempt: number;
  maxAttempts: number;
  nextRunAt: string;
}

export type BackendDocumentFailureCode =
  | "OCR_PAGE_LIMIT_EXCEEDED"
  | "OCR_PAGE_TIMEOUT"
  | "OCR_TIME_BUDGET_EXCEEDED"
  | "PROCESSING_TIME_BUDGET_EXCEEDED"
  | "LEASE_EXPIRED_MAX_ATTEMPTS"
  | "EMBEDDING_TRANSIENT"
  | "EMBEDDING_PERMANENT"
  | "STORAGE_TRANSIENT"
  | "STORAGE_PERMANENT"
  | "DB_TRANSIENT"
  | "PROCESSING_FAILED";

export interface BackendDocumentFailure {
  code: BackendDocumentFailureCode;
  message: string;
  retryAllowed: boolean;
}

export interface BackendDocumentStatus extends BackendDocument {
  readyForRetrieval: boolean;
  retryAllowed: boolean;
  retryUnavailableReason: null | "RETRY_IN_PROGRESS" | "NOT_FAILED";
  processing?: BackendDocumentProcessing;
  failure: BackendDocumentFailure | null;
}

function isDocumentProcessingStatus(value: unknown): value is DocumentProcessingStatus {
  return value === "QUEUED" || value === "PROCESSING" || value === "READY" || value === "FAILED";
}

function isBackendSubject(value: unknown): value is BackendSubject {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    typeof value.documentCount === "number";
}

function hasBackendDocumentFields(value: Record<string, unknown>): boolean {
  return typeof value.documentId === "string" &&
    typeof value.subjectId === "string" &&
    typeof value.filename === "string" &&
    isDocumentProcessingStatus(value.status) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string" &&
    (value.pageCount === null || typeof value.pageCount === "number") &&
    typeof value.processedPages === "number" &&
    typeof value.embeddedChunks === "number" &&
    typeof value.ocrPages === "number";
}

function isBackendDocument(value: unknown): value is BackendDocument {
  return isRecord(value) && hasBackendDocumentFields(value);
}

function isBackendDocumentProcessing(value: unknown): value is BackendDocumentProcessing {
  return isRecord(value) &&
    typeof value.attempt === "number" &&
    typeof value.maxAttempts === "number" &&
    typeof value.nextRunAt === "string";
}

function isBackendDocumentFailure(value: unknown): value is BackendDocumentFailure {
  return isRecord(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    typeof value.retryAllowed === "boolean";
}

function isBackendDocumentStatus(value: unknown): value is BackendDocumentStatus {
  if (!isRecord(value) || !hasBackendDocumentFields(value)) return false;
  return typeof value.readyForRetrieval === "boolean" &&
    typeof value.retryAllowed === "boolean" &&
    (value.retryUnavailableReason === null ||
      value.retryUnavailableReason === "RETRY_IN_PROGRESS" ||
      value.retryUnavailableReason === "NOT_FAILED") &&
    (value.processing === undefined || isBackendDocumentProcessing(value.processing)) &&
    (value.failure === null || isBackendDocumentFailure(value.failure));
}

async function requestJson<T>(
  path: string,
  isShape: (value: unknown) => value is T,
  invalidMessage: string,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE_URL}${path}`, { signal: controller.signal });
    if (!res.ok) {
      const { message, code } = await errorDetails(res);
      throw new ApiError(message, res.status, code);
    }

    const body: unknown = await res.json();
    if (!isShape(body)) throw new ApiError(invalidMessage);
    return body;
  } catch (err) {
    if (timedOut) throw new ApiError("The request timed out after 15 seconds. Please try again.");
    if (err instanceof ApiError) throw err;
    if (err instanceof SyntaxError) throw new ApiError("The API returned an invalid JSON response.");
    throw new ApiError(
      `Could not reach the API at ${API_BASE_URL}. Check the server and allowed frontend origin, then try again.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function listSubjects(): Promise<BackendSubject[]> {
  return requestJson(
    "/subjects",
    (value): value is BackendSubject[] => Array.isArray(value) && value.every(isBackendSubject),
    "The API returned an invalid subjects response. Please try again.",
  );
}

export async function getSubjectDocuments(subjectId: string): Promise<BackendDocument[]> {
  return requestJson(
    `/subjects/${encodeURIComponent(subjectId)}/documents`,
    (value): value is BackendDocument[] => Array.isArray(value) && value.every(isBackendDocument),
    "The API returned an invalid documents response. Please try again.",
  );
}

export async function getDocumentStatus(documentId: string): Promise<BackendDocumentStatus> {
  return requestJson(
    `/documents/${encodeURIComponent(documentId)}/status`,
    isBackendDocumentStatus,
    "The API returned an invalid document status response. Please try again.",
  );
}

import { API_BASE_URL, ApiError, isRecord } from "@/lib/api";

const REQUEST_TIMEOUT_MS = 15_000;
const UPLOAD_TIMEOUT_MS = 60_000;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const SUBJECT_NAME_CONFLICT_MESSAGE = "A subject with this name already exists.";

export type UploadAttemptStatus =
  | "PENDING"
  | "UPLOADING"
  | "AWAITING_RETRY"
  | "CLEANUP_PENDING"
  | "UPLOADED";

export type DuplicateAction = "keep_existing" | "replace_existing";

export interface InitialUploadResult {
  subjectId: string;
  documentId: string | null;
  uploadStatus: UploadAttemptStatus;
  subjectStatus: string;
  chatAvailable: boolean;
  retryable: boolean;
  errorCode: string | null;
}

export interface InitialUploadDuplicateBody {
  code: "DUPLICATE_PDF";
  scope: string;
  existingDocumentId: string;
  existingSubjectId: string;
  existingFilename: string;
  allowedActions: string[];
  message?: string;
}

export class InitialUploadDuplicateError extends ApiError {
  readonly scope: string;
  readonly existingDocumentId: string;
  readonly existingSubjectId: string;
  readonly existingFilename: string;
  readonly allowedActions: string[];

  constructor(body: InitialUploadDuplicateBody) {
    super(body.message || "Duplicate PDF", 409, "DUPLICATE_PDF");
    this.name = "InitialUploadDuplicateError";
    this.scope = body.scope;
    this.existingDocumentId = body.existingDocumentId;
    this.existingSubjectId = body.existingSubjectId;
    this.existingFilename = body.existingFilename;
    this.allowedActions = body.allowedActions;
  }
}

export class SubjectNameConflictError extends ApiError {
  constructor() {
    super(SUBJECT_NAME_CONFLICT_MESSAGE, 409);
    this.name = "SubjectNameConflictError";
  }
}

export type DocumentProcessingStatus = "QUEUED" | "PROCESSING" | "READY" | "FAILED";

export type UploadedDocument = {
  documentId: string;
  filename: string;
  subjectId: string;
  status: DocumentProcessingStatus;
  storageKey: string;
};

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

export interface RetryDocumentResult {
  documentId: string;
  status: DocumentProcessingStatus;
}

function isDocumentProcessingStatus(value: unknown): value is DocumentProcessingStatus {
  return value === "QUEUED" || value === "PROCESSING" || value === "READY" || value === "FAILED";
}

function isUploadedDocument(value: unknown): value is UploadedDocument {
  return isRecord(value) &&
    typeof value.documentId === "string" &&
    typeof value.filename === "string" &&
    typeof value.subjectId === "string" &&
    isDocumentProcessingStatus(value.status) &&
    typeof value.storageKey === "string";
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

function isRetryDocumentResult(value: unknown): value is RetryDocumentResult {
  return isRecord(value) &&
    typeof value.documentId === "string" &&
    isDocumentProcessingStatus(value.status);
}

function isUploadAttemptStatus(value: unknown): value is UploadAttemptStatus {
  return value === "PENDING" ||
    value === "UPLOADING" ||
    value === "AWAITING_RETRY" ||
    value === "CLEANUP_PENDING" ||
    value === "UPLOADED";
}

function isDuplicateAction(value: unknown): value is DuplicateAction {
  return value === "keep_existing" || value === "replace_existing";
}

function isInitialUploadDuplicateBody(value: unknown): value is InitialUploadDuplicateBody {
  return isRecord(value) &&
    value.code === "DUPLICATE_PDF" &&
    typeof value.scope === "string" &&
    typeof value.existingDocumentId === "string" &&
    typeof value.existingSubjectId === "string" &&
    typeof value.existingFilename === "string" &&
    Array.isArray(value.allowedActions) &&
    value.allowedActions.every((action) => typeof action === "string") &&
    (value.message === undefined || typeof value.message === "string");
}

function isInitialUploadResult(value: unknown): value is InitialUploadResult {
  return isRecord(value) &&
    typeof value.subjectId === "string" &&
    (value.documentId === null || typeof value.documentId === "string") &&
    isUploadAttemptStatus(value.uploadStatus) &&
    typeof value.subjectStatus === "string" &&
    typeof value.chatAvailable === "boolean" &&
    typeof value.retryable === "boolean" &&
    (value.errorCode === null || typeof value.errorCode === "string");
}

function isIdempotencyKey(value: string): boolean {
  return value.length >= 8 && value.length <= 128 && IDEMPOTENCY_KEY_PATTERN.test(value);
}

function errorDetailsFromBody(status: number, body: unknown): { message: string; code?: string } {
  let message: string | undefined;
  if (isRecord(body)) {
    if (Array.isArray(body.message)) message = body.message.join(" ");
    else if (typeof body.message === "string" && body.message) message = body.message;
  }
  const code = isRecord(body) && typeof body.code === "string"
    ? body.code
    : isRecord(body) && isRecord(body.message) && typeof body.message.code === "string"
      ? body.message.code
      : undefined;
  const reason = isRecord(body) && typeof body.reason === "string" && body.reason
    ? body.reason
    : undefined;
  let finalMessage = message ?? `Request failed with status ${status}`;
  if (code === "RETRY_NOT_ALLOWED") {
    finalMessage = reason ? `Retry not allowed: ${reason}.` : "Retry not allowed. Please try again.";
  }
  return {
    message: finalMessage,
    ...(code !== undefined ? { code } : {}),
  };
}

async function requestJson<T>(
  path: string,
  isShape: (value: unknown) => value is T,
  invalidMessage: string,
  init?: RequestInit,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE_URL}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ApiError(`Request failed with status ${res.status}`, res.status);
      }
      const { message, code } = errorDetailsFromBody(res.status, body);
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

export async function retryDocument(documentId: string): Promise<RetryDocumentResult> {
  return requestJson(
    `/documents/${encodeURIComponent(documentId)}/retry`,
    isRetryDocumentResult,
    "The API returned an invalid retry response. Please try again.",
    { method: "POST" },
  );
}

export async function createInitialSubject(input: {
  name: string;
  idempotencyKey: string;
  file: File;
  duplicateAction?: DuplicateAction;
}): Promise<InitialUploadResult> {
  const name = input.name.trim();
  if (!name) throw new ApiError("Subject name is required.");
  if (!isIdempotencyKey(input.idempotencyKey)) {
    throw new ApiError(
      "Idempotency key must be 8-128 characters and use only letters, numbers, '.', '_', ':', or '-'.",
    );
  }
  if (!input.file.name.trim()) throw new ApiError("The selected file must have a filename.");

  const form = new FormData();
  form.append("name", name);
  form.append("idempotencyKey", input.idempotencyKey);
  if (input.duplicateAction !== undefined) form.append("duplicateAction", input.duplicateAction);
  form.append("file", input.file, input.file.name);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE_URL}/subjects/initial-upload`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ApiError(`Request failed with status ${res.status}`, res.status);
      }

      if (res.status === 409 && isInitialUploadDuplicateBody(body)) {
        throw new InitialUploadDuplicateError(body);
      }
      const { message, code } = errorDetailsFromBody(res.status, body);
      if (res.status === 409 && message === SUBJECT_NAME_CONFLICT_MESSAGE) {
        throw new SubjectNameConflictError();
      }
      throw new ApiError(message, res.status, code);
    }

    const body: unknown = await res.json();
    if (!isInitialUploadResult(body)) {
      throw new ApiError("The API returned an invalid initial upload response. Please try again.");
    }
    return body;
  } catch (err) {
    if (timedOut) throw new ApiError("The upload timed out after 60 seconds. Please try again.");
    if (err instanceof ApiError) throw err;
    if (err instanceof SyntaxError) throw new ApiError("The API returned an invalid JSON response.");
    throw new ApiError(
      `Could not reach the API at ${API_BASE_URL}. Check the server and allowed frontend origin, then try again.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function getInitialUploadStatus(idempotencyKey: string): Promise<InitialUploadResult> {
  return requestJson(
    `/subjects/initial-upload/${encodeURIComponent(idempotencyKey)}`,
    isInitialUploadResult,
    "The API returned an invalid upload status response. Please try again.",
  );
}

// PENDING, UPLOADING, AWAITING_RETRY, and CLEANUP_PENDING are non-terminal:
// recovery may still move them to UPLOADED.
export function isInitialUploadTerminal(result: InitialUploadResult): boolean {
  return result.uploadStatus === "UPLOADED";
}

export async function uploadPdfToSubject(input: {
  subjectId: string;
  file: File;
  duplicateAction?: DuplicateAction;
}): Promise<{ document: UploadedDocument; created: boolean }> {
  const subjectId = input.subjectId.trim();
  if (!subjectId) throw new ApiError("Subject ID is required.");
  if (!input.file.name.trim()) throw new ApiError("The selected file must have a filename.");
  if (input.duplicateAction !== undefined && !isDuplicateAction(input.duplicateAction)) {
    throw new ApiError("Duplicate action must be 'keep_existing' or 'replace_existing'.");
  }

  const form = new FormData();
  form.append("subjectId", subjectId);
  if (input.duplicateAction !== undefined) form.append("duplicateAction", input.duplicateAction);
  form.append("file", input.file, input.file.name);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, UPLOAD_TIMEOUT_MS);

  try {
    const res = await fetch(`${API_BASE_URL}/documents/upload`, {
      method: "POST",
      body: form,
      signal: controller.signal,
    });

    if (!res.ok) {
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        throw new ApiError(`Request failed with status ${res.status}`, res.status);
      }

      if (res.status === 409 && isInitialUploadDuplicateBody(body)) {
        throw new InitialUploadDuplicateError(body);
      }
      const { message, code } = errorDetailsFromBody(res.status, body);
      throw new ApiError(message, res.status, code);
    }

    if (res.status !== 200 && res.status !== 201) {
      throw new ApiError("The API returned an invalid upload response. Please try again.");
    }

    const body: unknown = await res.json();
    if (!isUploadedDocument(body)) {
      throw new ApiError("The API returned an invalid upload response. Please try again.");
    }
    return { document: body, created: res.status === 201 };
  } catch (err) {
    if (timedOut) {
      throw new ApiError(
        "The upload timed out after 60 seconds. It may have reached the server, so check this subject's documents before retrying.",
      );
    }
    if (err instanceof ApiError) throw err;
    if (err instanceof SyntaxError) throw new ApiError("The API returned an invalid JSON response.");
    throw new ApiError(
      `Could not reach the API at ${API_BASE_URL}. Check the server and allowed frontend origin, then try again.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

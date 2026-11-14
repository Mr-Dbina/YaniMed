import { API_BASE_URL } from "@/lib/api";

const TIMEOUT_MS = 30_000;

export type MockAttemptStatus =
  | "GENERATING"
  | "READY"
  | "IN_PROGRESS"
  | "AWAITING_SUBMISSION"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "ABANDONED";

export type MockQuestionStatus = "UNSEEN" | "SKIPPED" | "ANSWERED";

export type ChoiceLetter = "A" | "B" | "C" | "D";

export interface MockChoice {
  id: string;
  letter: ChoiceLetter;
  text: string;
}

export interface MockQuestion {
  attemptId: string;
  position: number;
  total: number;
  status: MockQuestionStatus;
  stem: string;
  leadIn: string | null;
  choices: MockChoice[];
}

export type GenerationJobState =
  | "QUEUED"
  | "RUNNING"
  | "STALLED"
  | "CANCELLING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type GenerationPhase =
  | "PLANNING"
  | "DRAFTING"
  | "VALIDATING"
  | "FINALIZING";

export type GenerationFailureReason =
  | "INSUFFICIENT_CONTENT"
  | "PROVIDER_UNAVAILABLE"
  | "BUDGET_EXHAUSTED"
  | "VALIDATION_EXHAUSTED"
  | "SOURCE_CHANGED"
  | "TIMEOUT"
  | "INTERNAL";

export interface GenerationJobSummary {
  jobId: string;
  state: GenerationJobState;
  requestedCount: number;
  acceptedCount: number;
}

export interface GenerationJobDocument {
  id: string;
  title: string;
}

export interface GenerationJob extends GenerationJobSummary {
  subjectId: string;
  aiCallCount: number;
  recoveryCount: number;
  failureReason: GenerationFailureReason | null;
  phase: GenerationPhase | null;
  startedAt: string;
  heartbeatAt: string | null;
  finishedAt: string | null;
  documents: GenerationJobDocument[];
}

export interface SubjectOverview {
  unfinishedAttempt: {
    id: string;
    status: MockAttemptStatus;
    createdAt: string;
  } | null;
  eligibleQuestionCount: number;
  questionsPerTest: number;
  generationJob: GenerationJobSummary | null;
}

export interface CreateAttemptResponse {
  attemptId: string;
  status: "READY";
}

export interface StartAttemptResponse {
  attemptId: string;
  sessionVersion: number;
  question: MockQuestion;
}

export interface QuestionProgress {
  nextQuestion: MockQuestion | null;
  status: MockAttemptStatus;
  answeredCount: number;
}

export interface NavigatorItem {
  position: number;
  answered: boolean;
  selectedChoiceId: string | null;
  stem: string;
  leadIn: string | null;
  choices: MockChoice[];
}

export interface ReviewNavigator {
  attemptId: string;
  status: "AWAITING_SUBMISSION";
  items: NavigatorItem[];
}

export interface TopicScore {
  topicKey: string;
  correct: number;
  total: number;
}

export interface ExamResult {
  attemptId: string;
  score: number;
  total: number;
  percentage: number;
  correctCount: number;
  incorrectCount: number;
  unansweredCount: number;
  perTopic: TopicScore[];
}

export interface ReviewCitation {
  documentTitleSnapshot: string;
  pageNumber: number;
  quote: string;
}

export interface ReviewChoice extends MockChoice {
  isCorrect: boolean;
  explanation: string;
}

export interface ReviewQuestion {
  position: number;
  status: MockQuestionStatus;
  stem: string;
  leadIn: string | null;
  choices: ReviewChoice[];
  selectedChoiceId: string | null;
  correctChoiceId: string;
  isCorrect: boolean;
  underReview: boolean;
  topicName: string;
  citations: ReviewCitation[];
}

export interface ExamReview {
  attemptId: string;
  score: number;
  total: number;
  percentage: number;
  perTopic: TopicScore[];
  questions: ReviewQuestion[];
}

export interface DiscardAttemptResponse {
  attemptId: string;
  status: "ABANDONED";
}

export interface MockTestErrorBody {
  code?: string;
  message?: string;
  attemptId?: string;
  eligible?: number;
  required?: number;
  [key: string]: unknown;
}

export class MockTestApiError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly body: MockTestErrorBody | null;

  constructor(
    message: string,
    status?: number,
    code?: string,
    body: MockTestErrorBody | null = null,
  ) {
    super(message);
    this.name = "MockTestApiError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TIMEOUT_MS);

  try {
    const headers: HeadersInit = init?.body
      ? { "Content-Type": "application/json", ...init.headers }
      : init?.headers ?? {};
    const response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
      cache: "no-store",
    });

    const text = await response.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }
    }

    if (!response.ok) {
      const record = isRecord(parsed) ? parsed : null;
      const message =
        record && typeof record.message === "string" && record.message
          ? record.message
          : `Request failed with status ${response.status}`;
      const code =
        record && typeof record.code === "string" ? record.code : undefined;
      throw new MockTestApiError(
        message,
        response.status,
        code,
        record as MockTestErrorBody | null,
      );
    }

    return parsed as T;
  } catch (error) {
    if (error instanceof MockTestApiError) throw error;
    if (timedOut) {
      throw new MockTestApiError(
        "The request timed out after 30 seconds. Please try again.",
      );
    }
    throw new MockTestApiError(
      `Could not reach the Mock Test API at ${API_BASE_URL}. Check the server and try again.`,
    );
  } finally {
    clearTimeout(timer);
  }
}

function subjectPath(subjectId: string): string {
  return `/mock-test/subjects/${encodeURIComponent(subjectId)}`;
}

function attemptPath(attemptId: string): string {
  return `/mock-test/attempts/${encodeURIComponent(attemptId)}`;
}

export async function getSubjectOverview(
  subjectId: string,
): Promise<SubjectOverview> {
  return request<SubjectOverview>(`${subjectPath(subjectId)}/overview`);
}

export async function createAttempt(
  subjectId: string,
): Promise<CreateAttemptResponse> {
  return request<CreateAttemptResponse>(`${subjectPath(subjectId)}/attempts`, {
    method: "POST",
  });
}

export async function startAttempt(
  attemptId: string,
): Promise<StartAttemptResponse> {
  return request<StartAttemptResponse>(`${attemptPath(attemptId)}/start`, {
    method: "POST",
  });
}

export async function getCurrentQuestion(
  attemptId: string,
  sessionVersion: number,
): Promise<MockQuestion | null> {
  return request<MockQuestion | null>(
    `${attemptPath(attemptId)}/current?sessionVersion=${sessionVersion}`,
  );
}

export async function answerQuestion(
  attemptId: string,
  input: {
    sessionVersion: number;
    position: number;
    choiceId: string;
    idempotencyKey: string;
  },
): Promise<QuestionProgress> {
  return request<QuestionProgress>(`${attemptPath(attemptId)}/answer`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function skipQuestion(
  attemptId: string,
  input: { sessionVersion: number; position: number },
): Promise<QuestionProgress> {
  return request<QuestionProgress>(`${attemptPath(attemptId)}/skip`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getReviewNavigator(
  attemptId: string,
  sessionVersion: number,
): Promise<ReviewNavigator> {
  return request<ReviewNavigator>(
    `${attemptPath(attemptId)}/review-navigator?sessionVersion=${sessionVersion}`,
  );
}

export async function submitAttempt(
  attemptId: string,
  input: { sessionVersion: number; idempotencyKey: string },
): Promise<ExamResult> {
  return request<ExamResult>(`${attemptPath(attemptId)}/submit`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function getResult(attemptId: string): Promise<ExamResult> {
  return request<ExamResult>(`${attemptPath(attemptId)}/result`);
}

export async function getReview(attemptId: string): Promise<ExamReview> {
  return request<ExamReview>(`${attemptPath(attemptId)}/review`);
}

export async function discardAttempt(
  attemptId: string,
): Promise<DiscardAttemptResponse> {
  return request<DiscardAttemptResponse>(`${attemptPath(attemptId)}/discard`, {
    method: "POST",
  });
}

function generationJobPath(jobId: string): string {
  return `/mock-test/generation-jobs/${encodeURIComponent(jobId)}`;
}

export async function createGenerationJob(
  subjectId: string,
  input?: { idempotencyKey?: string },
): Promise<GenerationJobSummary> {
  return request<GenerationJobSummary>(
    `${subjectPath(subjectId)}/generation-jobs`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function getActiveGenerationJob(
  subjectId: string,
): Promise<{ job: GenerationJobSummary | null }> {
  return request<{ job: GenerationJobSummary | null }>(
    `${subjectPath(subjectId)}/generation-jobs/active`,
  );
}

export async function getGenerationJob(jobId: string): Promise<GenerationJob> {
  return request<GenerationJob>(generationJobPath(jobId));
}

export async function cancelGenerationJob(
  jobId: string,
): Promise<{ jobId: string; state: "CANCELLING" }> {
  return request<{ jobId: string; state: "CANCELLING" }>(
    `${generationJobPath(jobId)}/cancel`,
    { method: "POST" },
  );
}

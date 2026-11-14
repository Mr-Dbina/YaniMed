import type {
  GenerationFailureReason,
  GenerationJobState,
  GenerationPhase,
} from "@/lib/mock-test-api";

/** Delay between progress reads. Long enough to stay gentle on the API. */
export const GENERATION_POLL_MS = 2_000;

/** A heartbeat older than this means the worker may be restarting. */
export const STALE_HEARTBEAT_MS = 2 * 60 * 1000;

const ACTIVE_STATES: readonly GenerationJobState[] = [
  "QUEUED",
  "RUNNING",
  "STALLED",
  "CANCELLING",
];

export function isActiveGenerationState(state: GenerationJobState): boolean {
  return ACTIVE_STATES.includes(state);
}

export function isTerminalGenerationState(state: GenerationJobState): boolean {
  return state === "COMPLETED" || state === "FAILED" || state === "CANCELLED";
}

export type GenerationStepKey = "PLANNING" | "DRAFTING" | "FINALIZING";

export interface GenerationStep {
  key: GenerationStepKey;
  label: string;
  hint: string;
}

export const GENERATION_STEPS: readonly GenerationStep[] = [
  {
    key: "PLANNING",
    label: "Planning",
    hint: "Reading your documents",
  },
  {
    key: "DRAFTING",
    label: "Drafting questions",
    hint: "Writing PLE-style questions",
  },
  {
    key: "FINALIZING",
    label: "Finalizing",
    hint: "Checking question quality",
  },
];

/** VALIDATING is part of drafting, so it maps to the same visible step. */
export function stepForPhase(
  phase: GenerationPhase | null | undefined,
): GenerationStepKey {
  if (phase === "DRAFTING" || phase === "VALIDATING") return "DRAFTING";
  if (phase === "FINALIZING") return "FINALIZING";
  return "PLANNING";
}

export type GenerationStepStatus = "done" | "current" | "pending";

export function stepStatus(
  step: GenerationStepKey,
  current: GenerationStepKey | null,
  completed: boolean,
): GenerationStepStatus {
  if (completed) return "done";
  if (!current) return "pending";
  const stepIndex = GENERATION_STEPS.findIndex((entry) => entry.key === step);
  const currentIndex = GENERATION_STEPS.findIndex(
    (entry) => entry.key === current,
  );
  if (stepIndex < currentIndex) return "done";
  if (stepIndex === currentIndex) return "current";
  return "pending";
}

/** Whole percent, clamped so the ring never shows a value it cannot draw. */
export function generationPercent(
  acceptedCount: number,
  requestedCount: number,
): number {
  if (requestedCount <= 0) return 0;
  const percent = Math.round((acceptedCount / requestedCount) * 100);
  return Math.max(0, Math.min(100, percent));
}

const FAILURE_MESSAGES: Record<GenerationFailureReason, string> = {
  INSUFFICIENT_CONTENT:
    "There is not enough usable content in your PDFs yet. Add more material, then try again.",
  PROVIDER_UNAVAILABLE:
    "The AI service is not reachable right now. Try again in a few minutes.",
  BUDGET_EXHAUSTED:
    "Question generation has reached its limit for now. Try again later.",
  VALIDATION_EXHAUSTED:
    "The generated questions did not pass the quality checks. Try again.",
  SOURCE_CHANGED:
    "Your subject documents changed while questions were being generated. Try again with the current documents.",
  TIMEOUT: "Generation took too long and stopped. Try again.",
  INTERNAL: "Something went wrong while generating questions. Try again.",
};

export function generationFailureMessage(
  reason: GenerationFailureReason | null,
): string {
  return reason
    ? FAILURE_MESSAGES[reason]
    : "Question generation stopped before it finished. Try again.";
}

const STATE_LABELS: Record<GenerationJobState, string> = {
  QUEUED: "Preparing",
  RUNNING: "Generating",
  STALLED: "Paused",
  CANCELLING: "Cancelling",
  COMPLETED: "Ready",
  FAILED: "Stopped",
  CANCELLED: "Cancelled",
};

export function generationStateLabel(state: GenerationJobState): string {
  return STATE_LABELS[state];
}

/**
 * A stalled job, or a running one whose heartbeat went quiet, is paused on the
 * server side. It resumes on its own, so this is a status, not an error.
 */
export function isGenerationPaused(
  state: GenerationJobState,
  heartbeatAt: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (state === "STALLED") return true;
  if (state !== "RUNNING" || !heartbeatAt) return false;
  const heartbeatMs = Date.parse(heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return false;
  return nowMs - heartbeatMs > STALE_HEARTBEAT_MS;
}

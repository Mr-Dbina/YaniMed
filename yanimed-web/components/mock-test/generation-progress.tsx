"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, FileText, X } from "lucide-react";
import {
  MockTestApiError,
  cancelGenerationJob,
  type GenerationJob,
  type GenerationJobSummary,
} from "@/lib/mock-test-api";
import {
  GENERATION_STEPS,
  generationFailureMessage,
  generationPercent,
  generationStateLabel,
  isActiveGenerationState,
  isGenerationPaused,
  stepForPhase,
  stepStatus,
} from "@/lib/mock-test-generation";
import { ConfirmDialog } from "@/components/mock-test/confirm-dialog";
import { StudyAidNotice } from "@/components/mock-test/study-aid-notice";
import { useGenerationJob } from "@/components/mock-test/use-generation-job";

interface GenerationProgressProps {
  subjectName: string;
  initialJob: GenerationJobSummary;
  /** True while the parent turns a completed job into an attempt. */
  completing: boolean;
  retryBusy: boolean;
  retryError: string | null;
  onCompleted: (job: GenerationJob) => void;
  onCancelled: () => void;
  onBack: () => void;
  onRetry: () => void;
}

const STEP_STATUS_LABEL = {
  done: "Done",
  current: "In progress",
  pending: "Waiting",
} as const;

export function GenerationProgress({
  subjectName,
  initialJob,
  completing,
  retryBusy,
  retryError,
  onCompleted,
  onCancelled,
  onBack,
  onRetry,
}: GenerationProgressProps) {
  const { job, error, reconnecting, refresh } = useGenerationJob(
    initialJob.jobId,
  );
  const headingId = useId();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const state = job?.state ?? initialJob.state;
  const requestedCount = job?.requestedCount ?? initialJob.requestedCount;
  const acceptedCount = job?.acceptedCount ?? initialJob.acceptedCount;
  const percent = generationPercent(acceptedCount, requestedCount);
  const currentStep = stepForPhase(job?.phase);
  const completed = state === "COMPLETED";
  const paused = isGenerationPaused(state, job?.heartbeatAt ?? null);
  const canCancel = isActiveGenerationState(state);
  const cancelPending = cancelling || state === "CANCELLING";

  const completedRef = useRef(false);
  useEffect(() => {
    if (!job || job.state !== "COMPLETED" || completedRef.current) return;
    completedRef.current = true;
    onCompleted(job);
  }, [job, onCompleted]);

  const cancelledRef = useRef(false);
  useEffect(() => {
    if (!job || job.state !== "CANCELLED" || cancelledRef.current) return;
    cancelledRef.current = true;
    onCancelled();
  }, [job, onCancelled]);

  const handleCancel = async () => {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelGenerationJob(initialJob.jobId);
      setCancelOpen(false);
      refresh();
    } catch (caught) {
      setCancelOpen(false);
      const api =
        caught instanceof MockTestApiError
          ? caught
          : null;
      if (api?.code === "GENERATION_NOT_CANCELLABLE") {
        // The job moved on. Read the real state instead of guessing.
        refresh();
      } else {
        setCancelError(
          api?.status === 404
            ? "This generation job no longer exists."
            : "Generation could not be cancelled. Please try again.",
        );
      }
    } finally {
      setCancelling(false);
    }
  };

  const title = completed
    ? "Questions are ready"
    : state === "FAILED"
      ? "Question generation stopped"
      : "Generating your questions";

  return (
    <section className="mock-test" aria-labelledby={headingId}>
      <header className="mock-test__top">
        <div className="mock-test__dashboard-intro">
          <div className="mock-test__dashboard-intro-text">
            <h1 id={headingId} className="mock-test__title">
              {title}
            </h1>
            <p className="mock-test__muted">
              {subjectName || "Mock Test"} - you can leave this page. Generation
              keeps running on the server.
            </p>
          </div>
        </div>
        <span className="mock-test__badge" aria-live="polite">
          {generationStateLabel(state)}
        </span>
      </header>

      <div className="mock-test__card">
        <div className="flex flex-wrap items-center gap-6">
          <div
            className="relative grid h-40 w-40 shrink-0 place-items-center rounded-full"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-valuetext={`${acceptedCount} of ${requestedCount} questions ready`}
            aria-label="Question generation progress"
            style={{
              background: `conic-gradient(hsl(var(--primary)) ${percent}%, hsl(var(--primary-tint)) ${percent}% 100%)`,
            }}
          >
            <div className="grid h-[7.5rem] w-[7.5rem] place-items-center rounded-full bg-[hsl(var(--card))]">
              <span className="text-3xl font-bold text-[hsl(var(--primary))]">
                {percent}%
              </span>
            </div>
          </div>

          <div className="flex min-w-[13rem] flex-1 flex-col gap-4">
            <p className="text-lg font-semibold" aria-live="polite">
              {acceptedCount} of {requestedCount} questions ready
            </p>

            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {GENERATION_STEPS.map((step, index) => {
                const status = stepStatus(step.key, currentStep, completed);
                return (
                  <li
                    key={step.key}
                    className="flex items-start gap-3"
                    aria-current={status === "current" ? "step" : undefined}
                  >
                    <span
                      className={`mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-sm font-semibold ${
                        status === "done"
                          ? "border-[hsl(var(--success))] bg-[hsl(var(--success))] text-[hsl(var(--primary-foreground))]"
                          : status === "current"
                            ? "border-[hsl(var(--primary))] bg-[hsl(var(--primary-tint))] text-[hsl(var(--primary))]"
                            : "border-[hsl(var(--border))] text-[hsl(var(--muted-foreground))]"
                      }`}
                      aria-hidden="true"
                    >
                      {status === "done" ? <Check size={16} /> : index + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[15px] font-semibold">
                        {step.label}
                      </span>
                      <span className="block text-sm text-[hsl(var(--muted-foreground))]">
                        {step.hint}
                      </span>
                    </span>
                    <span className="text-xs font-semibold text-[hsl(var(--muted-foreground))]">
                      {STEP_STATUS_LABEL[status]}
                    </span>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>

        {paused && !completed && state !== "FAILED" && (
          <p
            className="m-0 rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--muted)/0.5)] p-4 text-sm text-[hsl(var(--muted-foreground))]"
            role="status"
          >
            Paused - server may be restarting. It will resume automatically.
          </p>
        )}

        {completing && (
          <p className="mock-test__muted" role="status">
            Starting your Mock Test…
          </p>
        )}

        {reconnecting && !error && (
          <p className="mock-test__muted" role="status">
            Reconnecting… last known progress is shown.
          </p>
        )}

        {cancelError && (
          <p className="mock-test__error" role="alert">
            {cancelError}
          </p>
        )}

        {state === "FAILED" && (
          <div
            className="flex flex-col gap-4 rounded-xl border border-[hsl(var(--destructive)/0.35)] bg-[hsl(var(--danger-soft))] p-4"
            role="alert"
          >
            <p className="m-0 text-[15px]">
              {generationFailureMessage(job?.failureReason ?? null)}
            </p>
            {retryError && (
              <p className="mock-test__error" role="alert">
                {retryError}
              </p>
            )}
            <div className="mock-test__actions">
              <button
                type="button"
                className="mock-test__btn mock-test__btn--ghost"
                disabled={retryBusy}
                onClick={onBack}
              >
                Back
              </button>
              <button
                type="button"
                className="mock-test__btn mock-test__btn--primary"
                disabled={retryBusy}
                onClick={onRetry}
              >
                {retryBusy ? "Starting…" : "Try again"}
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="flex flex-col gap-4" role="alert">
            <p className="mock-test__error">
              {error.status === 404 && !error.code
                ? "Mock Test is not enabled on the server."
                : "This generation job no longer exists."}
            </p>
            <button
              type="button"
              className="mock-test__btn mock-test__btn--ghost self-start"
              onClick={onBack}
            >
              Back
            </button>
          </div>
        )}

        {canCancel && (
          <div className="mock-test__actions">
            <button
              type="button"
              className="mock-test__btn mock-test__btn--danger"
              disabled={cancelPending}
              onClick={() => setCancelOpen(true)}
            >
              <X size={18} aria-hidden="true" />
              {cancelPending ? "Cancelling…" : "Cancel Generation"}
            </button>
          </div>
        )}
      </div>

      <div className="mock-test__card">
        <h2 className="mock-test__heading">Documents being used</h2>
        {job && job.documents.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-3 p-0">
            {job.documents.map((document) => (
              <li
                key={document.id}
                className="flex items-center gap-2 text-[15px]"
              >
                <FileText
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-[hsl(var(--muted-foreground))]"
                />
                <span>{document.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mock-test__muted">
            {job
              ? "No documents are listed for this generation job."
              : "Loading the documents used for this test…"}
          </p>
        )}
      </div>

      <StudyAidNotice />

      <ConfirmDialog
        open={cancelOpen}
        title="Cancel generation"
        message="Stop generating questions for this subject? Questions that are already ready are kept."
        confirmLabel="Cancel generation"
        cancelLabel="Keep generating"
        danger
        busy={cancelling}
        onConfirm={() => void handleCancel()}
        onCancel={() => setCancelOpen(false)}
      />
    </section>
  );
}

interface GenerationNoticeProps {
  message: string;
  onBack: () => void;
}

/** Plain-language dead end with a way back, used when generation cannot start. */
export function GenerationNotice({ message, onBack }: GenerationNoticeProps) {
  const headingId = useId();
  return (
    <section className="mock-test" aria-labelledby={headingId}>
      <div className="mock-test__card">
        <h1 id={headingId} className="mock-test__title">
          Questions are not ready yet
        </h1>
        <p className="mock-test__muted">{message}</p>
        <div className="mock-test__actions">
          <button
            type="button"
            className="mock-test__btn mock-test__btn--ghost"
            onClick={onBack}
          >
            Back
          </button>
        </div>
      </div>
      <StudyAidNotice />
    </section>
  );
}

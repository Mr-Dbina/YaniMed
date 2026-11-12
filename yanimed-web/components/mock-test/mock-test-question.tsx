"use client";

import { useState } from "react";
import { ArrowLeft, ArrowRight, SkipForward } from "lucide-react";
import type { MockQuestion } from "@/lib/mock-test-api";

interface MockTestQuestionProps {
  question: MockQuestion;
  subjectName: string;
  /** Saved answers reported by the server, or null before the first response. */
  answeredCount: number | null;
  busy: boolean;
  savingLabel: string | null;
  retryAvailable: boolean;
  returnedToSkipped: boolean;
  error: string | null;
  readOnly: boolean;
  onAnswer: (choiceId: string) => void;
  onRetryAnswer: () => void;
  onSkip: () => void;
  onExit: () => void;
}

export function MockTestQuestion({
  question,
  subjectName,
  answeredCount,
  busy,
  savingLabel,
  retryAvailable,
  returnedToSkipped,
  error,
  readOnly,
  onAnswer,
  onRetryAnswer,
  onSkip,
  onExit,
}: MockTestQuestionProps) {
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const disabled = busy || readOnly;
  const progressPercent =
    answeredCount === null
      ? 0
      : Math.min(100, Math.round((answeredCount / question.total) * 100));

  return (
    <section className="mock-test" aria-labelledby="mock-test-question-heading">
      <header className="mock-test__exam-header">
        <button
          type="button"
          className="mock-test__back"
          onClick={onExit}
          aria-label="Exit test and return to the test overview"
        >
          <ArrowLeft size={18} aria-hidden="true" />
          <span>{subjectName || "Mock Test"}</span>
        </button>
        <p className="mock-test__step" id="mock-test-question-heading">
          Question {question.position} of {question.total}
        </p>
      </header>

      {answeredCount !== null && (
        <div
          className="mock-test__progress"
          role="progressbar"
          aria-label="Questions answered"
          aria-valuemin={0}
          aria-valuemax={question.total}
          aria-valuenow={answeredCount}
        >
          <div
            className="mock-test__progress-bar"
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      )}

      <div className="mock-test__card">
        {returnedToSkipped && (
          <p className="mock-test__muted" role="note">
            Returning to a question you skipped. You can answer it or skip it
            again, but every question must be answered before you can submit.
          </p>
        )}
        <p className="mock-test__stem">{question.stem}</p>
        {question.leadIn && <p className="mock-test__lead-in">{question.leadIn}</p>}
        {question.status === "ANSWERED" && (
          <p className="mock-test__muted" role="note">
            This question is already answered in this attempt. Choose the same
            answer to continue, or discard the attempt from the overview.
          </p>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (selectedChoiceId && !disabled) onAnswer(selectedChoiceId);
          }}
        >
          <fieldset className="mock-test__fieldset" disabled={disabled}>
            <legend className="mock-test__legend">Answer choices</legend>
            <div className="mock-test__choices">
              {question.choices.map((choice) => {
                const selected = selectedChoiceId === choice.id;
                return (
                  <label
                    key={choice.id}
                    className={`mock-test__choice${selected ? " mock-test__choice--selected" : ""}`}
                  >
                    <input
                      type="radio"
                      name={`question-${question.position}`}
                      value={choice.id}
                      checked={selected}
                      onChange={() => setSelectedChoiceId(choice.id)}
                      aria-label={`Option ${choice.letter}: ${choice.text}`}
                    />
                    <span className="mock-test__radio" aria-hidden="true" />
                    <span className="mock-test__choice-text">
                      <span className="mock-test__choice-label">
                        {choice.letter}.
                      </span>{" "}
                      {choice.text}
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {savingLabel && (
            <p role="status" className="mock-test__saving">
              {savingLabel}
            </p>
          )}

          {error && (
            <div className="mock-test__error-block">
              <p role="alert" className="mock-test__error">
                {error}
              </p>
              {retryAvailable && (
                <button
                  type="button"
                  className="mock-test__btn mock-test__btn--ghost"
                  disabled={disabled}
                  onClick={onRetryAnswer}
                >
                  Retry answer
                </button>
              )}
            </div>
          )}

          <div className="mock-test__actions mock-test__exam-actions">
            <button
              type="button"
              className="mock-test__btn mock-test__btn--skip"
              disabled={disabled}
              onClick={onSkip}
            >
              <SkipForward size={18} aria-hidden="true" />
              Skip Question
            </button>
            <button
              type="submit"
              className="mock-test__btn mock-test__btn--primary"
              disabled={!selectedChoiceId || disabled}
            >
              Answer &amp; Continue
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}

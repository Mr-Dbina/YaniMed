"use client";

import { useState } from "react";
import type { NavigatorItem } from "@/lib/mock-test-api";

interface PendingEdit {
  position: number;
  choiceId: string;
}

interface MockTestReviewProps {
  items: NavigatorItem[] | null;
  loading: boolean;
  loadError: string | null;
  savingPosition: number | null;
  pendingEdit: PendingEdit | null;
  submitting: boolean;
  error: string | null;
  readOnly: boolean;
  onEdit: (position: number, choiceId: string) => void;
  onRetry: () => void;
  onRetryEdit: () => void;
  onRequestSubmit: () => void;
  onExit: () => void;
}

export function MockTestReview({
  items,
  loading,
  loadError,
  savingPosition,
  pendingEdit,
  submitting,
  error,
  readOnly,
  onEdit,
  onRetry,
  onRetryEdit,
  onRequestSubmit,
  onExit,
}: MockTestReviewProps) {
  const [currentPosition, setCurrentPosition] = useState<number | null>(null);

  const ordered = items ? [...items].sort((a, b) => a.position - b.position) : [];
  const current =
    ordered.find((item) => item.position === (currentPosition ?? ordered[0]?.position)) ??
    null;

  if (loading) {
    return (
      <section className="mock-test" aria-labelledby="mock-test-review-heading">
        <h1 className="mock-test__title" id="mock-test-review-heading">
          Review your answers
        </h1>
        <p role="status">Loading your answers…</p>
      </section>
    );
  }

  if (!items) {
    return (
      <section className="mock-test" aria-labelledby="mock-test-review-heading">
        <h1 className="mock-test__title" id="mock-test-review-heading">
          Review your answers
        </h1>
        <div className="mock-test__error-block">
          <p role="alert" className="mock-test__error">
            {loadError ?? "Could not load your answers."}
          </p>
          <button
            type="button"
            className="mock-test__btn mock-test__btn--ghost"
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  if (!current) {
    return (
      <section className="mock-test" aria-labelledby="mock-test-review-heading">
        <h1 className="mock-test__title" id="mock-test-review-heading">
          Review your answers
        </h1>
        <p className="mock-test__muted">No questions are available to review.</p>
      </section>
    );
  }

  const activePosition = current.position;
  const answeredCount = ordered.filter((item) => item.answered).length;
  const allAnswered = ordered.length > 0 && answeredCount === ordered.length;
  const editing = savingPosition !== null;
  const disabled = submitting || readOnly || editing;
  const index = ordered.findIndex((item) => item.position === activePosition);

  return (
    <section className="mock-test" aria-labelledby="mock-test-review-heading">
      <header className="mock-test__top">
        <div>
          <h1 className="mock-test__title" id="mock-test-review-heading">
            Review your answers
          </h1>
          <p className="mock-test__muted">
            {answeredCount} of {ordered.length} answered. Correctness is hidden
            until you submit.
          </p>
        </div>
        <button
          type="button"
          className="mock-test__link"
          onClick={onExit}
          aria-label="Exit test and return to the test overview"
        >
          Exit test
        </button>
      </header>

      <div className="mock-test__card">
        <h2 className="mock-test__heading">Questions</h2>
        <p className="mock-test__muted">
          Filled numbers have a saved answer. Jump to any question to change it.
        </p>
        <div
          className="mock-test__navigator"
          role="group"
          aria-label="Question navigator"
        >
          {ordered.map((item) => (
            <button
              key={item.position}
              type="button"
              className={`mock-test__nav-item${item.answered ? " mock-test__nav-item--selected" : ""}`}
              aria-current={item.position === activePosition ? "true" : undefined}
              aria-label={`Question ${item.position}${item.answered ? ", answered" : ", not answered"}`}
              onClick={() => setCurrentPosition(item.position)}
            >
              {item.position}
            </button>
          ))}
        </div>
      </div>

      <div className="mock-test__card">
        <div className="mock-test__top">
          <h2 className="mock-test__heading">
            Question {activePosition}
            {!current.answered ? " — not answered" : ""}
          </h2>
          <div className="mock-test__actions">
            <button
              type="button"
              className="mock-test__btn mock-test__btn--ghost"
              disabled={index <= 0}
              onClick={() => setCurrentPosition(ordered[index - 1].position)}
            >
              Previous
            </button>
            <button
              type="button"
              className="mock-test__btn mock-test__btn--ghost"
              disabled={index < 0 || index >= ordered.length - 1}
              onClick={() => setCurrentPosition(ordered[index + 1].position)}
            >
              Next
            </button>
          </div>
        </div>

        <p className="mock-test__stem">{current.stem}</p>
        {current.leadIn && (
          <p className="mock-test__lead-in">{current.leadIn}</p>
        )}
        <fieldset
          className="mock-test__fieldset"
          disabled={disabled || !current.answered}
        >
          <legend className="mock-test__legend">Answer choices</legend>
          <div className="mock-test__choices">
            {current.choices.map((choice) => {
              const selected = current.selectedChoiceId === choice.id;
              return (
                <label
                  key={choice.id}
                  className={`mock-test__choice${selected ? " mock-test__choice--selected" : ""}`}
                >
                  <input
                    type="radio"
                    name={`review-question-${activePosition}`}
                    value={choice.id}
                    checked={selected}
                    onChange={() => onEdit(activePosition, choice.id)}
                    aria-label={`Option ${choice.letter}: ${choice.text}`}
                  />
                  <span className="mock-test__choice-letter" aria-hidden="true">
                    {choice.letter}
                  </span>
                  <span className="mock-test__choice-text">{choice.text}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {savingPosition === activePosition && (
          <p role="status" className="mock-test__saving">
            Saving answer…
          </p>
        )}
        {!current.answered && (
          <p className="mock-test__muted">
            This question has no saved answer. Only answered questions can be
            changed before submitting.
          </p>
        )}

        {pendingEdit && pendingEdit.position === activePosition && (
          <div className="mock-test__error-block">
            <p role="alert" className="mock-test__error">
              {error ?? "The answer was not saved."}
            </p>
            <button
              type="button"
              className="mock-test__btn mock-test__btn--ghost"
              disabled={disabled}
              onClick={onRetryEdit}
            >
              Retry saving
            </button>
          </div>
        )}

        {(!pendingEdit || pendingEdit.position !== activePosition) && error && (
          <p role="alert" className="mock-test__error">
            {error}
          </p>
        )}
      </div>

      <div className="mock-test__actions">
        <button
          type="button"
          className="mock-test__btn mock-test__btn--primary"
          disabled={!allAnswered || disabled}
          onClick={onRequestSubmit}
        >
          Submit test
        </button>
        {!allAnswered && (
          <span className="mock-test__muted">
            Every question must be answered before submitting.
          </span>
        )}
      </div>
    </section>
  );
}

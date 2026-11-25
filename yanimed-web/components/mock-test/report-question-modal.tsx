"use client";

import { useState } from "react";
import { X, AlertTriangle } from "lucide-react";
import type { QuestionReportReason } from "@/lib/mock-test-api";

interface ReportQuestionModalProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (reason: QuestionReportReason, details: string) => Promise<void>;
  busy: boolean;
  error: string | null;
  questionPosition: number;
}

const REASONS: { value: QuestionReportReason; label: string; description: string }[] = [
  {
    value: "ANSWER_KEY",
    label: "Wrong answer key",
    description: "The marked correct answer appears to be incorrect",
  },
  {
    value: "AMBIGUITY",
    label: "Unclear question stem",
    description: "The question is ambiguous, vague, or could have multiple valid answers",
  },
  {
    value: "CITATION",
    label: "Bad citation",
    description: "The cited source does not support the question or answer",
  },
  {
    value: "EXPLANATION",
    label: "Incorrect explanation",
    description: "The rationale for the correct answer is wrong or misleading",
  },
  {
    value: "OTHER",
    label: "Other issue",
    description: "A different problem not covered above",
  },
];

export function ReportQuestionModal({
  open,
  onClose,
  onSubmit,
  busy,
  error,
  questionPosition,
}: ReportQuestionModalProps) {
  const [selectedReason, setSelectedReason] = useState<QuestionReportReason>("ANSWER_KEY");
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  if (!open) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(selectedReason, details.trim());
      onClose();
    } catch {
      // Error handled by parent
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="report-modal__backdrop" onClick={onClose} aria-hidden="true" />
      <div className="report-modal" role="dialog" aria-modal="true" aria-labelledby="report-modal-title">
      <div className="report-modal__header">
        <h2 id="report-modal-title" className="report-modal__title">
          Report Question {questionPosition}
        </h2>
        <button
          type="button"
          className="report-modal__close"
          onClick={onClose}
          disabled={submitting}
          aria-label="Close report dialog"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="report-modal__form">
        <div className="report-modal__body">
          <p className="report-modal__description">
            Your report helps improve the question bank. The question will be
            quarantined immediately so it won't appear in future tests until reviewed.
          </p>

          <fieldset className="report-modal__fieldset">
            <legend className="report-modal__legend">Reason for reporting</legend>
            <div className="report-modal__reasons" role="radiogroup" aria-label="Report reason">
              {REASONS.map((reason) => (
                <label
                  key={reason.value}
                  className={`report-modal__reason${
                    selectedReason === reason.value ? " report-modal__reason--selected" : ""
                  }`}
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={reason.value}
                    checked={selectedReason === reason.value}
                    onChange={() => setSelectedReason(reason.value)}
                    disabled={submitting}
                    aria-describedby={`reason-desc-${reason.value}`}
                  />
                  <span className="report-modal__radio" aria-hidden="true" />
                  <div className="report-modal__reason-content">
                    <span className="report-modal__reason-label">{reason.label}</span>
                    <span
                      id={`reason-desc-${reason.value}`}
                      className="report-modal__reason-desc"
                    >
                      {reason.description}
                    </span>
                  </div>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="report-modal__field">
            <label htmlFor="report-details" className="report-modal__label">
              Additional details (optional)
            </label>
            <textarea
              id="report-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              placeholder="Add any context, specific concerns, or suggestions…"
              rows={4}
              maxLength={2000}
              disabled={submitting}
              className="report-modal__textarea"
            />
            <p className="report-modal__char-count">
              {details.length}/2000
            </p>
          </div>

          {error && (
            <div className="report-modal__error" role="alert">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="report-modal__actions">
          <button
            type="button"
            className="report-modal__btn report-modal__btn--ghost"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="report-modal__btn report-modal__btn--danger"
            disabled={submitting}
          >
            {submitting ? "Submitting…" : "Submit Report"}
          </button>
        </div>
      </form>
    </div>
    </>
  );
}
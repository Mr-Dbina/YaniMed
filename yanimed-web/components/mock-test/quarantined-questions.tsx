"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, RotateCcw, Trash2, CheckCircle2, AlertTriangle, FileText, Eye } from "lucide-react";
import {
  getQuarantinedQuestions,
  resolveReport,
  type QuarantinedQuestion,
  type QuestionReport,
} from "@/lib/mock-test-api";

interface QuarantinedQuestionsProps {
  onBack: () => void;
}

function formatReason(reason: string): string {
  const labels: Record<string, string> = {
    ANSWER_KEY: "Wrong answer key",
    AMBIGUITY: "Unclear question stem",
    CITATION: "Bad citation",
    EXPLANATION: "Incorrect explanation",
    OTHER: "Other issue",
  };
  return labels[reason] ?? reason;
}

function formatStatus(status: string): string {
  return status === "OPEN" ? "Open" : status === "ACCEPTED" ? "Accepted" : "Dismissed";
}

export function QuarantinedQuestions({ onBack }: QuarantinedQuestionsProps) {
  const [questions, setQuestions] = useState<QuarantinedQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedQuestionId, setExpandedQuestionId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [showCitation, setShowCitation] = useState<{ questionId: string; citationIndex: number } | null>(null);

  useEffect(() => {
    loadQuestions();
  }, []);

  const loadQuestions = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await getQuarantinedQuestions();
      setQuestions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quarantined questions");
    } finally {
      setLoading(false);
    }
  };

  const handleResolve = async (
    questionId: string,
    action: "RESTORE" | "RETIRE",
    resolutionNote?: string,
  ) => {
    setResolving(questionId);
    setResolveError(null);
    try {
      await resolveReport(questionId, { action, resolutionNote });
      setQuestions((prev) =>
        prev.map((q) =>
          q.questionId === questionId
            ? { ...q, status: action === "RESTORE" ? "ACTIVE" : "RETIRED", reports: q.reports.map((r) => ({ ...r, status: action === "RESTORE" ? "DISMISSED" : "ACCEPTED" })) }
            : q,
        ),
      );
      setExpandedQuestionId(null);
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Failed to resolve report");
    } finally {
      setResolving(null);
    }
  };

  const toggleExpand = (questionId: string) => {
    setExpandedQuestionId((prev) => (prev === questionId ? null : questionId));
  };

  if (loading) {
    return (
      <section className="quarantined-questions">
        <div className="quarantined-questions__header">
          <button type="button" className="quarantined-questions__back" onClick={onBack}>
            <ArrowLeft size={18} aria-hidden="true" /> Back
          </button>
          <h1 className="quarantined-questions__title">Quarantined Questions</h1>
        </div>
        <p role="status" className="quarantined-questions__loading">Loading quarantined questions…</p>
      </section>
    );
  }

  if (error) {
    return (
      <section className="quarantined-questions">
        <div className="quarantined-questions__header">
          <button type="button" className="quarantined-questions__back" onClick={onBack}>
            <ArrowLeft size={18} aria-hidden="true" /> Back
          </button>
          <h1 className="quarantined-questions__title">Quarantined Questions</h1>
        </div>
        <div className="quarantined-questions__error">
          <AlertTriangle size={24} aria-hidden="true" />
          <p>{error}</p>
          <button type="button" className="quarantined-questions__btn" onClick={loadQuestions}>
            <RotateCcw size={16} aria-hidden="true" /> Retry
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="quarantined-questions">
      <div className="quarantined-questions__header">
        <button type="button" className="quarantined-questions__back" onClick={onBack}>
          <ArrowLeft size={18} aria-hidden="true" /> Back
        </button>
        <div>
          <h1 className="quarantined-questions__title">Quarantined Questions</h1>
          <p className="quarantined-questions__subtitle">
            {questions.length} question{questions.length !== 1 ? "s" : ""} flagged for review
          </p>
        </div>
      </div>

      {questions.length === 0 ? (
        <div className="quarantined-questions__empty">
          <FileText size={48} aria-hidden="true" />
          <p>No quarantined questions</p>
          <span className="quarantined-questions__empty-desc">
            Questions reported during mock tests will appear here for review.
          </span>
        </div>
      ) : (
        <div className="quarantined-questions__list" role="list">
          {questions.map((question) => (
            <article
              key={question.questionId}
              className={`quarantined-questions__item${expandedQuestionId === question.questionId ? " quarantined-questions__item--expanded" : ""}`}
            >
              <div className="quarantined-questions__item-header" onClick={() => toggleExpand(question.questionId)}>
                <div className="quarantined-questions__item-main">
                  <p className="quarantined-questions__stem">{question.stem}</p>
                  <div className="quarantined-questions__meta">
                    <span className={`quarantined-questions__badge quarantined-questions__badge--${question.status.toLowerCase()}`}>
                      {question.status}
                    </span>
                    <span className="quarantined-questions__report-count">
                      {question.reports.length} report{question.reports.length !== 1 ? "s" : ""}
                    </span>
                  </div>
                </div>
                <span className="quarantined-questions__expand-hint" aria-hidden="true">▼</span>
              </div>

              {expandedQuestionId === question.questionId && (
                <div className="quarantined-questions__item-body">
                  {question.leadIn && (
                    <p className="quarantined-questions__lead-in">{question.leadIn}</p>
                  )}

                  <div className="quarantined-questions__choices">
                    <h4 className="quarantined-questions__section-title">Answer Choices</h4>
                    {question.choices.map((choice) => (
                      <div
                        key={choice.id}
                        className={`quarantined-questions__choice${choice.isCorrect ? " quarantined-questions__choice--correct" : ""}`}
                      >
                        <span className="quarantined-questions__choice-letter">{String.fromCharCode(65 + choice.position - 1)}.</span>
                        <span className="quarantined-questions__choice-text">{choice.text}</span>
                        {choice.isCorrect && (
                          <span className="quarantined-questions__correct-badge">
                            <CheckCircle2 size={14} aria-hidden="true" /> Correct
                          </span>
                        )}
                        <p className="quarantined-questions__explanation">{choice.explanation || "No explanation provided."}</p>
                      </div>
                    ))}
                  </div>

                  <div className="quarantined-questions__citations">
                    <h4 className="quarantined-questions__section-title">Citations</h4>
                    {question.citations.length > 0 ? (
                      question.citations.map((citation, index) => (
                        <div key={`${citation.documentTitleSnapshot}-${citation.pageNumber}-${index}`} className="quarantined-questions__citation">
                          <div className="quarantined-questions__citation-header">
                            <strong>{citation.documentTitleSnapshot}</strong>
                            <span className="quarantined-questions__page">Page {citation.pageNumber}</span>
                            <button
                              type="button"
                              className="quarantined-questions__btn quarantined-questions__btn--ghost"
                              onClick={() => setShowCitation({ questionId: question.questionId, citationIndex: index })}
                            >
                              <Eye size={16} aria-hidden="true" /> View quote
                            </button>
                          </div>
                        </div>
                      ))
                    ) : (
                      <p className="quarantined-questions__muted">No citations available for this question.</p>
                    )}
                  </div>

                  <div className="quarantined-questions__reports">
                    <h4 className="quarantined-questions__section-title">Reports</h4>
                    {question.reports.map((report) => (
                      <div key={report.id} className="quarantined-questions__report">
                        <div className="quarantined-questions__report-header">
                          <span className={`quarantined-questions__report-reason`}>{formatReason(report.reason)}</span>
                          <span className={`quarantined-questions__report-status quarantined-questions__report-status--${report.status.toLowerCase()}`}>
                            {formatStatus(report.status)}
                          </span>
                        </div>
                        {report.details && (
                          <p className="quarantined-questions__report-details">{report.details}</p>
                        )}
                        <p className="quarantined-questions__report-date">
                          Reported {new Date(report.createdAt).toLocaleDateString()}
                        </p>
                        {report.resolutionNote && (
                          <p className="quarantined-questions__resolution-note">
                            <strong>Resolution:</strong> {report.resolutionNote}
                          </p>
                        )}
                      </div>
                    ))}
                  </div>

                  {question.status === "QUARANTINED" && (
                    <div className="quarantined-questions__actions">
                      <button
                        type="button"
                        className="quarantined-questions__btn quarantined-questions__btn--primary"
                        disabled={resolving === question.questionId}
                        onClick={() => handleResolve(question.questionId, "RESTORE")}
                      >
                        {resolving === question.questionId ? (
                          <>
                            <RotateCcw size={16} aria-hidden="true" className="quarantined-questions__spinning" /> Restoring…
                          </>
                        ) : (
                          <>
                            <RotateCcw size={16} aria-hidden="true" /> Restore to Active
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        className="quarantined-questions__btn quarantined-questions__btn--danger"
                        disabled={resolving === question.questionId}
                        onClick={() => handleResolve(question.questionId, "RETIRE")}
                      >
                        {resolving === question.questionId ? (
                          <>
                            <RotateCcw size={16} aria-hidden="true" className="quarantined-questions__spinning" /> Retiring…
                          </>
                        ) : (
                          <>
                            <Trash2 size={16} aria-hidden="true" /> Retire Question
                          </>
                        )}
                      </button>
                    </div>
                  )}

                  {resolveError && expandedQuestionId === question.questionId && (
                    <div className="quarantined-questions__error-inline" role="alert">
                      <AlertTriangle size={16} aria-hidden="true" />
                      <span>{resolveError}</span>
                    </div>
                  )}
                </div>
              )}
            </article>
          ))}
        </div>
      )}

      {showCitation && (
        <>
          <div className="quarantined-questions__citation-modal-backdrop" onClick={() => setShowCitation(null)} />
          <div className="quarantined-questions__citation-modal" role="dialog" aria-modal="true">
          <div className="quarantined-questions__citation-modal-header">
            <h3>Citation Quote</h3>
            <button
              type="button"
              className="quarantined-questions__citation-modal-close"
              onClick={() => setShowCitation(null)}
              aria-label="Close citation"
            >
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
          </div>
          <div className="quarantined-questions__citation-modal-body">
            {(() => {
              const q = questions.find((qq) => qq.questionId === showCitation!.questionId);
              const citation = q?.citations[showCitation!.citationIndex];
              if (!citation) return <p>Quote not available.</p>;
              return (
                <>
                  <p className="quarantined-questions__citation-source">
                    <strong>{citation.documentTitleSnapshot}</strong> — Page {citation.pageNumber}
                  </p>
                  <blockquote className="quarantined-questions__quote">{citation.quote || "No quote available."}</blockquote>
                </>
              );
            })()}
          </div>
        </div>
        </>
      )}
    </section>
  );
}
"use client";

import { useEffect, useRef, useState } from "react";
import {
  RotateCcw,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  FileText,
  Eye,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import {
  getQuarantinedQuestions,
  resolveReport,
  type QuarantinedQuestion,
} from "@/lib/mock-test-api";
import { ConfirmDialog } from "@/components/mock-test/confirm-dialog";

const PAGE_SIZE = 10;

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

export function QuarantinedQuestions() {
  const [questions, setQuestions] = useState<QuarantinedQuestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [page, setPage] = useState(1);
  const [expandedQuestionId, setExpandedQuestionId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [resolveSuccess, setResolveSuccess] = useState<string | null>(null);
  const [retireConfirmId, setRetireConfirmId] = useState<string | null>(null);
  const [showCitation, setShowCitation] = useState<{ questionId: string; citationIndex: number } | null>(null);
  const sectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getQuarantinedQuestions()
      .then((data) => {
        if (!cancelled) setQuestions(data);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load quarantined questions");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  useEffect(() => {
    if (!showCitation) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setShowCitation(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showCitation]);

  const handleRetry = () => {
    setLoading(true);
    setError(null);
    setResolveError(null);
    setResolveSuccess(null);
    setReloadToken((token) => token + 1);
  };

  const handleResolve = async (
    questionId: string,
    action: "RESTORE" | "RETIRE",
    resolutionNote?: string,
  ) => {
    setResolving(questionId);
    setResolveError(null);
    setResolveSuccess(null);
    try {
      await resolveReport(questionId, { action, resolutionNote });
      setQuestions((prev) =>
        prev.map((q) =>
          q.questionId === questionId
            ? {
                ...q,
                status: action === "RESTORE" ? "ACTIVE" : "RETIRED",
                reports: q.reports.map((r) => ({
                  ...r,
                  status: action === "RESTORE" ? "DISMISSED" : "ACCEPTED",
                })),
              }
            : q,
        ),
      );
      setExpandedQuestionId(null);
      setResolveSuccess(
        action === "RESTORE" ? "Question restored to active." : "Question retired.",
      );
    } catch (err) {
      setResolveError(err instanceof Error ? err.message : "Failed to resolve report");
    } finally {
      setResolving(null);
      setRetireConfirmId(null);
    }
  };

  const toggleExpand = (questionId: string) => {
    setResolveError(null);
    setExpandedQuestionId((prev) => (prev === questionId ? null : questionId));
  };

  const totalPages = Math.max(1, Math.ceil(questions.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const startIndex = (currentPage - 1) * PAGE_SIZE;
  const paginatedQuestions = questions.slice(startIndex, startIndex + PAGE_SIZE);

  const goToPage = (nextPage: number) => {
    const clamped = Math.max(1, Math.min(totalPages, nextPage));
    setPage(clamped);
    setExpandedQuestionId(null);
    setResolveError(null);
    sectionRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  };

  if (loading) {
    return (
      <section className="quarantined-questions">
        <div className="quarantined-questions__header">
          <div className="quarantined-questions__heading-row">
            <h1 className="settings-page-title quarantined-questions__title">Quarantined Questions</h1>
          </div>
        </div>
        <div className="quarantined-questions__state" role="status">
          <RotateCcw size={20} aria-hidden="true" className="quarantined-questions__spinning" />
          <p className="quarantined-questions__state-text">Loading quarantined questions…</p>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="quarantined-questions">
        <div className="quarantined-questions__header">
          <div className="quarantined-questions__heading-row">
            <h1 className="settings-page-title quarantined-questions__title">Quarantined Questions</h1>
          </div>
        </div>
        <div className="quarantined-questions__state quarantined-questions__state--error" role="alert">
          <AlertTriangle size={24} aria-hidden="true" />
          <p className="quarantined-questions__state-title">Could not load quarantined questions</p>
          <p className="quarantined-questions__state-text">{error}</p>
          <button
            type="button"
            className="quarantined-questions__btn quarantined-questions__btn--primary"
            onClick={handleRetry}
          >
            <RotateCcw size={16} aria-hidden="true" /> Retry
          </button>
        </div>
      </section>
    );
  }

  return (
    <section ref={sectionRef} className="quarantined-questions">
      <div className="quarantined-questions__header">
        <div className="quarantined-questions__heading-row">
          <h1 className="settings-page-title quarantined-questions__title">Quarantined Questions</h1>
          <span className="quarantined-questions__count" aria-label={`${questions.length} total`}>
            {questions.length}
          </span>
        </div>
        <p className="quarantined-questions__subtitle">
          {questions.length} question{questions.length !== 1 ? "s" : ""} flagged for review
        </p>
      </div>

      {resolveSuccess && (
        <div className="quarantined-questions__banner quarantined-questions__banner--success" role="status">
          <CheckCircle2 size={16} aria-hidden="true" />
          <span className="quarantined-questions__banner-text">{resolveSuccess}</span>
          <button
            type="button"
            className="quarantined-questions__banner-close"
            onClick={() => setResolveSuccess(null)}
            aria-label="Dismiss message"
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}

      {questions.length === 0 ? (
        <div className="quarantined-questions__state">
          <FileText size={40} aria-hidden="true" className="quarantined-questions__empty-icon" />
          <p className="quarantined-questions__state-title">No quarantined questions</p>
          <p className="quarantined-questions__state-text">
            Questions reported during mock tests will appear here for review.
          </p>
        </div>
      ) : (
        <>
          <div className="quarantined-questions__list" role="list">
            {paginatedQuestions.map((question) => {
              const isExpanded = expandedQuestionId === question.questionId;
              const isResolving = resolving === question.questionId;
              const bodyId = `quarantined-body-${question.questionId}`;

              return (
                <article
                  key={question.questionId}
                  role="listitem"
                  className={`quarantined-questions__item${isExpanded ? " quarantined-questions__item--expanded" : ""}`}
                >
                  <button
                    type="button"
                    className="quarantined-questions__item-header"
                    aria-expanded={isExpanded}
                    aria-controls={bodyId}
                    onClick={() => toggleExpand(question.questionId)}
                  >
                    <div className="quarantined-questions__item-main">
                      <p className="quarantined-questions__stem">{question.stem}</p>
                      <div className="quarantined-questions__meta">
                        <span
                          className={`quarantined-questions__badge quarantined-questions__badge--${question.status.toLowerCase()}`}
                        >
                          {question.status}
                        </span>
                        <span className="quarantined-questions__report-count">
                          {question.reports.length} report{question.reports.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                    </div>
                    <span className="quarantined-questions__chevron" aria-hidden="true">
                      <ChevronDown size={18} />
                    </span>
                  </button>

                  {isExpanded && (
                    <div id={bodyId} className="quarantined-questions__item-body">
                      <div className="quarantined-questions__section">
                        <h4 className="quarantined-questions__section-title">Question Stem</h4>
                        <p className="quarantined-questions__stem-full">{question.stem}</p>
                        {question.leadIn && (
                          <p className="quarantined-questions__lead-in">{question.leadIn}</p>
                        )}
                        {question.educationalObjective && (
                          <p className="quarantined-questions__objective">
                            <strong>Educational objective:</strong> {question.educationalObjective}
                          </p>
                        )}
                      </div>

                      <div className="quarantined-questions__section">
                        <h4 className="quarantined-questions__section-title">Answer Choices</h4>
                        <div className="quarantined-questions__choices">
                          {question.choices.map((choice) => (
                            <div
                              key={choice.id}
                              className={`quarantined-questions__choice${choice.isCorrect ? " quarantined-questions__choice--correct" : ""}`}
                            >
                              <div className="quarantined-questions__choice-top">
                                <span className="quarantined-questions__choice-letter">
                                  {String.fromCharCode(65 + choice.position - 1)}.
                                </span>
                                <span className="quarantined-questions__choice-text">{choice.text}</span>
                                {choice.isCorrect && (
                                  <span className="quarantined-questions__correct-badge">
                                    <CheckCircle2 size={14} aria-hidden="true" /> Correct
                                  </span>
                                )}
                              </div>
                              <p className="quarantined-questions__explanation">
                                {choice.explanation || "No explanation provided."}
                              </p>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="quarantined-questions__section">
                        <h4 className="quarantined-questions__section-title">Citations</h4>
                        {question.citations.length > 0 ? (
                          <div className="quarantined-questions__citations">
                            {question.citations.map((citation, index) => (
                              <div
                                key={`${citation.documentTitleSnapshot}-${citation.pageNumber}-${index}`}
                                className="quarantined-questions__citation"
                              >
                                <div className="quarantined-questions__citation-info">
                                  <strong>{citation.documentTitleSnapshot}</strong>
                                  <span className="quarantined-questions__page">
                                    Page {citation.pageNumber}
                                  </span>
                                </div>
                                <button
                                  type="button"
                                  className="quarantined-questions__btn quarantined-questions__btn--ghost"
                                  onClick={() =>
                                    setShowCitation({
                                      questionId: question.questionId,
                                      citationIndex: index,
                                    })
                                  }
                                >
                                  <Eye size={16} aria-hidden="true" /> View quote
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="quarantined-questions__muted">
                            No citations available for this question.
                          </p>
                        )}
                      </div>

                      <div className="quarantined-questions__section">
                        <h4 className="quarantined-questions__section-title">Reports</h4>
                        {question.reports.length > 0 ? (
                          <div className="quarantined-questions__reports">
                            {question.reports.map((report) => (
                              <div key={report.id} className="quarantined-questions__report">
                                <div className="quarantined-questions__report-header">
                                  <span className="quarantined-questions__report-reason">
                                    {formatReason(report.reason)}
                                  </span>
                                  <span
                                    className={`quarantined-questions__report-status quarantined-questions__report-status--${report.status.toLowerCase()}`}
                                  >
                                    {formatStatus(report.status)}
                                  </span>
                                </div>
                                {report.details && (
                                  <p className="quarantined-questions__report-details">
                                    {report.details}
                                  </p>
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
                        ) : (
                          <p className="quarantined-questions__muted">No reports attached.</p>
                        )}
                      </div>

                      {question.status === "QUARANTINED" && (
                        <div className="quarantined-questions__actions">
                          <button
                            type="button"
                            className="quarantined-questions__btn quarantined-questions__btn--primary"
                            disabled={resolving !== null}
                            onClick={() => handleResolve(question.questionId, "RESTORE")}
                          >
                            {isResolving ? (
                              <>
                                <RotateCcw
                                  size={16}
                                  aria-hidden="true"
                                  className="quarantined-questions__spinning"
                                />{" "}
                                Saving…
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
                            disabled={resolving !== null}
                            onClick={() => setRetireConfirmId(question.questionId)}
                          >
                            <Trash2 size={16} aria-hidden="true" /> Retire Question
                          </button>
                        </div>
                      )}

                      {resolveError && (
                        <div className="quarantined-questions__banner quarantined-questions__banner--error" role="alert">
                          <AlertTriangle size={16} aria-hidden="true" />
                          <span className="quarantined-questions__banner-text">{resolveError}</span>
                        </div>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>

          {totalPages > 1 && (
            <nav className="quarantined-questions__pagination" aria-label="Pagination">
              <span className="quarantined-questions__pagination-summary">
                Showing {startIndex + 1}–{Math.min(startIndex + PAGE_SIZE, questions.length)} of{" "}
                {questions.length}
              </span>
              <div className="quarantined-questions__pagination-controls">
                <button
                  type="button"
                  className="quarantined-questions__btn quarantined-questions__btn--ghost"
                  disabled={currentPage <= 1}
                  onClick={() => goToPage(currentPage - 1)}
                >
                  <ChevronLeft size={16} aria-hidden="true" /> Previous
                </button>
                <span className="quarantined-questions__pagination-page">
                  Page {currentPage} of {totalPages}
                </span>
                <button
                  type="button"
                  className="quarantined-questions__btn quarantined-questions__btn--ghost"
                  disabled={currentPage >= totalPages}
                  onClick={() => goToPage(currentPage + 1)}
                >
                  Next <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            </nav>
          )}
        </>
      )}

      <ConfirmDialog
        open={retireConfirmId !== null}
        title="Retire this question?"
        message="This will retire the question and mark its open reports as accepted. Retired questions will no longer appear in mock tests."
        confirmLabel="Retire Question"
        danger
        busy={retireConfirmId !== null && resolving === retireConfirmId}
        onConfirm={() => {
          if (retireConfirmId) void handleResolve(retireConfirmId, "RETIRE");
        }}
        onCancel={() => {
          if (resolving === null) setRetireConfirmId(null);
        }}
      />

      {showCitation && (
        <div
          className="subject-modal__overlay subject-modal__overlay--fixed"
          onMouseDown={() => setShowCitation(null)}
        >
          <div
            className="subject-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="citation-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="subject-modal__header">
              <h2 id="citation-modal-title" className="subject-modal__title subject-modal__title--sm">
                Citation Quote
              </h2>
              <button
                type="button"
                className="subject-modal__close"
                onClick={() => setShowCitation(null)}
                aria-label="Close citation"
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>
            <div className="quarantined-questions__citation-modal-body">
              {(() => {
                const q = questions.find((qq) => qq.questionId === showCitation.questionId);
                const citation = q?.citations[showCitation.citationIndex];
                if (!citation) return <p className="quarantined-questions__muted">Quote not available.</p>;
                return (
                  <>
                    <p className="quarantined-questions__citation-source">
                      <strong>{citation.documentTitleSnapshot}</strong> — Page {citation.pageNumber}
                    </p>
                    <blockquote className="quarantined-questions__quote">
                      {citation.quote || "No quote available."}
                    </blockquote>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
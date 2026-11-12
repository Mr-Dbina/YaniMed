"use client";

import { useId, useState } from "react";
import { Search } from "lucide-react";
import type {
  MockAttemptStatus,
  MockTestApiError,
  SubjectOverview,
} from "@/lib/mock-test-api";
import { StudyAidNotice } from "@/components/mock-test/study-aid-notice";
import { ConfirmDialog } from "@/components/mock-test/confirm-dialog";

export interface SyncedSubjectOption {
  backendId: string;
  name: string;
  documentCount: number;
}

interface MockTestStartProps {
  syncedSubjects: SyncedSubjectOption[];
  selectedSubjectId: string | null;
  activeIsLocalOnly: boolean;
  onSelectSubject: (backendId: string | null) => void;
  overview: SubjectOverview | null;
  loading: boolean;
  error: MockTestApiError | null;
  actionError: string | null;
  busy: boolean;
  onRetryOverview: () => void;
  onStart: () => void;
  onResume: (attemptId: string) => void;
  onRequestDiscard: (attemptId: string) => void;
}

const UNFINISHED_LABEL: Partial<Record<MockAttemptStatus, string>> = {
  GENERATING: "Questions are being generated",
  READY: "Ready to start",
  IN_PROGRESS: "In progress",
  AWAITING_SUBMISSION: "All questions answered — ready to submit",
};

function flagOff(error: MockTestApiError): boolean {
  return error.status === 404 && !error.code;
}

function pdfLabel(count: number): string {
  return `${count} PDF${count === 1 ? "" : "s"}`;
}

export function MockTestStart({
  syncedSubjects,
  selectedSubjectId,
  activeIsLocalOnly,
  onSelectSubject,
  overview,
  loading,
  error,
  actionError,
  busy,
  onRetryOverview,
  onStart,
  onResume,
  onRequestDiscard,
}: MockTestStartProps) {
  const searchId = useId();
  const [search, setSearch] = useState("");
  const [pendingSubject, setPendingSubject] =
    useState<SyncedSubjectOption | null>(null);

  const unfinished = overview?.unfinishedAttempt ?? null;
  const required = overview?.questionsPerTest ?? 25;
  const eligible = overview?.eligibleQuestionCount ?? 0;
  const enoughQuestions = eligible >= required;
  const canStart = Boolean(selectedSubjectId) && enoughQuestions && !unfinished && !busy;

  const query = search.trim().toLowerCase();
  const visibleSubjects = query
    ? syncedSubjects.filter((subject) =>
        subject.name.toLowerCase().includes(query),
      )
    : syncedSubjects;

  return (
    <section className="mock-test" aria-labelledby="mock-test-title">
      <header className="mock-test__top">
        <div>
          <h1 id="mock-test-title" className="mock-test__title">
            Mock Test
          </h1>
          <p className="mock-test__muted">
            25 questions from your own PDFs. One question at a time, no timer.
          </p>
        </div>
      </header>

      <StudyAidNotice />

      {syncedSubjects.length === 0 ? (
        <div className="mock-test__card">
          <h2 className="mock-test__heading">No synced subjects yet</h2>
          <p className="mock-test__muted">
            Mock Test needs a subject that uploaded successfully to the server.
            Add a subject with a PDF first, then come back.
          </p>
        </div>
      ) : (
        <div className="mock-test__card">
          <label className="mock-test__search" htmlFor={searchId}>
            <Search
              className="mock-test__search-icon"
              size={18}
              aria-hidden="true"
            />
            <span className="mock-test__legend">Search subjects</span>
            <input
              id={searchId}
              type="search"
              className="mock-test__search-input"
              placeholder="Search subjects"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>

          {visibleSubjects.length === 0 ? (
            <p className="mock-test__muted" role="status">
              No subjects match your search.
            </p>
          ) : (
            <div className="mock-test__grid">
              {visibleSubjects.map((subject) => (
                <button
                  key={subject.backendId}
                  type="button"
                  className={`mock-test__subject-card${
                    subject.backendId === selectedSubjectId
                      ? " mock-test__subject-card--selected"
                      : ""
                  }`}
                  disabled={busy}
                  onClick={() => setPendingSubject(subject)}
                >
                  <span className="mock-test__subject-name">{subject.name}</span>
                  <span className="mock-test__subject-meta">
                    {pdfLabel(subject.documentCount)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {activeIsLocalOnly && (
            <p className="mock-test__muted" role="status">
              The active subject exists only in this browser. Choose a synced
              subject to start a Mock Test.
            </p>
          )}

          {loading && <p role="status">Loading subject…</p>}

          {error && !loading && (
            <div className="mock-test__error-block">
              <p role="alert" className="mock-test__error">
                {flagOff(error)
                  ? "Mock Test is not enabled on the server."
                  : error.message}
              </p>
              {!flagOff(error) && (
                <button
                  type="button"
                  className="mock-test__btn mock-test__btn--ghost"
                  onClick={onRetryOverview}
                >
                  Retry
                </button>
              )}
            </div>
          )}

          {overview && selectedSubjectId && !loading && (
            <>
              <p className="mock-test__stat">
                Eligible questions: <strong>{eligible}</strong> of{" "}
                <strong>{required}</strong>
              </p>

              {!enoughQuestions && (
                <p className="mock-test__warning" role="status">
                  This subject does not have enough eligible questions yet.
                  Add PDFs or wait for question generation, then refresh.
                </p>
              )}

              {unfinished ? (
                <div className="mock-test__unfinished">
                  <p>
                    <strong>Unfinished attempt</strong>
                    <span className="mock-test__muted">
                      {" "}
                      — {UNFINISHED_LABEL[unfinished.status] ?? unfinished.status}
                    </span>
                  </p>
                  <div className="mock-test__actions">
                    {unfinished.status !== "GENERATING" && (
                      <button
                        type="button"
                        className="mock-test__btn mock-test__btn--primary"
                        disabled={busy}
                        onClick={() => onResume(unfinished.id)}
                      >
                        Resume test
                      </button>
                    )}
                    <button
                      type="button"
                      className="mock-test__btn mock-test__btn--danger"
                      disabled={busy}
                      onClick={() => onRequestDiscard(unfinished.id)}
                    >
                      Discard attempt
                    </button>
                  </div>
                </div>
              ) : (
                <div className="mock-test__actions">
                  <button
                    type="button"
                    className="mock-test__btn mock-test__btn--primary"
                    disabled={!canStart}
                    onClick={onStart}
                  >
                    {busy ? "Starting…" : "Start test"}
                  </button>
                </div>
              )}
            </>
          )}

          {actionError && (
            <p role="alert" className="mock-test__error">
              {actionError}
            </p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={pendingSubject !== null}
        title={pendingSubject?.name ?? "Mock Test"}
        message="Do you want to take a mock test for this subject?"
        confirmLabel="Yes"
        cancelLabel="No"
        busy={busy}
        onConfirm={() => {
          if (!pendingSubject) return;
          const backendId = pendingSubject.backendId;
          setPendingSubject(null);
          onSelectSubject(backendId);
        }}
        onCancel={() => setPendingSubject(null)}
      />
    </section>
  );
}

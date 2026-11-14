"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  BarChart3,
  Check,
  ClipboardCheck,
  ClipboardList,
  Clock,
  FileQuestion,
  FileText,
  GraduationCap,
  Info,
  Play,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import {
  getSubjectOverview,
  type MockAttemptStatus,
  type MockTestApiError,
  type SubjectOverview,
} from "@/lib/mock-test-api";

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
  onResume: (attemptId: string) => void;
  onRequestDiscard: (attemptId: string) => void;
}

type SortMode = "default" | "recent" | "unfinished";

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
  onResume,
  onRequestDiscard,
}: MockTestStartProps) {
  const searchId = useId();
  const modalTitleId = useId();
  const filterWrapRef = useRef<HTMLDivElement>(null);
  const requestedRef = useRef<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("default");
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedBackendId, setSelectedBackendId] = useState<string | null>(null);
  const [pendingSubject, setPendingSubject] =
    useState<SyncedSubjectOption | null>(null);
  const [overviewBySubject, setOverviewBySubject] = useState<
    Record<string, SubjectOverview | null>
  >({});

  // Cache each subject overview once, so sorting and tags do not refetch.
  useEffect(() => {
    const missing = syncedSubjects
      .map((subject) => subject.backendId)
      .filter((id) => !requestedRef.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => requestedRef.current.add(id));
    void Promise.all(
      missing.map(async (id) => {
        try {
          return [id, await getSubjectOverview(id)] as const;
        } catch {
          return [id, null] as const;
        }
      }),
    ).then((results) => {
      setOverviewBySubject((current) => {
        const next = { ...current };
        results.forEach(([id, data]) => {
          next[id] = data;
        });
        return next;
      });
    });
  }, [syncedSubjects]);

  useEffect(() => {
    if (!filterOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      if (!filterWrapRef.current?.contains(event.target as Node)) {
        setFilterOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilterOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [filterOpen]);

  useEffect(() => {
    if (!pendingSubject) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPendingSubject(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [pendingSubject]);

  const unfinished = overview?.unfinishedAttempt ?? null;

  const selected = selectedBackendId
    ? syncedSubjects.find((subject) => subject.backendId === selectedBackendId) ??
      null
    : null;
  const selectedOverview =
    selected === null
      ? null
      : selected.backendId === selectedSubjectId && overview
        ? overview
        : (overviewBySubject[selected.backendId] ?? null);
  const required = selectedOverview?.questionsPerTest ?? 25;
  const eligible = selectedOverview?.eligibleQuestionCount ?? required;
  const notEnough = selectedOverview !== null && eligible < required;

  const query = search.trim().toLowerCase();
  const ordered = (() => {
    const list = [...syncedSubjects];
    if (sortMode === "recent") list.reverse();
    if (sortMode === "unfinished") {
      return list
        .map((subject, index) => ({ subject, index }))
        .sort((a, b) => {
          const aUnfinished = overviewBySubject[a.subject.backendId]?.unfinishedAttempt
            ? 1
            : 0;
          const bUnfinished = overviewBySubject[b.subject.backendId]?.unfinishedAttempt
            ? 1
            : 0;
          return bUnfinished - aUnfinished || a.index - b.index;
        })
        .map((entry) => entry.subject);
    }
    return list;
  })();
  const visibleSubjects = query
    ? ordered.filter((subject) => subject.name.toLowerCase().includes(query))
    : ordered;

  const closeModal = () => setPendingSubject(null);

  const sortOptions: { value: SortMode; label: string }[] = [
    { value: "recent", label: "Recently added" },
    { value: "unfinished", label: "Unfinished test first" },
  ];

  return (
    <section className="mock-test" aria-labelledby="mock-test-title">
      <header className="mock-test__dashboard-head">
        <div className="mock-test__dashboard-intro">
          <span className="mock-test__icon-tile" aria-hidden="true">
            <ClipboardList size={26} />
          </span>
          <div className="mock-test__dashboard-intro-text">
            <h1 id="mock-test-title" className="mock-test__title">
              Mock Test
            </h1>
            <p className="mock-test__muted">
              Challenge yourself with AI-generated PLE-style questions
            </p>
          </div>
        </div>
        <div className="mock-test__dashboard-tools">
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
              placeholder="Search subjects..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="mock-test__filter" ref={filterWrapRef}>
            <button
              type="button"
              className="mock-test__filter-btn"
              aria-label="Sort subjects"
              aria-haspopup="menu"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((open) => !open)}
            >
              <SlidersHorizontal size={20} aria-hidden="true" />
            </button>
            {filterOpen && (
              <div className="mock-test__filter-menu" role="menu">
                {sortOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sortMode === option.value}
                    className={`mock-test__filter-item${
                      sortMode === option.value
                        ? " mock-test__filter-item--active"
                        : ""
                    }`}
                    onClick={() => {
                      setSortMode(option.value);
                      setFilterOpen(false);
                    }}
                  >
                    <Check
                      size={16}
                      aria-hidden="true"
                      className={
                        sortMode === option.value
                          ? "mock-test__filter-check"
                          : "mock-test__filter-check mock-test__filter-check--hidden"
                      }
                    />
                    {option.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {syncedSubjects.length === 0 ? (
        <div className="mock-test__empty">
          <h2 className="mock-test__heading">No synced subjects yet</h2>
          <p className="mock-test__muted">
            Mock Test needs a subject that uploaded successfully to the server.
            Add a subject with a PDF first, then come back.
          </p>
        </div>
      ) : visibleSubjects.length === 0 ? (
        <p className="mock-test__muted" role="status">
          No subjects match your search.
        </p>
      ) : (
        <div className="mock-test__grid">
          {visibleSubjects.map((subject) => {
            const isSelected = subject.backendId === selectedBackendId;
            const isUnfinished =
              overviewBySubject[subject.backendId]?.unfinishedAttempt != null;
            return (
              <button
                key={subject.backendId}
                type="button"
                className={`mock-test__subject-card${
                  isSelected ? " mock-test__subject-card--selected" : ""
                }`}
                disabled={busy}
                aria-pressed={isSelected}
                onClick={() => setSelectedBackendId(subject.backendId)}
              >
                <span className="mock-test__subject-card-top">
                  {isUnfinished && (
                    <span className="mock-test__tag mock-test__tag--amber">
                      Unfinished
                    </span>
                  )}
                  <span
                    className={`mock-test__select-circle${
                      isSelected ? " mock-test__select-circle--checked" : ""
                    }`}
                    aria-hidden="true"
                  >
                    {isSelected && <Check size={15} />}
                  </span>
                </span>
                <span className="mock-test__subject-name">{subject.name}</span>
                <span className="mock-test__subject-meta">
                  <FileText size={16} aria-hidden="true" />
                  {pdfLabel(subject.documentCount)} uploaded
                </span>
                <span
                  className={`mock-test__subject-select${
                    isSelected ? " mock-test__subject-select--selected" : ""
                  }`}
                >
                  {isSelected ? "Selected" : "Select subject"}
                </span>
              </button>
            );
          })}
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

      {unfinished && selectedSubjectId && !loading && (
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
      )}

      {actionError && (
        <p role="alert" className="mock-test__error">
          {actionError}
        </p>
      )}

      {selected && (
        <section className="mock-test__card mock-test__selected" aria-live="polite">
          <div className="mock-test__panel-head">
            <span className="mock-test__selected-pill">Selected Subject</span>
            <span
              className={`mock-test__badge ${
                notEnough
                  ? "mock-test__badge--warning"
                  : "mock-test__badge--ready"
              }`}
            >
              {notEnough ? "Not enough questions" : "Ready"}
            </span>
          </div>

          <div className="mock-test__selected-body">
            <h2 className="mock-test__selected-name">{selected.name}</h2>
            <p className="mock-test__muted">
              {pdfLabel(selected.documentCount)} - Source material ready
            </p>

            <div className="mock-test__stats">
              <div className="mock-test__stat">
                <span className="mock-test__stat-icon" aria-hidden="true">
                  <FileQuestion size={20} />
                </span>
                <span className="mock-test__stat-label">Questions</span>
                <span className="mock-test__stat-value">
                  {required} questions
                </span>
              </div>
              <div className="mock-test__stat">
                <span className="mock-test__stat-icon" aria-hidden="true">
                  <GraduationCap size={20} />
                </span>
                <span className="mock-test__stat-label">Exam Type</span>
                <span className="mock-test__stat-value">PLE-style</span>
              </div>
              <div className="mock-test__stat">
                <span className="mock-test__stat-icon" aria-hidden="true">
                  <Clock size={20} />
                </span>
                <span className="mock-test__stat-label">Time Limit</span>
                <span className="mock-test__stat-value">No time limits</span>
              </div>
              <div className="mock-test__stat">
                <span className="mock-test__stat-icon" aria-hidden="true">
                  <FileText size={20} />
                </span>
                <span className="mock-test__stat-label">Question Source</span>
                <span className="mock-test__stat-value">Your PDFs</span>
              </div>
            </div>

            {notEnough && (
              <p className="mock-test__muted" role="status">
                This subject has {eligible} of {required} eligible questions.
                Starting the Mock Test will generate the rest automatically.
              </p>
            )}

            <button
              type="button"
              className="mock-test__btn mock-test__btn--primary mock-test__start-btn"
              disabled={busy}
              onClick={() => setPendingSubject(selected)}
            >
              <Play size={18} aria-hidden="true" />
              Start Mock Test
            </button>
          </div>
        </section>
      )}

      <section className="mock-test__recent" aria-labelledby="mock-test-recent-title">
        <h2 className="mock-test__section-title" id="mock-test-recent-title">
          <BarChart3 size={20} aria-hidden="true" />
          Recent Attempts
        </h2>
        <div className="mock-test__recent-empty">
          <span className="mock-test__recent-icon" aria-hidden="true">
            <ClipboardCheck size={36} />
          </span>
          <p className="mock-test__heading">No completed attempts yet</p>
          <p className="mock-test__muted">
            Your completed mock tests will appear here.
          </p>
        </div>
      </section>

      <p className="mock-test__footer-note">
        <Info size={16} aria-hidden="true" />
        Study aid only. AI-generated questions are based on your uploaded PDFs
        and are not medical advice.
      </p>

      {pendingSubject && (
        <div className="mock-test__modal-overlay" onMouseDown={closeModal}>
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={modalTitleId}
            className="mock-test__modal"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="mock-test__modal-close"
              onClick={closeModal}
              aria-label="Close"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <span className="mock-test__modal-icon" aria-hidden="true">
              <ClipboardCheck size={26} />
            </span>
            <h2 className="mock-test__modal-title" id={modalTitleId}>
              {pendingSubject.name}
            </h2>
            <p className="mock-test__modal-text">
              Do you want to take a mock test for this subject?
            </p>
            <div className="mock-test__modal-actions">
              <button
                type="button"
                className="mock-test__btn mock-test__btn--ghost"
                disabled={busy}
                onClick={closeModal}
              >
                No
              </button>
              <button
                type="button"
                className="mock-test__btn mock-test__btn--primary"
                disabled={busy}
                onClick={() => {
                  const backendId = pendingSubject.backendId;
                  setPendingSubject(null);
                  onSelectSubject(backendId);
                }}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

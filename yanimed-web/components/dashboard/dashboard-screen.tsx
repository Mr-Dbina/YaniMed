"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardCheck, MessagesSquare, X } from "lucide-react";
import { useSubjectsStore } from "@/lib/stores/subjects-store";
import { discardAttempt } from "@/lib/mock-test-api";
import {
  DashboardApiError,
  getDashboard,
  type DashboardBandLabel,
  type DashboardData,
  type DashboardFocusTopic,
  type DashboardRange,
  type DashboardUnfinished,
} from "@/lib/dashboard-api";
import { ConfirmDialog } from "@/components/mock-test/confirm-dialog";
import { DashboardHeatmap } from "@/components/dashboard/dashboard-heatmap";
import { DashboardUnfinishedTests } from "@/components/dashboard/dashboard-unfinished";
import { formatManilaShortDate } from "@/components/dashboard/format";

const RANGE_OPTIONS: { value: DashboardRange; label: string }[] = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "all", label: "All" },
];

const BANDS: Record<Exclude<DashboardBandLabel, "NO_DATA">, { text: string; bar: string; badge: string }> = {
  BAD: {
    text: "Bad",
    bar: "bg-[hsl(var(--destructive))]",
    badge: "bg-[hsl(var(--danger-soft))] text-[hsl(var(--foreground))]",
  },
  GOOD: {
    text: "Good",
    bar: "bg-[hsl(var(--amber))]",
    badge: "bg-[hsl(var(--amber-soft))] text-[hsl(var(--foreground))]",
  },
  EXCELLENT: {
    text: "Excellent",
    bar: "bg-[hsl(var(--success))]",
    badge: "bg-[hsl(var(--success-soft))] text-[hsl(var(--foreground))]",
  },
};

function band(label: DashboardBandLabel) {
  return label === "NO_DATA" ? null : BANDS[label];
}

const panel = "rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4";
const cardTitle = "m-0 text-[15px] font-semibold text-[hsl(var(--foreground))]";
const subtitle = "text-[13px] text-[hsl(var(--muted-foreground))]";
const subjectGrid =
  "mt-3 grid grid-cols-[minmax(0,1fr)_40px_72px] items-center gap-x-2.5 gap-y-1.5 sm:grid-cols-[90px_minmax(0,1fr)_40px_72px]";

function FocusChoiceDialog({
  topic,
  onClose,
  onOpenChat,
  onTakeMockTest,
}: {
  topic: DashboardFocusTopic;
  onClose: () => void;
  onOpenChat: () => void;
  onTakeMockTest: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>("button.choice-option")?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusables =
      panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])");
    if (!focusables || focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="subject-modal__overlay subject-modal__overlay--fixed focus-choice-overlay"
      onMouseDown={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="focus-choice"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onPanelKeyDown}
      >
        <button
          type="button"
          aria-label="Close"
          className="focus-choice__close"
          onClick={onClose}
        >
          <X size={20} strokeWidth={1.75} aria-hidden="true" />
        </button>

        <h2 id={titleId} className="focus-choice__title">
          What would you like to do?
        </h2>
        <p className="focus-choice__subtitle">
          Choose how you want to improve in this topic.
        </p>
        <p id={descriptionId} className="focus-choice__context sr-only">
          {topic.topicName} in {topic.subjectName}
        </p>

        <div className="focus-choice__options">
          <button
            type="button"
            className="choice-option"
            onClick={onTakeMockTest}
          >
            <span className="choice-icon">
              <ClipboardCheck size={22} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="focus-choice__option-body">
              <span className="focus-choice__option-label">Take a Mock Test</span>
              <span className="focus-choice__badge focus-choice__badge--mock">Practice</span>
              <span className="focus-choice__option-desc">
                Test your knowledge with practice questions based on your
                uploaded PDFs.
              </span>
            </span>
          </button>

          <button
            type="button"
            className="choice-option"
            onClick={onOpenChat}
          >
            <span className="choice-icon">
              <MessagesSquare size={22} strokeWidth={1.75} aria-hidden="true" />
            </span>
            <span className="focus-choice__option-body">
              <span className="focus-choice__option-label">Open Subject Chat</span>
              <span className="focus-choice__badge focus-choice__badge--chat">Study</span>
              <span className="focus-choice__option-desc">
                Review this topic, ask questions, and get explanations from
                your uploaded PDFs.
              </span>
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${panel} flex flex-col gap-1`}>
      <span className={subtitle}>{label}</span>
      <span className="text-[26px] font-medium leading-tight text-[hsl(var(--foreground))] tabular">{value}</span>
    </div>
  );
}

export function DashboardScreen() {
  const router = useRouter();
  const subjects = useSubjectsStore((state) => state.subjects);
  const setActiveSubject = useSubjectsStore((state) => state.setActiveSubject);

  const [range, setRange] = useState<DashboardRange>("all");
  const [retryToken, setRetryToken] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    data: DashboardData | null;
    error: string | null;
  } | null>(null);

  const requestKey = `${range}:${retryToken}`;
  const loading = result?.key !== requestKey;
  const rawData = result?.key === requestKey ? result.data : null;
  const mapSubjectName = (subjectId: string, fallback: string) => {
    const match = subjects.find(s => s.backendSubjectId === subjectId || s.id === subjectId);
    return match?.name ?? fallback;
  };
  const data = rawData ? {
    ...rawData,
    subjects: rawData.subjects.map(s => ({ ...s, name: mapSubjectName(s.subjectId, s.name) })),
    focusTopics: rawData.focusTopics.map(t => ({ ...t, subjectName: mapSubjectName(t.subjectId, t.subjectName) })),
    recentTests: rawData.recentTests.map(rt => ({ ...rt, subjectName: mapSubjectName(rt.subjectId, rt.subjectName) })),
    unfinished: rawData.unfinished.map(u => ({ ...u, subjectName: mapSubjectName(u.subjectId, u.subjectName) })),
  } : null;
  const error = result?.key === requestKey ? result.error : null;

  const [discardTarget, setDiscardTarget] = useState<DashboardUnfinished | null>(null);
  const [choiceTopic, setChoiceTopic] = useState<DashboardFocusTopic | null>(null);
  const choiceTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const [discardError, setDiscardError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;

    void getDashboard(range, controller.signal)
      .then((next) => {
        if (requestIdRef.current !== requestId) return;
        setResult({ key: requestKey, data: next, error: null });
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || requestIdRef.current !== requestId) return;
        setResult({
          key: requestKey,
          data: null,
          error:
            err instanceof DashboardApiError
              ? err.message
              : "Something went wrong while loading the dashboard.",
        });
      });

    return () => controller.abort();
  }, [range, requestKey, subjects]);

  const handleResume = (item: DashboardUnfinished) => {
    // Mock Test resumes the unfinished attempt of its active subject.
    const subject = subjects.find((candidate) => candidate.backendSubjectId === item.subjectId);
    if (subject) setActiveSubject(subject.id);
    router.push("/mock-test");
  };

  const handleConfirmDiscard = async () => {
    if (!discardTarget) return;
    setDiscardBusy(true);
    setDiscardError(null);
    try {
      await discardAttempt(discardTarget.attemptId);
      setDiscardTarget(null);
      setRetryToken((token) => token + 1);
    } catch (err) {
      setDiscardError(
        err instanceof Error ? err.message : "Could not discard this attempt. Please try again.",
      );
    } finally {
      setDiscardBusy(false);
    }
  };

  const closeChoice = () => {
    setChoiceTopic(null);
    requestAnimationFrame(() => choiceTriggerRef.current?.focus());
  };

  const openSubjectChat = () => {
    if (!choiceTopic) return;
    const subjectId = choiceTopic.subjectId;
    closeChoice();
    router.push(`/subjects/${subjectId}`);
  };

  const openMockTest = () => {
    if (!choiceTopic) return;
    const subjectId = choiceTopic.subjectId;
    closeChoice();
    router.push(`/mock-test?subjectId=${encodeURIComponent(subjectId)}`);
  };

  const empty = data !== null && data.totals.testsTaken === 0 && data.study.heatmap.length === 0;

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-3.5">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="m-0 text-2xl font-semibold text-[hsl(var(--foreground))]">Dashboard</h1>
          <p className={`m-0 mt-0.5 ${subtitle}`}>Your study progress and performance.</p>
        </div>

        <div
          role="group"
          aria-label="Dashboard range"
          className="inline-flex overflow-hidden rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))]"
        >
          {RANGE_OPTIONS.map((option) => {
            const active = range === option.value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setRange(option.value)}
                className={`px-3.5 py-1.5 text-[13px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[hsl(var(--ring))] ${
                  active
                    ? "bg-[hsl(var(--primary))] font-semibold text-[hsl(var(--primary-foreground))]"
                    : "text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--muted))] hover:text-[hsl(var(--foreground))]"
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </header>

      {loading && (
        <p role="status" className={`${panel} ${subtitle}`}>
          Loading your dashboard…
        </p>
      )}

      {!loading && error && (
        <div role="alert" className={panel}>
          <p className="m-0 text-[13px] text-[hsl(var(--destructive))]">{error}</p>
          <button
            type="button"
            className="mt-2.5 inline-flex items-center justify-center rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-4 py-2 text-[13px] font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
            onClick={() => setRetryToken((token) => token + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {data && empty && (
        <section className={`${panel} flex flex-col items-center gap-2 py-10 text-center`}>
          <h2 className={cardTitle}>Start your first mock test</h2>
          <p className={`m-0 ${subtitle}`}>Your progress will appear here after your first test.</p>
          <Link
            href="/mock-test"
            className="mt-1 inline-flex items-center justify-center rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-[13px] font-semibold text-[hsl(var(--primary-foreground))] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
          >
            Start a mock test
          </Link>
        </section>
      )}

      {data && !empty && (
        <>
          {data.unfinished.length > 0 && (
            <DashboardUnfinishedTests
              items={data.unfinished}
              busy={discardBusy}
              error={discardError}
              onResume={handleResume}
              onDiscard={(item) => {
                setDiscardError(null);
                setDiscardTarget(item);
              }}
            />
          )}

          <section aria-label="Study totals" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard
              label="Study streak"
              value={`${data.study.currentStreak} ${data.study.currentStreak === 1 ? "day" : "days"}`}
            />
            <StatCard label="Tests taken" value={String(data.totals.testsTaken)} />
            <StatCard label="Questions answered" value={String(data.totals.questionsAnswered)} />
          </section>

          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
            <section aria-labelledby="subject-performance" className={panel}>
              <h2 id="subject-performance" className={cardTitle}>
                Subject performance
              </h2>
              <p className={`m-0 mt-0.5 ${subtitle}`}>Your current performance across subjects</p>
              <div className="mt-1">
                {data.subjects.map((subject) => {
                  const info = band(subject.label);
                  if (!info) {
                    return (
                      <div
                        key={subject.subjectId}
                        className="mt-3 flex items-center justify-between gap-2"
                      >
                        <span className="min-w-0 truncate text-[13px] text-[hsl(var(--foreground))]">
                          {subject.name}
                        </span>
                        <span className={subtitle}>No tests yet</span>
                      </div>
                    );
                  }
                  const percent = Math.min(100, Math.max(0, subject.averagePercent ?? 0));
                  return (
                    <div key={subject.subjectId} className={subjectGrid}>
                      <span className="min-w-0 truncate text-[13px] text-[hsl(var(--foreground))]">
                        {subject.name}
                      </span>
                      <div
                        className="col-span-3 h-2 overflow-hidden rounded-full bg-[hsl(var(--muted))] sm:col-span-1"
                        role="progressbar"
                        aria-label={`${subject.name} average score`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(percent)}
                      >
                        <span
                          className={`block h-full rounded-full ${info.bar}`}
                          style={{ width: `${percent}%` }}
                        />
                      </div>
                      <span className="col-start-2 row-start-1 text-right text-[13px] text-[hsl(var(--foreground))] tabular sm:col-start-auto sm:row-start-auto">
                        {Math.round(percent)}%
                      </span>
                      <span
                        className={`col-start-3 row-start-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-center text-[11px] font-medium sm:col-start-auto sm:row-start-auto ${info.badge}`}
                      >
                        {info.text}
                      </span>
                    </div>
                  );
                })}
                {data.subjects.length === 0 && <p className={`m-0 mt-3 ${subtitle}`}>No subjects yet.</p>}
              </div>
            </section>

            <section aria-labelledby="focus-next" className={panel}>
              <h2 id="focus-next" className={cardTitle}>
                Focus next
              </h2>
              <p className={`m-0 mt-0.5 ${subtitle}`}>Topics you need to study more</p>
              <ul className="mt-1 flex list-none flex-col p-0">
                {data.focusTopics.map((topic) => (
                  <li key={topic.topicKey} className="mt-2.5">
                    <button
                      type="button"
                      aria-haspopup="dialog"
                      aria-label={`Study ${topic.topicName} in ${topic.subjectName}`}
                      className="focus-row flex w-full items-center justify-between gap-3 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-2.5 text-left font-[inherit] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
                      onClick={(event) => {
                        choiceTriggerRef.current = event.currentTarget;
                        setChoiceTopic(topic);
                      }}
                    >
                      <span className="min-w-0 truncate text-[13px] text-[hsl(var(--foreground))]">
                        {topic.topicName}
                      </span>
                      <span className="focus-subject flex-shrink-0 whitespace-nowrap text-xs text-[hsl(var(--muted-foreground))]">
                        {topic.subjectName}
                      </span>
                    </button>
                  </li>
                ))}
                {data.focusTopics.length === 0 && (
                  <li className={`mt-3 ${subtitle}`}>No weak topics yet.</li>
                )}
              </ul>
            </section>
          </div>

          <div className="grid gap-3.5 [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]">
            <section aria-labelledby="recent-tests" className={panel}>
              <h2 id="recent-tests" className={cardTitle}>
                Recent tests
              </h2>
              <ul className="mt-1 flex list-none flex-col p-0">
                {data.recentTests.map((test) => {
                  const info = band(test.label);
                  return (
                    <li
                      key={test.attemptId}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-[hsl(var(--border))] py-2.5 last:border-b-0 last:pb-0"
                    >
                      <span className="min-w-0 text-[13px] text-[hsl(var(--foreground))]">
                        {test.subjectName}{" "}
                        <span className="text-[hsl(var(--muted-foreground))] tabular">
                          · {formatManilaShortDate(test.completedAt)}
                        </span>
                      </span>
                      <span className="flex flex-wrap items-center gap-3">
                        <span
                          className={`rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular ${
                            info ? info.badge : "bg-[hsl(var(--muted))] text-[hsl(var(--foreground))]"
                          }`}
                        >
                          {Math.round(test.percent)}%{info ? ` · ${info.text}` : ""}
                        </span>
                        <Link
                          href="/mock-test"
                          aria-label={`View answers for ${test.subjectName}`}
                          className="whitespace-nowrap text-[13px] text-[hsl(var(--primary))] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
                        >
                          View answers 
                        </Link>
                      </span>
                    </li>
                  );
                })}
                {data.recentTests.length === 0 && <li className={`mt-3 ${subtitle}`}>No tests yet.</li>}
              </ul>
            </section>

            <section aria-labelledby="study-activity" className={panel}>
              <h2 id="study-activity" className={cardTitle}>
                Study activity
              </h2>
              <p className={`m-0 mt-0.5 ${subtitle}`}>Tests and chat questions per day</p>
              <DashboardHeatmap days={data.study.heatmap} generatedAt={data.generatedAt} />
            </section>
          </div>
        </>
      )}

      {choiceTopic && (
        <FocusChoiceDialog
          topic={choiceTopic}
          onClose={closeChoice}
          onOpenChat={openSubjectChat}
          onTakeMockTest={openMockTest}
        />
      )}

      <ConfirmDialog
        open={discardTarget !== null}
        title="Discard attempt"
        message="Discard this unfinished Mock Test? Its answers are abandoned and a new attempt can be started."
        confirmLabel="Discard"
        danger
        busy={discardBusy}
        onConfirm={() => void handleConfirmDiscard()}
        onCancel={() => setDiscardTarget(null)}
      />
    </div>
  );
}

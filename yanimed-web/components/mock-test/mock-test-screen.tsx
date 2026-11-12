"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useSubjectsStore } from "@/lib/stores/subjects-store";
import {
  MockTestApiError,
  answerQuestion,
  createAttempt,
  discardAttempt,
  getReview,
  getReviewNavigator,
  getSubjectOverview,
  skipQuestion,
  startAttempt,
  submitAttempt,
  type ExamResult,
  type ExamReview,
  type MockAttemptStatus,
  type MockQuestion,
  type NavigatorItem,
  type SubjectOverview,
} from "@/lib/mock-test-api";
import { ConfirmDialog } from "@/components/mock-test/confirm-dialog";
import { MockTestAnswers } from "@/components/mock-test/mock-test-answers";
import { MockTestQuestion } from "@/components/mock-test/mock-test-question";
import { MockTestResult } from "@/components/mock-test/mock-test-result";
import { MockTestReview } from "@/components/mock-test/mock-test-review";
import {
  MockTestStart,
  type SyncedSubjectOption,
} from "@/components/mock-test/mock-test-start";

type Phase = "start" | "question" | "review" | "result" | "answers";

interface PendingAnswer {
  position: number;
  choiceId: string;
  key: string;
}

function idempotencyKey(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function toApiError(error: unknown): MockTestApiError {
  return error instanceof MockTestApiError
    ? error
    : new MockTestApiError("Something went wrong. Please try again.");
}

function messageFor(error: MockTestApiError): string {
  switch (error.code) {
    case "SESSION_SUPERSEDED":
      return "This exam was opened in another window. Use this window to continue.";
    case "NOT_IN_PROGRESS":
      return "This exam is no longer accepting that action. Return to the overview and resume.";
    case "REVISION_CONFLICT":
      return "This question already has a saved answer. Choose the answer you saved before, or discard the attempt from the overview.";
    case "NOT_ALL_ANSWERED":
      return "Every question must be answered before submitting.";
    case "NOT_EDITABLE":
      return "This answer can no longer be changed.";
    case "ATTEMPT_EXISTS":
      return "An unfinished attempt already exists for this subject.";
    case "INSUFFICIENT_CONTENT": {
      const eligible = error.body?.eligible;
      const required = error.body?.required;
      return typeof eligible === "number" && typeof required === "number"
        ? `This subject has ${eligible} of ${required} eligible questions. Add PDFs, then try again.`
        : "This subject does not have enough eligible questions.";
    }
    case "ATTEMPT_NOT_FOUND":
      return "This attempt no longer exists.";
    case "SUBJECT_NOT_FOUND":
      return "Subject not found on the server.";
    case "INVALID_CHOICE":
      return "The selected choice is not valid for this question.";
    default:
      break;
  }
  if (error.status === 404 && !error.code) {
    return "Mock Test is not enabled on the server.";
  }
  return error.message;
}

/**
 * The subject is the session key: switching subjects remounts the runner, so
 * no attempt state from one subject can leak into another.
 */
export function MockTestScreen() {
  const hydrated = useSubjectsStore((state) => state.hydrated);
  const subjects = useSubjectsStore((state) => state.subjects);
  const activeSubjectId = useSubjectsStore((state) => state.activeSubjectId);
  const setActiveSubject = useSubjectsStore((state) => state.setActiveSubject);
  const [pendingStartSubject, setPendingStartSubject] = useState<string | null>(
    null,
  );
  const [startNonce, setStartNonce] = useState(0);
  const handlePendingStartConsumed = useCallback(() => {
    setPendingStartSubject(null);
  }, []);

  const activeSubject =
    subjects.find((subject) => subject.id === activeSubjectId) ?? null;
  const selectedSubjectId = activeSubject?.backendSubjectId ?? null;
  const syncedSubjects: SyncedSubjectOption[] = subjects.flatMap((subject) =>
    subject.backendSubjectId
      ? [
          {
            backendId: subject.backendSubjectId,
            name: subject.name,
            documentCount: subject.documentCount ?? 0,
          },
        ]
      : [],
  );

  if (!hydrated) {
    return (
      <div className="mock-test">
        <p role="status">Loading your subjects…</p>
      </div>
    );
  }

  return (
    <MockTestSession
      key={`${selectedSubjectId ?? "no-subject"}:${startNonce}`}
      subjectId={selectedSubjectId}
      subjectName={activeSubject?.name ?? ""}
      syncedSubjects={syncedSubjects}
      activeIsLocalOnly={Boolean(activeSubject && !activeSubject.backendSubjectId)}
      pendingStart={
        pendingStartSubject !== null && pendingStartSubject === selectedSubjectId
      }
      onPendingStartConsumed={handlePendingStartConsumed}
      onSelectSubject={(backendId) => {
        if (!backendId) return;
        const local = subjects.find(
          (subject) => subject.backendSubjectId === backendId,
        );
        if (local) setActiveSubject(local.id);
        setPendingStartSubject(backendId);
        setStartNonce((nonce) => nonce + 1);
      }}
    />
  );
}

interface MockTestSessionProps {
  subjectId: string | null;
  subjectName: string;
  syncedSubjects: SyncedSubjectOption[];
  activeIsLocalOnly: boolean;
  pendingStart: boolean;
  onPendingStartConsumed: () => void;
  onSelectSubject: (backendId: string | null) => void;
}

function MockTestSession({
  subjectId,
  subjectName,
  syncedSubjects,
  activeIsLocalOnly,
  pendingStart,
  onPendingStartConsumed,
  onSelectSubject,
}: MockTestSessionProps) {
  const [reloadToken, setReloadToken] = useState(0);
  const [overview, setOverview] = useState<SubjectOverview | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(subjectId !== null);
  const [overviewError, setOverviewError] = useState<MockTestApiError | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [phase, setPhase] = useState<Phase>("start");
  const [booting, setBooting] = useState(subjectId !== null);
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [sessionVersion, setSessionVersion] = useState<number | null>(null);
  const [question, setQuestion] = useState<MockQuestion | null>(null);
  /** Saved answers reported by the server, or null before the first response. */
  const [answeredCount, setAnsweredCount] = useState<number | null>(null);
  /** Position the server jumped back from, or null when moving forward. */
  const [returnedFromPosition, setReturnedFromPosition] = useState<number | null>(
    null,
  );
  const [navigator, setNavigator] = useState<NavigatorItem[] | null>(null);
  const [navigatorLoading, setNavigatorLoading] = useState(false);
  const [navigatorError, setNavigatorError] = useState<string | null>(null);
  const [result, setResult] = useState<ExamResult | null>(null);
  const [review, setReview] = useState<ExamReview | null>(null);
  const [superseded, setSuperseded] = useState(false);

  const [actionBusy, setActionBusy] = useState(false);
  const [pendingAnswer, setPendingAnswer] = useState<PendingAnswer | null>(null);
  const [saving, setSaving] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [questionError, setQuestionError] = useState<string | null>(null);

  const [savingPosition, setSavingPosition] = useState<number | null>(null);
  const [pendingEdit, setPendingEdit] = useState<PendingAnswer | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmSubmitOpen, setConfirmSubmitOpen] = useState(false);
  const [exitConfirmOpen, setExitConfirmOpen] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<string | null>(null);

  const [answersLoading, setAnswersLoading] = useState(false);
  const [answersError, setAnswersError] = useState<string | null>(null);

  const autoResumedRef = useRef(false);
  const epochRef = useRef(0);
  const bootRequestRef = useRef(0);
  const navigatorRequestRef = useRef(0);

  /** Fetches the neutral navigator; stale responses are ignored by request id. */
  const loadNavigator = useCallback(async (id: string, version: number) => {
    const requestId = ++navigatorRequestRef.current;
    setPhase("review");
    setNavigator(null);
    setNavigatorLoading(true);
    setNavigatorError(null);
    try {
      const nav = await getReviewNavigator(id, version);
      if (navigatorRequestRef.current !== requestId) return;
      setNavigator(nav.items);
    } catch (error) {
      if (navigatorRequestRef.current !== requestId) return;
      const api = toApiError(error);
      if (api.code === "SESSION_SUPERSEDED") setSuperseded(true);
      setNavigatorError(messageFor(api));
    } finally {
      if (navigatorRequestRef.current === requestId) setNavigatorLoading(false);
    }
  }, []);

  const beginAttempt = useCallback(
    async (
      id: string,
      statusHint?: MockAttemptStatus,
      shouldApply: () => boolean = () => true,
    ) => {
      const started = await startAttempt(id);
      if (!shouldApply()) return;
      autoResumedRef.current = true;
      setAttemptId(id);
      setSessionVersion(started.sessionVersion);
      setQuestion(started.question);
      setReturnedFromPosition(null);
      setAnsweredCount(null);
      setNavigator(null);
      setNavigatorError(null);
      setSuperseded(false);
      setQuestionError(null);
      setReviewError(null);
      setPendingAnswer(null);
      setPendingEdit(null);

      if (statusHint === "AWAITING_SUBMISSION") {
        await loadNavigator(id, started.sessionVersion);
        return;
      }
      if (statusHint) {
        setPhase("question");
        return;
      }
      try {
        const nav = await getReviewNavigator(id, started.sessionVersion);
        if (!shouldApply()) return;
        setNavigator(nav.items);
        setPhase("review");
      } catch (error) {
        if (error instanceof MockTestApiError && error.code === "NOT_IN_PROGRESS") {
          if (shouldApply()) setPhase("question");
          return;
        }
        throw error;
      }
    },
    [loadNavigator],
  );

  const resetExam = useCallback(() => {
    epochRef.current += 1;
    setAttemptId(null);
    setSessionVersion(null);
    setQuestion(null);
    setReturnedFromPosition(null);
    setAnsweredCount(null);
    navigatorRequestRef.current += 1;
    setNavigator(null);
    setNavigatorLoading(false);
    setNavigatorError(null);
    setResult(null);
    setReview(null);
    setSuperseded(false);
    setPendingAnswer(null);
    setPendingEdit(null);
    setSavingPosition(null);
    setSaving(false);
    setSkipping(false);
    setSubmitting(false);
    setConfirmSubmitOpen(false);
    setExitConfirmOpen(false);
    setDiscardTarget(null);
    setQuestionError(null);
    setReviewError(null);
    setAnswersError(null);
  }, []);

  const refreshOverview = useCallback(() => {
    setOverviewLoading(true);
    setOverviewError(null);
    setActionError(null);
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    if (!subjectId) return undefined;
    const requestId = ++bootRequestRef.current;
    let cancelled = false;
    const applies = () => !cancelled && bootRequestRef.current === requestId;

    void (async () => {
      try {
        const data = await getSubjectOverview(subjectId);
        if (!applies()) return;
        setOverview(data);
        setOverviewLoading(false);

        const unfinished = data.unfinishedAttempt;
        const canAutoResume =
          unfinished !== null &&
          !autoResumedRef.current &&
          (unfinished.status === "READY" ||
            unfinished.status === "IN_PROGRESS" ||
            unfinished.status === "AWAITING_SUBMISSION");

        if (!canAutoResume || !unfinished) {
          if (pendingStart) {
            if (data.eligibleQuestionCount >= data.questionsPerTest) {
              try {
                const created = await createAttempt(subjectId);
                if (!applies()) return;
                await beginAttempt(created.attemptId, "READY", applies);
              } catch (error) {
                if (!applies()) return;
                const api = toApiError(error);
                if (api.code === "ATTEMPT_EXISTS" && api.body?.attemptId) {
                  try {
                    await beginAttempt(api.body.attemptId, undefined, applies);
                  } catch (inner) {
                    if (!applies()) return;
                    const innerApi = toApiError(inner);
                    if (innerApi.code === "SESSION_SUPERSEDED") setSuperseded(true);
                    else setActionError(messageFor(innerApi));
                  }
                } else if (api.code === "SESSION_SUPERSEDED") {
                  setSuperseded(true);
                } else {
                  setActionError(messageFor(api));
                }
              }
            }
            if (!applies()) return;
            onPendingStartConsumed();
          }
          if (applies()) setBooting(false);
          return;
        }

        autoResumedRef.current = true;
        setBooting(true);
        try {
          await beginAttempt(unfinished.id, unfinished.status, applies);
          if (!applies()) return;
          setBooting(false);
        } catch (error) {
          if (!applies()) return;
          // Let the Retry button try the resume again.
          autoResumedRef.current = false;
          setOverviewError(toApiError(error));
          setBooting(false);
          setPhase("start");
        }
      } catch (error) {
        if (!applies()) return;
        setOverviewError(toApiError(error));
        setOverviewLoading(false);
        setBooting(false);
        setPhase("start");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subjectId, reloadToken, beginAttempt, pendingStart, onPendingStartConsumed]);

  const handleStart = async () => {
    if (!subjectId) return;
    setActionBusy(true);
    setActionError(null);
    setAnswersError(null);
    try {
      const created = await createAttempt(subjectId);
      await beginAttempt(created.attemptId, "READY");
    } catch (error) {
      const api = toApiError(error);
      if (api.code === "ATTEMPT_EXISTS" && api.body?.attemptId) {
        try {
          await beginAttempt(api.body.attemptId);
        } catch (inner) {
          const innerApi = toApiError(inner);
          if (innerApi.code === "SESSION_SUPERSEDED") setSuperseded(true);
          else {
            setActionError(messageFor(innerApi));
            setAnswersError(messageFor(innerApi));
          }
        }
      } else if (api.code === "SESSION_SUPERSEDED") {
        setSuperseded(true);
      } else {
        setActionError(messageFor(api));
        setAnswersError(messageFor(api));
      }
    } finally {
      setActionBusy(false);
    }
  };

  const handleResume = async (id: string) => {
    setActionBusy(true);
    setActionError(null);
    try {
      await beginAttempt(id, overview?.unfinishedAttempt?.status);
    } catch (error) {
      const api = toApiError(error);
      if (api.code === "SESSION_SUPERSEDED") setSuperseded(true);
      else setActionError(messageFor(api));
    } finally {
      setActionBusy(false);
    }
  };

  const handleConfirmDiscard = async () => {
    if (!discardTarget) return;
    setActionBusy(true);
    setActionError(null);
    try {
      await discardAttempt(discardTarget);
      setDiscardTarget(null);
      resetExam();
      setPhase("start");
      setOverviewLoading(true);
      setOverviewError(null);
      setReloadToken((token) => token + 1);
    } catch (error) {
      const api = toApiError(error);
      if (api.code === "SESSION_SUPERSEDED") setSuperseded(true);
      else setActionError(messageFor(api));
      setDiscardTarget(null);
    } finally {
      setActionBusy(false);
    }
  };

  const saveAnswer = async (position: number, choiceId: string, key: string) => {
    if (!attemptId || sessionVersion === null) return;
    const epoch = epochRef.current;
    setSaving(true);
    setQuestionError(null);
    setPendingAnswer({ position, choiceId, key });
    try {
      const progress = await answerQuestion(attemptId, {
        sessionVersion,
        position,
        choiceId,
        idempotencyKey: key,
      });
      if (epochRef.current !== epoch) return;
      setPendingAnswer(null);
      setAnsweredCount(progress.answeredCount);
      // The server owns navigation: render its question whatever the position.
      if (progress.status === "AWAITING_SUBMISSION") {
        setReturnedFromPosition(null);
        await loadNavigator(attemptId, sessionVersion);
      } else if (progress.nextQuestion) {
        const next = progress.nextQuestion;
        const returned = next.position <= position;
        setReturnedFromPosition(returned ? position : null);
        setQuestion(next);
      } else {
        setQuestionError(
          "The server did not return the next question. Exit the test and resume it.",
        );
      }
    } catch (error) {
      const api = toApiError(error);
      if (epochRef.current !== epoch) return;
      if (api.code === "SESSION_SUPERSEDED") {
        setSuperseded(true);
        setPendingAnswer(null);
      } else {
        setQuestionError(messageFor(api));
      }
    } finally {
      setSaving(false);
    }
  };

  const handleAnswer = (choiceId: string) => {
    if (!question) return;
    const key =
      pendingAnswer &&
      pendingAnswer.position === question.position &&
      pendingAnswer.choiceId === choiceId
        ? pendingAnswer.key
        : idempotencyKey();
    void saveAnswer(question.position, choiceId, key);
  };

  const handleRetryAnswer = () => {
    if (!pendingAnswer || !question) return;
    if (pendingAnswer.position !== question.position) return;
    void saveAnswer(
      pendingAnswer.position,
      pendingAnswer.choiceId,
      pendingAnswer.key,
    );
  };

  const handleSkip = async () => {
    if (!attemptId || sessionVersion === null || !question) return;
    const position = question.position;
    const epoch = epochRef.current;
    setSkipping(true);
    setQuestionError(null);
    try {
      const progress = await skipQuestion(attemptId, {
        sessionVersion,
        position,
      });
      if (epochRef.current !== epoch) return;
      setAnsweredCount(progress.answeredCount);
      // The server owns navigation: render its question whatever the position.
      if (progress.status === "AWAITING_SUBMISSION") {
        setReturnedFromPosition(null);
        await loadNavigator(attemptId, sessionVersion);
      } else if (progress.nextQuestion) {
        const next = progress.nextQuestion;
        const returned = next.position <= position;
        setReturnedFromPosition(returned ? position : null);
        setQuestion(next);
      } else {
        setQuestionError(
          "The server did not return the next question. Exit the test and resume it.",
        );
      }
    } catch (error) {
      const api = toApiError(error);
      if (epochRef.current !== epoch) return;
      if (api.code === "SESSION_SUPERSEDED") {
        setSuperseded(true);
      } else if (api.code === "SKIP_NOT_ALLOWED") {
        // Harmless fallback: the server refused this one skip. Skip stays available.
        setQuestionError(api.message);
      } else {
        setQuestionError(messageFor(api));
      }
    } finally {
      setSkipping(false);
    }
  };

  const saveEdit = async (position: number, choiceId: string, key: string) => {
    if (!attemptId || sessionVersion === null) return;
    const epoch = epochRef.current;
    setSavingPosition(position);
    setReviewError(null);
    setPendingEdit({ position, choiceId, key });
    try {
      await answerQuestion(attemptId, {
        sessionVersion,
        position,
        choiceId,
        idempotencyKey: key,
      });
      if (epochRef.current !== epoch) return;
      setPendingEdit(null);
      setNavigator((current) =>
        current
          ? current.map((item) =>
              item.position === position
                ? { ...item, answered: true, selectedChoiceId: choiceId }
                : item,
            )
          : current,
      );
    } catch (error) {
      const api = toApiError(error);
      if (epochRef.current !== epoch) return;
      if (api.code === "SESSION_SUPERSEDED") {
        setSuperseded(true);
        setPendingEdit(null);
      } else {
        setReviewError(messageFor(api));
      }
    } finally {
      setSavingPosition(null);
    }
  };

  const handleEdit = (position: number, choiceId: string) => {
    const key =
      pendingEdit &&
      pendingEdit.position === position &&
      pendingEdit.choiceId === choiceId
        ? pendingEdit.key
        : idempotencyKey();
    void saveEdit(position, choiceId, key);
  };

  const handleRetryEdit = () => {
    if (!pendingEdit) return;
    void saveEdit(pendingEdit.position, pendingEdit.choiceId, pendingEdit.key);
  };

  const handleSubmit = async () => {
    if (!attemptId || sessionVersion === null) return;
    setSubmitting(true);
    setReviewError(null);
    try {
      const data = await submitAttempt(attemptId, {
        sessionVersion,
        idempotencyKey: idempotencyKey(),
      });
      setResult(data);
      setConfirmSubmitOpen(false);
      setPhase("result");
    } catch (error) {
      const api = toApiError(error);
      setConfirmSubmitOpen(false);
      if (api.code === "SESSION_SUPERSEDED") setSuperseded(true);
      else setReviewError(messageFor(api));
    } finally {
      setSubmitting(false);
    }
  };

  const handleViewAnswers = async () => {
    if (!attemptId) return;
    setAnswersLoading(true);
    setAnswersError(null);
    try {
      const data = await getReview(attemptId);
      setReview(data);
      setPhase("answers");
    } catch (error) {
      setAnswersError(messageFor(toApiError(error)));
    } finally {
      setAnswersLoading(false);
    }
  };

  const handleDone = () => {
    resetExam();
    setPhase("start");
    refreshOverview();
  };

  const handleExit = () => {
    setExitConfirmOpen(true);
  };

  const handleExitConfirmed = () => {
    setExitConfirmOpen(false);
    resetExam();
    setPhase("start");
    refreshOverview();
  };

  const handleUseThisWindow = async () => {
    if (!attemptId) return;
    setActionBusy(true);
    setQuestionError(null);
    setReviewError(null);
    try {
      const started = await startAttempt(attemptId);
      setSessionVersion(started.sessionVersion);
      setSuperseded(false);
      setQuestion(started.question);
      setReturnedFromPosition(null);
      setPendingAnswer(null);
      setPendingEdit(null);
      if (phase === "review") {
        await loadNavigator(attemptId, started.sessionVersion);
      } else {
        setPhase("question");
      }
    } catch (error) {
      const api = toApiError(error);
      setSuperseded(false);
      if (phase === "review") setReviewError(messageFor(api));
      else setQuestionError(messageFor(api));
    } finally {
      setActionBusy(false);
    }
  };

  const handleRetryReview = () => {
    if (!attemptId || sessionVersion === null) return;
    void loadNavigator(attemptId, sessionVersion);
  };

  if (booting) {
    return (
      <div className="mock-test-screen">
        <div className="mock-test">
          <p role="status">Loading your test…</p>
        </div>
      </div>
    );
  }

  let body: ReactNode;
  if (phase === "question" && question) {
    body = (
      <MockTestQuestion
        key={question.position}
        question={question}
        subjectName={subjectName}
        answeredCount={answeredCount}
        busy={saving || skipping}
        savingLabel={saving ? "Saving answer…" : skipping ? "Skipping…" : null}
        retryAvailable={
          pendingAnswer !== null && pendingAnswer.position === question.position
        }
        returnedToSkipped={returnedFromPosition !== null}
        error={questionError}
        readOnly={superseded}
        onAnswer={handleAnswer}
        onRetryAnswer={handleRetryAnswer}
        onSkip={() => void handleSkip()}
        onExit={handleExit}
      />
    );
  } else if (phase === "review") {
    body = (
      <MockTestReview
        items={navigator}
        loading={navigatorLoading}
        loadError={navigatorError}
        savingPosition={savingPosition}
        pendingEdit={pendingEdit}
        submitting={submitting}
        error={reviewError}
        readOnly={superseded}
        onEdit={handleEdit}
        onRetry={handleRetryReview}
        onRetryEdit={handleRetryEdit}
        onRequestSubmit={() => setConfirmSubmitOpen(true)}
        onExit={handleExit}
      />
    );
  } else if (phase === "result" && result) {
    body = (
      <MockTestResult
        result={result}
        subjectName={subjectName}
        onRetry={() => void handleStart()}
        onViewAnswers={() => void handleViewAnswers()}
        onDone={handleDone}
        retrying={actionBusy}
        loadingAnswers={answersLoading}
        error={answersError}
      />
    );
  } else if (phase === "answers" && review) {
    body = (
      <MockTestAnswers review={review} onBack={() => setPhase("result")} />
    );
  } else {
    body = (
      <MockTestStart
        syncedSubjects={syncedSubjects}
        selectedSubjectId={subjectId}
        activeIsLocalOnly={activeIsLocalOnly}
        onSelectSubject={onSelectSubject}
        overview={overview}
        loading={overviewLoading}
        error={overviewError}
        actionError={actionError}
        busy={actionBusy}
        onRetryOverview={refreshOverview}
        onStart={() => void handleStart()}
        onResume={(id) => void handleResume(id)}
        onRequestDiscard={setDiscardTarget}
      />
    );
  }

  return (
    <div className="mock-test-screen">
      {superseded && (
        <div className="mock-test__superseded" role="alert">
          <div>
            <strong>This exam was opened in another window.</strong>
            <p className="mock-test__muted">
              This window is read-only until you take over.
            </p>
          </div>
          <button
            type="button"
            className="mock-test__btn mock-test__btn--primary"
            disabled={actionBusy}
            onClick={() => void handleUseThisWindow()}
          >
            {actionBusy ? "Taking over…" : "Use this window"}
          </button>
        </div>
      )}

      {body}

      <ConfirmDialog
        open={discardTarget !== null}
        title="Discard attempt"
        message="Discard this unfinished Mock Test? Its answers are abandoned and a new attempt can be started."
        confirmLabel="Discard"
        danger
        busy={actionBusy}
        onConfirm={() => void handleConfirmDiscard()}
        onCancel={() => setDiscardTarget(null)}
      />

      <ConfirmDialog
        open={confirmSubmitOpen}
        title="Submit test"
        message="Submit your answers? You cannot change them after submitting."
        confirmLabel="Submit"
        busy={submitting}
        onConfirm={() => void handleSubmit()}
        onCancel={() => setConfirmSubmitOpen(false)}
      />

      <ConfirmDialog
        open={exitConfirmOpen}
        title="Exit test"
        message="Leave this test? Your answers are saved and the test can be resumed from the overview."
        confirmLabel="Exit test"
        cancelLabel="Stay"
        onConfirm={handleExitConfirmed}
        onCancel={() => setExitConfirmOpen(false)}
      />
    </div>
  );
}

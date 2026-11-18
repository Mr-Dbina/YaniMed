"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, X } from "lucide-react";
import type { ExamReview, ReviewQuestion } from "@/lib/mock-test-api";

type OutcomeFilter = "all" | "correct" | "incorrect";
type PanelTab = "explanation" | "citation";

interface MockTestAnswersProps {
  review: ExamReview;
  subjectName: string;
  onBack: () => void;
}

function humanizeTopic(topicKey: string): string {
  return topicKey
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function questionMatches(
  question: ReviewQuestion,
  outcome: OutcomeFilter,
  topic: string,
): boolean {
  if (outcome === "correct" && !question.isCorrect) return false;
  if (outcome === "incorrect" && question.isCorrect) return false;
  if (topic !== "all" && question.topicName !== topic) return false;
  return true;
}

interface TopicSelectProps {
  value: string;
  options: string[];
  onChange: (value: string) => void;
}

/** Topic filter using the same listbox pattern as LanguageSelect. */
function TopicSelect({ value, options, onChange }: TopicSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const entries = [
    { key: "all", label: "All Topics" },
    ...options.map((name) => ({ key: name, label: humanizeTopic(name) })),
  ];
  const selectedIndex = entries.findIndex((entry) => entry.key === value);
  const selectedLabel =
    selectedIndex >= 0 ? entries[selectedIndex].label : entries[0].label;

  useEffect(() => {
    if (!open) return undefined;

    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (open) {
      setOpen(false);
      return;
    }
    // Seed the highlight from the current value here rather than in an effect,
    // which would cascade renders.
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  };

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      const next = (activeIndex + 1) % entries.length;
      setActiveIndex(next);
      optionRefs.current[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      const next = (activeIndex - 1 + entries.length) % entries.length;
      setActiveIndex(next);
      optionRefs.current[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = entries[activeIndex];
      if (picked) choose(picked.key);
    }
  };

  return (
    <div className="mock-test__topic" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="lang-select__trigger"
        aria-label="Topic"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={toggle}
      >
        {selectedLabel}
        <svg
          viewBox="0 0 24 24"
          width="15"
          height="15"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open ? (
        <div className="lang-select__panel">
          <div role="listbox" aria-label="Topic" className="lang-select__list">
            {entries.map((entry, index) => (
              <button
                key={entry.key}
                type="button"
                role="option"
                aria-selected={entry.key === value}
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                className={`lang-select__option${
                  index === activeIndex ? " lang-select__option--active" : ""
                }`}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(entry.key)}
              >
                {entry.label}
                {entry.key === value ? (
                  <Check size={15} strokeWidth={1.9} aria-hidden="true" />
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function MockTestAnswers({
  review,
  subjectName,
  onBack,
}: MockTestAnswersProps) {
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [topic, setTopic] = useState("all");
  const [activePosition, setActivePosition] = useState<number | null>(null);
  const [tab, setTab] = useState<PanelTab>("explanation");

  const topics = Array.from(
    new Set(review.questions.map((question) => question.topicName)),
  ).sort((a, b) => a.localeCompare(b));
  const filtered = review.questions.filter((question) =>
    questionMatches(question, outcome, topic),
  );
  const current =
    filtered.find((question) => question.position === activePosition) ??
    filtered[0] ??
    null;
  const index = current
    ? filtered.findIndex((question) => question.position === current.position)
    : -1;

  const counts = {
    all: review.questions.length,
    correct: review.questions.filter((question) => question.isCorrect).length,
    incorrect: review.questions.filter((question) => !question.isCorrect).length,
  };

  const correctChoice = current?.choices.find((choice) => choice.isCorrect) ?? null;

  return (
    <section
      className="mock-test mock-test--wide"
      aria-labelledby="mock-test-answers-heading"
    >
      <header className="mock-test__answers-top">
        <button type="button" className="mock-test__link" onClick={onBack}>
          <ArrowLeft size={16} aria-hidden="true" /> Back to Results
        </button>
        <h1 id="mock-test-answers-heading" className="mock-test__legend">
          Answer review
        </h1>
      </header>

      <div className="mock-test__answers-toolbar">
        <div className="mock-test__pills" role="group" aria-label="Filter by result">
          {(["all", "correct", "incorrect"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`mock-test__pill${
                outcome === value ? " mock-test__pill--active" : ""
              }`}
              aria-pressed={outcome === value}
              onClick={() => {
                setOutcome(value);
                setActivePosition(null);
              }}
            >
              {value === "all"
                ? `All (${counts.all})`
                : value === "correct"
                  ? `Correct (${counts.correct})`
                  : `Incorrect (${counts.incorrect})`}
            </button>
          ))}
        </div>

        <div className="mock-test__field">
          <span className="mock-test__legend">Topic</span>
          <TopicSelect
            value={topic}
            options={topics}
            onChange={(next) => {
              setTopic(next);
              setActivePosition(null);
            }}
          />
        </div>
      </div>

      <div className="mock-test__review-layout">
        <div className="mock-test__card mock-test__review-nav">
          <div
            className="mock-test__review-grid"
            role="group"
            aria-label="Question navigator"
          >
            {filtered.map((question) => (
              <button
                key={question.position}
                type="button"
                className={`mock-test__review-item ${
                  question.isCorrect
                    ? "mock-test__review-item--correct"
                    : "mock-test__review-item--incorrect"
                }${
                  question.position === current?.position
                    ? " mock-test__review-item--active"
                    : ""
                }`}
                aria-current={
                  question.position === current?.position ? "true" : undefined
                }
                aria-label={`Question ${question.position}, ${
                  question.isCorrect ? "correct" : "incorrect"
                }`}
                onClick={() => setActivePosition(question.position)}
              >
                {question.position}
              </button>
            ))}
          </div>

          <p className="mock-test__muted" role="status">
            Showing {filtered.length} of {review.questions.length} questions.
          </p>
        </div>

        <div className="mock-test__card mock-test__question-panel">
          {!current ? (
            <p className="mock-test__muted">No questions match these filters.</p>
          ) : (
            <>
              <div className="mock-test__question-head">
                <h2 className="mock-test__heading">
                  Question {current.position}
                </h2>
                <span
                  className={`mock-test__badge ${
                    current.isCorrect
                      ? "mock-test__badge--correct"
                      : "mock-test__badge--incorrect"
                  }`}
                >
                  {current.isCorrect ? (
                    <Check size={14} aria-hidden="true" />
                  ) : (
                    <X size={14} aria-hidden="true" />
                  )}
                  {current.isCorrect ? "Correct" : "Incorrect"}
                </span>
                {current.underReview && (
                  <span className="mock-test__badge mock-test__badge--warning">
                    Under review
                  </span>
                )}
              </div>

              <span className="mock-test__badge">
                {humanizeTopic(current.topicName)}
              </span>

              <p className="mock-test__stem">{current.stem}</p>
              {current.leadIn && (
                <p className="mock-test__lead-in">{current.leadIn}</p>
              )}

              <ul className="mock-test__choices">
                {current.choices.map((choice) => {
                  const selected = current.selectedChoiceId === choice.id;
                  const classes = [
                    "mock-test__choice",
                    choice.isCorrect ? "mock-test__choice--correct" : "",
                    selected && !choice.isCorrect
                      ? "mock-test__choice--wrong"
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <li key={choice.id} className={classes}>
                      <span className="mock-test__radio" aria-hidden="true" />
                      <span className="mock-test__choice-text">
                        <span className="mock-test__choice-label">
                          {choice.letter}.
                        </span>{" "}
                        {choice.text}
                      </span>
                      {choice.isCorrect ? (
                        <span className="mock-test__choice-mark">
                          <Check size={16} aria-hidden="true" />
                          <span className="mock-test__legend">
                            Correct answer
                          </span>
                        </span>
                      ) : selected ? (
                        <span className="mock-test__choice-mark">
                          <X size={16} aria-hidden="true" />
                          <span className="mock-test__legend">
                            Your answer, incorrect
                          </span>
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        <div className="mock-test__card mock-test__panel">
          {current && (
            <>
              <div className="mock-test__question-tabs" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "explanation"}
                  className={`mock-test__tab${
                    tab === "explanation" ? " mock-test__tab--active" : ""
                  }`}
                  onClick={() => setTab("explanation")}
                >
                  Explanation
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "citation"}
                  className={`mock-test__tab${
                    tab === "citation" ? " mock-test__tab--active" : ""
                  }`}
                  onClick={() => setTab("citation")}
                >
                  Citation
                </button>
              </div>

              <div className="mock-test__panel-body">
                {tab === "explanation" ? (
                  <div role="tabpanel">
                    <p className="mock-test__correct-answer">
                      <strong>Correct Answer:</strong>{" "}
                      {correctChoice
                        ? `${correctChoice.letter}. ${correctChoice.text}`
                        : "Not available."}
                    </p>
                    <div className="mock-test__rationale-list">
                      {current.choices.map((choice) => (
                        <div key={choice.id} className="mock-test__rationale">
                          <p className="mock-test__rationale-choice">
                            <strong>{choice.letter}.</strong> {choice.text}
                          </p>
                          <p className="mock-test__muted">
                            {choice.explanation || "No rationale provided."}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div role="tabpanel">
                    <p className="mock-test__panel-subject">
                      {subjectName || "Mock Test"}
                    </p>
                    {current.citations.length > 0 ? (
                      <div className="mock-test__topic-list">
                        {current.citations.map((citation, citationIndex) => (
                          <div
                            key={`${citation.documentTitleSnapshot}-${citation.pageNumber}-${citationIndex}`}
                            className="mock-test__citation-card"
                          >
                            <p>
                              <strong>{citation.documentTitleSnapshot}</strong>
                            </p>
                            <p className="mock-test__muted">
                              Page {citation.pageNumber}
                            </p>
                            {citation.quote && (
                              <blockquote className="mock-test__quote">
                                {citation.quote}
                              </blockquote>
                            )}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="mock-test__muted">
                        No citation was saved for this question.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="mock-test__panel-actions">
                <button
                  type="button"
                  className="mock-test__btn mock-test__btn--ghost"
                  disabled={index <= 0}
                  onClick={() =>
                    index > 0 && setActivePosition(filtered[index - 1].position)
                  }
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="mock-test__btn mock-test__btn--ghost"
                  disabled={index < 0 || index >= filtered.length - 1}
                  onClick={() =>
                    index >= 0 &&
                    index < filtered.length - 1 &&
                    setActivePosition(filtered[index + 1].position)
                  }
                >
                  Next
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

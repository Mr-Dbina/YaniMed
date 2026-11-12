"use client";

import { useState } from "react";
import { ArrowLeft, Check, X } from "lucide-react";
import type { ExamReview, ReviewQuestion } from "@/lib/mock-test-api";

type OutcomeFilter = "all" | "correct" | "incorrect";
type PanelTab = "explanation" | "citation";

interface MockTestAnswersProps {
  review: ExamReview;
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

export function MockTestAnswers({ review, onBack }: MockTestAnswersProps) {
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
  const explanations =
    current?.choices.filter((choice) => choice.explanation) ?? [];

  return (
    <section className="mock-test" aria-labelledby="mock-test-answers-heading">
      <header className="mock-test__top">
        <div>
          <button type="button" className="mock-test__link" onClick={onBack}>
            <ArrowLeft size={16} aria-hidden="true" /> Back to Results
          </button>
          <h1 className="mock-test__title" id="mock-test-answers-heading">
            Answer review
          </h1>
          <p className="mock-test__muted">
            {review.score} / {review.total} correct. Review only; the stored
            score does not change.
          </p>
        </div>
      </header>

      <div className="mock-test__review-layout">
        <div className="mock-test__card mock-test__review-nav">
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

          <label className="mock-test__field" htmlFor="mock-test-topic-filter">
            <span className="mock-test__label">Topic</span>
            <select
              id="mock-test-topic-filter"
              className="mock-test__select"
              value={topic}
              onChange={(event) => {
                setTopic(event.target.value);
                setActivePosition(null);
              }}
            >
              <option value="all">All topics</option>
              {topics.map((name) => (
                <option key={name} value={name}>
                  {humanizeTopic(name)}
                </option>
              ))}
            </select>
          </label>

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
                      <span
                        className="mock-test__choice-letter"
                        aria-hidden="true"
                      >
                        {choice.letter}
                      </span>
                      <span className="mock-test__choice-text">
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

              {tab === "explanation" ? (
                <div role="tabpanel">
                  <p className="mock-test__muted">
                    <strong>Correct answer:</strong>{" "}
                    {correctChoice
                      ? `${correctChoice.letter}. ${correctChoice.text}`
                      : "Not available."}
                  </p>
                  {explanations.length > 0 ? (
                    <div className="mock-test__topic-list">
                      {explanations.map((choice) => (
                        <p
                          key={choice.id}
                          className="mock-test__explanation"
                        >
                          <strong>{choice.letter}.</strong> {choice.explanation}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="mock-test__muted">
                      No explanation was generated for this question.
                    </p>
                  )}
                </div>
              ) : (
                <div role="tabpanel">
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

              <div className="mock-test__actions">
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

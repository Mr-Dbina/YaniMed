"use client";

import { Trophy } from "lucide-react";
import type { ExamResult } from "@/lib/mock-test-api";
import { StudyAidNotice } from "@/components/mock-test/study-aid-notice";

interface MockTestResultProps {
  result: ExamResult;
  subjectName: string;
  onRetry: () => void;
  onViewAnswers: () => void;
  onDone: () => void;
  retrying: boolean;
  loadingAnswers: boolean;
  error: string | null;
}

/** "medication-safety" -> "Medication Safety". */
function humanizeTopic(topicKey: string): string {
  return topicKey
    .replace(/[-_]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function topicPercentage(correct: number, total: number): number {
  return total === 0 ? 0 : Math.round((correct / total) * 100);
}

export function MockTestResult({
  result,
  subjectName,
  onRetry,
  onViewAnswers,
  onDone,
  retrying,
  loadingAnswers,
  error,
}: MockTestResultProps) {
  return (
    <section className="mock-test" aria-labelledby="mock-test-result-heading">
      <div className="mock-test__result-hero">
        <span className="mock-test__trophy" aria-hidden="true">
          <Trophy size={36} />
        </span>
        <h1 className="mock-test__result-title" id="mock-test-result-heading">
          Mock Test Completed
        </h1>
        <p className="mock-test__result-subject">
          {subjectName || "Mock Test"}
        </p>
        <p className="mock-test__scoreline">
          <span className="mock-test__score">{result.score}</span> /{" "}
          {result.total}
        </p>
      </div>

      <StudyAidNotice />

      <div className="mock-test__result-stats">
        <div className="mock-test__metric">
          <span className="mock-test__metric-value">{result.percentage}%</span>
          <span className="mock-test__metric-label">Score</span>
        </div>
        <div className="mock-test__metric">
          <span className="mock-test__metric-value">{result.correctCount}</span>
          <span className="mock-test__metric-label">Correct</span>
        </div>
        <div className="mock-test__metric">
          <span className="mock-test__metric-value">{result.incorrectCount}</span>
          <span className="mock-test__metric-label">Incorrect</span>
        </div>
      </div>

      <div className="mock-test__card">
        <h2 className="mock-test__heading">Topic performance</h2>
        {result.perTopic.length === 0 ? (
          <p className="mock-test__muted">No topic breakdown available.</p>
        ) : (
          <div className="mock-test__topic-list">
            {result.perTopic.map((topic) => {
              const percent = topicPercentage(topic.correct, topic.total);
              return (
                <div className="mock-test__topic" key={topic.topicKey}>
                  <div className="mock-test__topic-head">
                    <span>{humanizeTopic(topic.topicKey)}</span>
                    <span className="mock-test__topic-meta">
                      {percent}%{" "}
                      <span>
                        ({topic.correct}/{topic.total})
                      </span>
                    </span>
                  </div>
                  <div className="mock-test__topic-bar">
                    <div
                      className="mock-test__topic-fill"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="mock-test__error">
          {error}
        </p>
      )}

      <div className="mock-test__result-actions">
        <button
          type="button"
          className="mock-test__btn mock-test__btn--primary"
          disabled={retrying}
          onClick={onRetry}
        >
          {retrying ? "Starting…" : "Retry"}
        </button>
        <button
          type="button"
          className="mock-test__btn mock-test__btn--ghost"
          disabled={loadingAnswers}
          onClick={onViewAnswers}
        >
          {loadingAnswers ? "Loading answers…" : "View Answers"}
        </button>
        <button
          type="button"
          className="mock-test__btn mock-test__btn--ghost"
          onClick={onDone}
        >
          Done
        </button>
      </div>
    </section>
  );
}

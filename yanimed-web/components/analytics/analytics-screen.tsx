"use client";

import { useEffect, useRef, useState } from "react";
import { useSubjectsStore } from "@/lib/stores/subjects-store";
import { FilterBar } from "@/components/analytics/filter-bar";
import { KpiCards } from "@/components/analytics/kpi-cards";
import { TopicBreakdown } from "@/components/analytics/topic-breakdown";
import {
  AnalyticsApiError,
  getAnalyticsSummary,
  type AnalyticsRange,
  type AnalyticsSummaryResponse,
} from "@/lib/analytics-api";

const panel = "rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4";
const subtitle = "text-[13px] text-[hsl(var(--muted-foreground))]";

export function AnalyticsScreen() {
  const subjects = useSubjectsStore((state) => state.subjects);

  const [range, setRange] = useState<AnalyticsRange>("all");
  const [subjectId, setSubjectId] = useState<string | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);

  const [result, setResult] = useState<{
    key: string;
    data: AnalyticsSummaryResponse | null;
    error: string | null;
  } | null>(null);

  const requestKey = `${subjectId ?? "all"}:${topic ?? "all"}:${range}:${retryToken}`;
  const loading = result?.key !== requestKey;
  const data = result?.key === requestKey ? result.data : null;
  const error = result?.key === requestKey ? result.error : null;
  const requestIdRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    const requestId = ++requestIdRef.current;

    void getAnalyticsSummary({ subjectId: subjectId ?? undefined, topic: topic ?? undefined, range }, controller.signal)
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
            err instanceof AnalyticsApiError
              ? err.message
              : "Something went wrong while loading analytics.",
        });
      });

    return () => controller.abort();
  }, [subjectId, topic, range, requestKey, subjects]);

  const handleSubjectChange = (newSubjectId: string | null) => {
    setSubjectId(newSubjectId);
    setTopic(null);
  };

  const handleTopicChange = (newTopic: string | null) => {
    setTopic(newTopic);
  };

  const handleRangeChange = (newRange: AnalyticsRange) => {
    setRange(newRange);
  };

  return (
    <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4">
      <header>
        <h1 className="m-0 text-2xl font-semibold text-[hsl(var(--foreground))]">Analytics</h1>
        <p className={`m-0 mt-0.5 ${subtitle}`}>Track your performance by topic and subject.</p>
      </header>

      <FilterBar
        subjects={subjects}
        bySubject={data?.bySubject ?? []}
        availableTopics={data?.availableTopics ?? []}
        selectedSubjectId={subjectId}
        selectedTopic={topic}
        selectedRange={range}
        onSubjectChange={handleSubjectChange}
        onTopicChange={handleTopicChange}
        onRangeChange={handleRangeChange}
      />

      {loading && (
        <p role="status" className={`${panel} ${subtitle}`}>
          Loading analytics…
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

      {data && (
        <>
          <KpiCards
            totalAnswered={data.overall.totalAnswered}
            correctCount={data.overall.correctCount}
            accuracyPercent={data.overall.accuracyPercent}
            completedTestsCount={data.overall.completedTestsCount}
            byTopic={data.byTopic}
          />

          <TopicBreakdown byTopic={data.byTopic} totalAnswered={data.overall.totalAnswered} />
        </>
      )}
    </div>
  );
}

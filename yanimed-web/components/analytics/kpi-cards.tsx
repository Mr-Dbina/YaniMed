"use client";

import type { AnalyticsByTopicItem } from "@/lib/analytics-api";

interface KpiCardsProps {
  totalAnswered: number;
  correctCount: number;
  accuracyPercent: number;
  completedTestsCount: number;
  byTopic: AnalyticsByTopicItem[];
}

const panel =
  "rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))] p-4 flex flex-col gap-1";
const subtitle = "text-[13px] text-[hsl(var(--muted-foreground))]";

function getWeakestTopic(byTopic: AnalyticsByTopicItem[]): string {
  if (byTopic.length === 0) return "—";
  return byTopic[0].topic;
}

function MasteryBadge({ accuracy }: { accuracy: number }) {
  if (accuracy < 60) {
    return (
      <span className="inline-flex items-center rounded-full bg-[hsl(var(--destructive))/10] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--destructive))]">
        Needs Review
      </span>
    );
  }
  if (accuracy < 80) {
    return (
      <span className="inline-flex items-center rounded-full bg-[hsl(var(--amber))/10] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--amber))]">
        Developing
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-[hsl(var(--success))/10] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--success))]">
      Strong
    </span>
  );
}

export function KpiCards({ totalAnswered, correctCount, accuracyPercent, completedTestsCount, byTopic }: KpiCardsProps) {
  const weakestTopic = getWeakestTopic(byTopic);

  return (
    <section aria-label="KPI summary" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <div className={panel}>
        <span className={subtitle}>Overall Accuracy</span>
        <div className="flex items-baseline gap-2">
          <span className="text-[28px] font-medium text-[hsl(var(--foreground))] tabular">
            {accuracyPercent.toFixed(1)}%
          </span>
          <MasteryBadge accuracy={accuracyPercent} />
        </div>
      </div>

      <div className={panel}>
        <span className={subtitle}>Questions Answered</span>
        <span className="text-[28px] font-medium text-[hsl(var(--foreground))] tabular">
          {correctCount} / {totalAnswered}
        </span>
      </div>

      <div className={panel}>
        <span className={subtitle}>Completed Mock Tests</span>
        <span className="text-[28px] font-medium text-[hsl(var(--foreground))] tabular">
          {completedTestsCount}
        </span>
      </div>

      <div className={panel}>
        <span className={subtitle}>Weakest Topic</span>
        <span className="text-[15px] font-medium text-[hsl(var(--foreground))] truncate">
          {weakestTopic}
        </span>
      </div>
    </section>
  );
}
"use client";

import Link from "next/link";
import { Play, BookOpen } from "lucide-react";
import type { AnalyticsByTopicItem } from "@/lib/analytics-api";

interface TopicBreakdownProps {
  byTopic: AnalyticsByTopicItem[];
  totalAnswered: number;
}

const panel =
  "rounded-xl border border-[hsl(var(--border))] bg-[hsl(var(--card))]";
const subtitle = "text-[13px] text-[hsl(var(--muted-foreground))]";

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

function SubjectBadge({ subject }: { subject: string }) {
  return (
    <span className="inline-flex items-center rounded-md bg-[hsl(var(--primary))/10] px-2 py-0.5 text-[11px] font-medium text-[hsl(var(--primary))]">
      {subject}
    </span>
  );
}

function ProgressBar({ accuracy }: { accuracy: number }) {
  const color =
    accuracy < 60
      ? "bg-[hsl(var(--destructive))]"
      : accuracy < 80
      ? "bg-[hsl(var(--amber))]"
      : "bg-[hsl(var(--success))]";

  return (
    <div
      className="h-2 w-full max-w-[200px] overflow-hidden rounded-full bg-[hsl(var(--muted))]"
      role="progressbar"
      aria-valuenow={Math.round(accuracy)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span className={`block h-full rounded-full ${color}`} style={{ width: `${accuracy}%` }} />
    </div>
  );
}

function ActionButtons({ subjectId, topic }: { subjectId: string; topic: string }) {
  const encodedSubjectId = encodeURIComponent(subjectId);
  const encodedTopic = encodeURIComponent(topic);

  return (
    <div className="flex items-center gap-2">
      <Link
        href={`/mock-test?subjectId=${encodedSubjectId}`}
        className="inline-flex items-center gap-1.5 rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-[12px] font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
        title={`Start Mock Test for ${topic}`}
      >
        <Play size={14} aria-hidden="true" />
        <span>Mock Test</span>
      </Link>
      <Link
        href={`/subjects/${encodedSubjectId}?topic=${encodedTopic}`}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[hsl(var(--primary))] px-3 py-1.5 text-[12px] font-semibold text-[hsl(var(--primary-foreground))] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))]"
        title={`Practice ${topic}`}
      >
        <BookOpen size={14} aria-hidden="true" />
        <span>Practice</span>
      </Link>
    </div>
  );
}

export function TopicBreakdown({ byTopic, totalAnswered }: TopicBreakdownProps) {
  if (totalAnswered === 0) {
    return (
      <section aria-label="Topic breakdown" className={panel}>
        <div className="flex flex-col items-center gap-2 py-10 text-center px-4">
          <BookOpen size={48} className="text-[hsl(var(--muted-foreground))]" aria-hidden="true" />
          <h3 className="m-0 text-lg font-semibold text-[hsl(var(--foreground))]">No data yet</h3>
          <p className={`m-0 ${subtitle} max-w-[300px]`}>
            Take a mock test or practice questions to see your topic-level performance.
          </p>
        </div>
      </section>
    );
  }

  return (
    <section aria-label="Topic breakdown" className={panel}>
      <div className="p-4 border-b border-[hsl(var(--border))]">
        <h2 className="m-0 text-lg font-semibold text-[hsl(var(--foreground))]">Topic & Chapter Breakdown</h2>
        <p className={`m-0 mt-0.5 ${subtitle}`}>Sorted by weakest topics first</p>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full" role="table">
          <thead>
            <tr className="border-b border-[hsl(var(--border))]">
              <th className="text-left p-3 text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Topic</th>
              <th className="text-left p-3 text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Subject</th>
              <th className="text-right p-3 text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Attempted</th>
              <th className="text-left p-3 text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Accuracy</th>
              <th className="text-center p-3 text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Mastery</th>
              <th className="text-right p-3 text-[11px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))]">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[hsl(var(--border))]">
            {byTopic.map((item) => {
              const accuracy = item.accuracyPercent ?? 0;
              return (
              <tr key={`${item.subjectId}-${item.topicKey}`} className="hover:bg-[hsl(var(--muted))/50]">
                <td className="p-3 text-[13px] font-medium text-[hsl(var(--foreground))]">
                  {item.topic}
                </td>
                <td className="p-3">
                  <SubjectBadge subject={item.subject} />
                </td>
                <td className="p-3 text-right text-[13px] text-[hsl(var(--foreground))] tabular">
                  {item.correctCount} / {item.totalAnswered}
                </td>
                <td className="p-3">
                  <div className="flex items-center gap-3">
                    <ProgressBar accuracy={accuracy} />
                    <span className="text-[13px] font-medium text-[hsl(var(--foreground))] tabular w-[50px] text-right">
                      {item.accuracyPercent === null ? "—" : `${item.accuracyPercent.toFixed(1)}%`}
                    </span>
                  </div>
                </td>
                <td className="p-3 text-center">
                  <MasteryBadge accuracy={accuracy} />
                </td>
                <td className="p-3 text-right">
                  <ActionButtons subjectId={item.subjectId} topic={item.topic} />
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
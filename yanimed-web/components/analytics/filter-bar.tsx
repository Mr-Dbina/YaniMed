"use client";

import { ChevronDown } from "lucide-react";
import type { Subject } from "@/lib/types";
import type { AnalyticsAvailableTopicItem, AnalyticsBySubjectItem } from "@/lib/analytics-api";

interface FilterBarProps {
  subjects: Subject[];
  bySubject: AnalyticsBySubjectItem[];
  availableTopics: AnalyticsAvailableTopicItem[];
  selectedSubjectId: string | null;
  selectedTopic: string | null;
  selectedRange: "7" | "30" | "90" | "all";
  onSubjectChange: (subjectId: string | null) => void;
  onTopicChange: (topic: string | null) => void;
  onRangeChange: (range: "7" | "30" | "90" | "all") => void;
}

const RANGE_OPTIONS: { value: "7" | "30" | "90" | "all"; label: string }[] = [
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "90", label: "Last 90 days" },
  { value: "all", label: "All time" },
];

const selectBase =
  "flex h-9 w-full items-center rounded-lg border border-[hsl(var(--border))] bg-[hsl(var(--background))] px-3 py-1.5 text-[13px] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50 appearance-none bg-no-repeat bg-right pr-8";
const selectArrow =
  "absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-[hsl(var(--muted-foreground))]";

export function FilterBar({
  subjects,
  bySubject,
  availableTopics,
  selectedSubjectId,
  selectedTopic,
  selectedRange,
  onSubjectChange,
  onTopicChange,
  onRangeChange,
}: FilterBarProps) {
  const subjectMap = new Map<string, string>();
  for (const subject of subjects) {
    if (subject.backendSubjectId) {
      subjectMap.set(subject.backendSubjectId, subject.name);
    }
  }
  for (const s of bySubject) {
    if (!subjectMap.has(s.subjectId)) {
      subjectMap.set(s.subjectId, s.subject);
    }
  }
  const subjectOptions = [
    { id: null, name: "All Subjects" },
    ...Array.from(subjectMap.entries()).map(([id, name]) => ({ id, name })),
  ];

  return (
    <div className="flex flex-wrap items-center gap-2.5 px-1">
      <div className="relative min-w-[180px] flex-1">
        <select
          value={selectedSubjectId ?? ""}
          onChange={(e) => onSubjectChange(e.target.value || null)}
          className={selectBase}
          aria-label="Subject filter"
        >
          {subjectOptions.map((opt) => (
            <option key={opt.id ?? "all"} value={opt.id ?? ""}>
              {opt.name}
            </option>
          ))}
        </select>
        <ChevronDown size={16} className={selectArrow} aria-hidden="true" />
      </div>

      <div className="relative min-w-[180px] flex-1">
        <select
          value={selectedTopic ?? ""}
          onChange={(e) => onTopicChange(e.target.value || null)}
          className={selectBase}
          aria-label="Topic filter"
          disabled={availableTopics.length === 0}
        >
          <option value="">All Topics</option>
          {availableTopics.map((topic) => (
            <option key={topic.topicKey} value={topic.topicKey}>
              {topic.topic}
            </option>
          ))}
        </select>
        <ChevronDown size={16} className={selectArrow} aria-hidden="true" />
      </div>

      <div className="relative min-w-[150px]">
        <select
          value={selectedRange}
          onChange={(e) => onRangeChange(e.target.value as "7" | "30" | "90" | "all")}
          className={selectBase}
          aria-label="Time range filter"
        >
          {RANGE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <ChevronDown size={16} className={selectArrow} aria-hidden="true" />
      </div>
    </div>
  );
}
import { addDays, manilaDateKey } from "@/components/dashboard/format";
import type { DashboardHeatmapDay } from "@/lib/dashboard-api";

interface DashboardHeatmapProps {
  days: DashboardHeatmapDay[];
  generatedAt: string;
}

const DAYS_SHOWN = 182;

function intensityClass(count: number): string {
  if (count <= 0) return "bg-[hsl(var(--muted))]";
  if (count === 1) return "bg-[hsl(var(--primary))] opacity-25";
  if (count === 2) return "bg-[hsl(var(--primary))] opacity-45";
  if (count <= 4) return "bg-[hsl(var(--primary))] opacity-70";
  return "bg-[hsl(var(--primary))]";
}

export function DashboardHeatmap({ days, generatedAt }: DashboardHeatmapProps) {
  const counts = new Map(days.map((day) => [day.date, day.count]));
  const today = manilaDateKey(generatedAt);
  const firstDay = addDays(today, -(DAYS_SHOWN - 1));

  return (
    <div className="mt-3 inline-grid grid-flow-col grid-rows-7 gap-[2px] sm:gap-[3px]">
      {Array.from({ length: DAYS_SHOWN }, (_, index) => {
        const dateKey = addDays(firstDay, index);
        const count = counts.get(dateKey) ?? 0;
        const label = `${dateKey}: ${count} ${count === 1 ? "activity" : "activities"}`;
        return (
          <span
            key={dateKey}
            role="img"
            aria-label={label}
            title={label}
            className={`h-2 w-2 rounded-[2px] sm:h-2.5 sm:w-2.5 ${intensityClass(count)}`}
          />
        );
      })}
    </div>
  );
}

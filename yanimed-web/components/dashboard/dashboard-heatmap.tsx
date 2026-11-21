"use client";

import { useEffect, useRef, useState } from "react";
import { addDays } from "@/components/dashboard/format";
import type { DashboardHeatmapDay } from "@/lib/dashboard-api";

interface DashboardHeatmapProps {
  days: DashboardHeatmapDay[];
  generatedAt: string;
}

const TIMEZONE = "Asia/Manila";

const CELL = 12;
const GAP = 3;
const LABEL_W = 36;
const MONTH_H = 18;
const RX = 3;

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function levelOpacity(count: number): number | null {
  if (count <= 0) return null;
  if (count === 1) return 0.25;
  if (count <= 3) return 0.45;
  if (count <= 6) return 0.70;
  return 1.0;
}

/** Manila YYYY-MM-DD via Intl, never local. */
function manilaDayKey(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function parseKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function dayLabel(dateKey: string, count: number): string {
  const pretty = new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parseKey(dateKey));
  if (count <= 0) return `No activity on ${pretty}`;
  return `${count} ${count === 1 ? "study activity" : "study activities"} on ${pretty}`;
}

export function DashboardHeatmap({ days, generatedAt }: DashboardHeatmapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(800);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (entry.contentRect.width > 0) {
          setContainerWidth(entry.contentRect.width);
        }
      }
    });
    observer.observe(el);
    setContainerWidth(el.clientWidth || 800);
    return () => observer.disconnect();
  }, []);

  const counts = new Map(days.map((day) => [day.date, day.count]));

  const todayKey = manilaDayKey(generatedAt);
  const today = parseKey(todayKey);
  const mondayIndex = (today.getUTCDay() + 6) % 7;
  const lastWeekMonday = addDays(todayKey, -mondayIndex);

  // weeks = clamp(floor((W - LABEL_W + GAP) / (CELL + GAP)), 12, 53)
  const maxWeeks = 53;
  const minWeeks = 12;
  const rawWeeks = Math.floor((containerWidth - LABEL_W + GAP) / (CELL + GAP));
  const weeks = Math.min(maxWeeks, Math.max(minWeeks, rawWeeks));

  const totalDays = weeks * 7;
  const gridStart = addDays(lastWeekMonday, -(totalDays - 7));

  const cells: { dateKey: string; future: boolean; col: number; row: number }[] = [];
  for (let index = 0; index < totalDays; index += 1) {
    const dateKey = addDays(gridStart, index);
    const col = Math.floor(index / 7);
    const row = index % 7;
    cells.push({ dateKey, future: dateKey > todayKey, col, row });
  }

  // Month labels at the first column of each month in displayed range, skipping < 3 columns, never clipped.
  const monthLabels: { column: number; text: string }[] = [];
  let lastLabelColumn = -99;
  for (let column = 0; column < weeks; column += 1) {
    for (let day = 0; day < 7; day += 1) {
      const cell = cells[column * 7 + day];
      if (!cell || cell.future) continue;
      const parsed = parseKey(cell.dateKey);
      if (parsed.getUTCDate() !== 1) continue;
      if (column - lastLabelColumn < 3) break;
      if (column > weeks - 3 && monthLabels.length > 0) break;
      monthLabels.push({ column, text: MONTH_ABBR[parsed.getUTCMonth()] });
      lastLabelColumn = column;
      break;
    }
  }

  // Ensure last month label if appropriate and space permits
  for (let column = Math.max(0, weeks - 4); column < weeks; column += 1) {
    for (let day = 0; day < 7; day += 1) {
      const cell = cells[column * 7 + day];
      if (!cell || cell.future) continue;
      const parsed = parseKey(cell.dateKey);
      if (parsed.getUTCDate() !== 1) continue;
      if (!monthLabels.some((l) => l.column === column)) {
        if (monthLabels.length === 0 || column - monthLabels[monthLabels.length - 1].column >= 3) {
          monthLabels.push({ column, text: MONTH_ABBR[parsed.getUTCMonth()] });
        }
      }
      break;
    }
  }

  const gridW = weeks * CELL + (weeks - 1) * GAP;
  const gridH = 7 * CELL + 6 * GAP;
  const svgW = LABEL_W + gridW;
  const svgH = MONTH_H + gridH;

  return (
    <div className="heatmap" ref={containerRef}>
      <div className="w-full overflow-hidden">
        <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} className="block w-full h-auto">
          {/* Month labels */}
          {monthLabels.map((label) => {
            const x = LABEL_W + label.column * (CELL + GAP);
            return (
              <text
                key={`${label.column}-${label.text}`}
                x={x}
                y={12}
                style={{ fill: "var(--heat-label)", fontFamily: "inherit" }}
                fontSize="11"
              >
                {label.text}
              </text>
            );
          })}

          {/* Day labels */}
          {DAY_LABELS.map((dayName, rowIdx) => {
            const y = MONTH_H + rowIdx * (CELL + GAP) + CELL / 2;
            return (
              <text
                key={dayName}
                x={0}
                y={y}
                dominantBaseline="middle"
                style={{ fill: "var(--heat-label)", fontFamily: "inherit" }}
                fontSize="11"
              >
                {dayName}
              </text>
            );
          })}

          {/* Cells */}
          {cells.map((cell) => {
            if (cell.future) return null;
            const x = LABEL_W + cell.col * (CELL + GAP);
            const y = MONTH_H + cell.row * (CELL + GAP);
            const count = counts.get(cell.dateKey) ?? 0;
            const label = dayLabel(cell.dateKey, count);
            const opacity = levelOpacity(count);

            return (
              <rect
                key={cell.dateKey}
                x={x}
                y={y}
                width={CELL}
                height={CELL}
                rx={RX}
                style={{
                  fill: opacity === null ? "var(--heat-empty)" : "#E6007A",
                }}
                fillOpacity={opacity !== null ? opacity : undefined}
              >
                <title>{label}</title>
              </rect>
            );
          })}
        </svg>
      </div>

      <div className="heatmap__legend">
        <span>Less</span>
        <span className="heatmap__legend-tile" style={{ background: "var(--heat-empty)" }} />
        <span className="heatmap__legend-tile" style={{ background: "#E6007A", opacity: 0.25 }} />
        <span className="heatmap__legend-tile" style={{ background: "#E6007A", opacity: 0.45 }} />
        <span className="heatmap__legend-tile" style={{ background: "#E6007A", opacity: 0.70 }} />
        <span className="heatmap__legend-tile" style={{ background: "#E6007A", opacity: 1.0 }} />
        <span>More</span>
      </div>
    </div>
  );
}

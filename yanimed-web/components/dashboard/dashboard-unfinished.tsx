import { ChevronDown } from "lucide-react";
import type { DashboardUnfinished } from "@/lib/dashboard-api";

interface DashboardUnfinishedProps {
  items: DashboardUnfinished[];
  busy: boolean;
  error: string | null;
  onResume: (item: DashboardUnfinished) => void;
  onDiscard: (item: DashboardUnfinished) => void;
}

const primaryButton =
  "inline-flex items-center justify-center rounded-lg bg-[hsl(var(--primary))] px-4 py-2 text-[13px] font-semibold text-[hsl(var(--primary-foreground))] hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50";

const secondaryButton =
  "inline-flex items-center justify-center rounded-lg border border-[hsl(var(--border))] bg-transparent px-4 py-2 text-[13px] font-medium text-[hsl(var(--foreground))] hover:bg-[hsl(var(--muted))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))] disabled:cursor-not-allowed disabled:opacity-50";

function ageLabel(ageDays: number): string {
  if (ageDays <= 0) return "today";
  return `${ageDays} ${ageDays === 1 ? "day" : "days"} ago`;
}

function Progress({ answered, total }: { answered: number; total: number }) {
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((answered / total) * 100))) : 0;
  return (
    <div
      className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[hsl(var(--muted))]"
      role="progressbar"
      aria-label="Questions completed"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={answered}
    >
      <span
        className="block h-full rounded-full bg-[hsl(var(--primary))]"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

function OverFourteenFlag() {
  return (
    <span className="inline-flex items-center rounded-md bg-[hsl(var(--danger-soft))] px-1.5 py-0.5 text-[11px] font-medium text-[hsl(var(--destructive))]">
      Over 14 days
    </span>
  );
}

function Actions({
  item,
  busy,
  onResume,
  onDiscard,
}: {
  item: DashboardUnfinished;
  busy: boolean;
  onResume: (item: DashboardUnfinished) => void;
  onDiscard: (item: DashboardUnfinished) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" className={primaryButton} disabled={busy} onClick={() => onResume(item)}>
        Resume →
      </button>
      <button type="button" className={secondaryButton} disabled={busy} onClick={() => onDiscard(item)}>
        Discard
      </button>
    </div>
  );
}

export function DashboardUnfinishedTests({
  items,
  busy,
  error,
  onResume,
  onDiscard,
}: DashboardUnfinishedProps) {
  const first = items[0];
  const rest = items.slice(1);

  return (
    <section
      aria-labelledby="continue-answering"
      className="rounded-xl border border-[hsl(var(--primary))] bg-[linear-gradient(120deg,hsl(var(--primary-soft)),hsl(var(--primary-tint)))] p-4"
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-[160px] flex-1">
          <h2 id="continue-answering" className="m-0 text-xs font-medium text-[hsl(var(--primary))]">
            Continue answering
          </h2>
          <div className="mt-0.5 flex flex-wrap items-center gap-2">
            <p className="m-0 text-xl font-semibold text-[hsl(var(--foreground))]">{first.subjectName}</p>
            {first.overFourteenDays && <OverFourteenFlag />}
          </div>
          <p className="mt-0.5 text-[13px] text-[hsl(var(--muted-foreground))]">
            {first.answered} of {first.total} questions completed
          </p>
          <Progress answered={first.answered} total={first.total} />
        </div>
        <Actions item={first} busy={busy} onResume={onResume} onDiscard={onDiscard} />
      </div>

      {error && (
        <p role="alert" className="mt-3 text-[13px] text-[hsl(var(--destructive))]">
          {error}
        </p>
      )}

      {rest.length > 0 && (
        <details className="group mt-3 border-t border-[hsl(var(--primary))] pt-2.5">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 text-[13px] font-medium text-[hsl(var(--primary))] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[hsl(var(--ring))] [&::-webkit-details-marker]:hidden">
            <span>
              +{rest.length} more unfinished {rest.length === 1 ? "test" : "tests"}
            </span>
            <ChevronDown
              size={16}
              strokeWidth={1.75}
              aria-hidden="true"
              className="transition-transform group-open:rotate-180"
            />
          </summary>
          <ul className="mt-2 flex list-none flex-col gap-2 p-0">
            {rest.map((item) => (
              <li
                key={item.attemptId}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[hsl(var(--card))] px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="m-0 flex flex-wrap items-center gap-1.5 text-[13px]">
                    <span className="font-semibold text-[hsl(var(--foreground))]">{item.subjectName}</span>
                    <span className="text-[hsl(var(--muted-foreground))]">
                      · {item.answered} of {item.total} · {ageLabel(item.ageDays)}
                    </span>
                    {item.overFourteenDays && <OverFourteenFlag />}
                  </p>
                </div>
                <Actions item={item} busy={busy} onResume={onResume} onDiscard={onDiscard} />
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

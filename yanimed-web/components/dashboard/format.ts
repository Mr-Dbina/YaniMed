const MANILA_OFFSET_MS = 8 * 60 * 60 * 1000;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Manila calendar date for an instant, without browser-local conversion. */
export function manilaDateKey(iso: string): string {
  return new Date(Date.parse(iso) + MANILA_OFFSET_MS).toISOString().slice(0, 10);
}

/** Moves a YYYY-MM-DD key by whole days using UTC. */
export function addDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Short Manila date, e.g. "Nov 10". */
export function formatManilaShortDate(iso: string): string {
  const date = new Date(Date.parse(iso) + MANILA_OFFSET_MS);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

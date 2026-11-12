import { normalizeObjective } from './normalize.js';

/** Four answer texts must differ after case and whitespace normalization. */
export function distinctChoices(values: readonly string[]): boolean {
  return (
    new Set(values.map((value) => value.trim().toLowerCase())).size ===
    values.length
  );
}

/** Catch-all options are banned; they cannot be grounded in a single quote. */
export function isBannedChoice(value: string): boolean {
  const normalized = normalizeObjective(value);
  return (
    normalized.includes('all of the above') ||
    normalized.includes('none of the above')
  );
}

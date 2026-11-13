import {
  SAME_FACT_KEY_CHOICE_MIN_CHARS,
  SAME_FACT_QUOTE_DICE,
} from '../generation.constants.js';
import { normalizeObjective } from '../text/normalize.js';
import { normalizeForMatch } from '../text/similarity.js';

/** The fields two questions must share before they can test the same fact. */
export interface FactFields {
  documentId: string;
  page: number;
  objective: string;
  quote: string;
  keyChoiceText: string;
}

export const SAME_FACT_REASONS = {
  SAME_OBJECTIVE: 'SAME_OBJECTIVE',
  QUOTE_MATCH: 'QUOTE_MATCH',
  KEY_CHOICE_MATCH: 'KEY_CHOICE_MATCH',
} as const;

export type SameFactReason =
  (typeof SAME_FACT_REASONS)[keyof typeof SAME_FACT_REASONS];

export interface SameFactResult {
  same: boolean;
  reason: SameFactReason | null;
}

function bigramCounts(text: string): Map<string, number> {
  const normalized = normalizeForMatch(text);
  const counts = new Map<string, number>();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    const gram = normalized.slice(index, index + 2);
    counts.set(gram, (counts.get(gram) ?? 0) + 1);
  }
  return counts;
}

/** Multiset bigram Dice over normalized text. 0 when either side is empty. */
export function quoteDice(a: string, b: string): number {
  const left = bigramCounts(a);
  const right = bigramCounts(b);
  if (left.size === 0 || right.size === 0) return 0;

  let leftTotal = 0;
  let rightTotal = 0;
  let overlap = 0;
  for (const count of left.values()) leftTotal += count;
  for (const [gram, count] of right) {
    rightTotal += count;
    overlap += Math.min(left.get(gram) ?? 0, count);
  }

  return (2 * overlap) / (leftTotal + rightTotal);
}

function sameObjective(a: string, b: string): boolean {
  const left = normalizeObjective(a);
  const right = normalizeObjective(b);
  return left !== '' && left === right;
}

function sameKeyChoice(a: string, b: string): boolean {
  const left = normalizeObjective(a);
  const right = normalizeObjective(b);
  return left.length >= SAME_FACT_KEY_CHOICE_MIN_CHARS && left === right;
}

/**
 * Conservative same-fact heuristic. Both items must cite the same page; then
 * any one signal is enough. When in doubt this returns false, because a false
 * positive silently drops a defensible question.
 */
export function isSameFact(a: FactFields, b: FactFields): SameFactResult {
  if (a.documentId !== b.documentId || a.page !== b.page) {
    return { same: false, reason: null };
  }

  if (sameObjective(a.objective, b.objective)) {
    return { same: true, reason: SAME_FACT_REASONS.SAME_OBJECTIVE };
  }

  if (quoteDice(a.quote, b.quote) >= SAME_FACT_QUOTE_DICE) {
    return { same: true, reason: SAME_FACT_REASONS.QUOTE_MATCH };
  }

  if (sameKeyChoice(a.keyChoiceText, b.keyChoiceText)) {
    return { same: true, reason: SAME_FACT_REASONS.KEY_CHOICE_MATCH };
  }

  return { same: false, reason: null };
}

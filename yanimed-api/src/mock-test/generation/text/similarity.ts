import { PAGE_MATCH_MAX_CHARS } from '../generation.constants.js';

export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function cosine(
  a: readonly number[],
  b: readonly number[],
): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function buildBigrams(text: string): Map<string, number> {
  const bigrams = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index += 1) {
    const gram = text.slice(index, index + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  return bigrams;
}

function buildBigramList(text: string): string[] {
  const bigrams: string[] = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    bigrams.push(text.slice(index, index + 2));
  }
  return bigrams;
}

export interface QuoteMatchOptions {
  /** Cap the normalized page before scanning. Defaults to 20,000 chars. */
  maxPageChars?: number;
}

/**
 * Sliding-window bigram Dice over the normalized page. The page bigrams are
 * built once; the window counts are updated incrementally, so a long page
 * costs O(page length), not O(page length * quote length).
 */
export function fuzzyQuoteSimilarity(
  pageText: string,
  quote: string,
  options: QuoteMatchOptions = {},
): number {
  const maxPageChars = options.maxPageChars ?? PAGE_MATCH_MAX_CHARS;
  const page = normalizeForMatch(pageText).slice(0, maxPageChars);
  const needle = normalizeForMatch(quote);

  if (!needle) return 0;
  if (page.includes(needle)) return 1;

  const windowLength = needle.length;
  if (page.length < windowLength) return 0;

  const needleBigrams = buildBigrams(needle);
  const windowBigramCount = windowLength - 1;
  if (windowBigramCount <= 0) return 0;

  const pageBigrams = buildBigramList(page);
  const windowCounts = new Map<string, number>();
  let overlap = 0;

  const add = (gram: string): void => {
    const current = windowCounts.get(gram) ?? 0;
    if (current < (needleBigrams.get(gram) ?? 0)) overlap += 1;
    windowCounts.set(gram, current + 1);
  };

  const remove = (gram: string): void => {
    const current = windowCounts.get(gram) ?? 0;
    if (current <= 0) return;
    if (current <= (needleBigrams.get(gram) ?? 0)) overlap -= 1;
    if (current === 1) windowCounts.delete(gram);
    else windowCounts.set(gram, current - 1);
  };

  for (let index = 0; index < windowBigramCount; index += 1) {
    add(pageBigrams[index]);
  }

  let best = overlap / windowBigramCount;

  for (
    let start = 1;
    start + windowLength <= page.length;
    start += 1
  ) {
    remove(pageBigrams[start - 1]);
    add(pageBigrams[start + windowBigramCount - 1]);
    const score = overlap / windowBigramCount;
    if (score > best) best = score;
    if (best >= 1) break;
  }

  return Math.min(1, best);
}

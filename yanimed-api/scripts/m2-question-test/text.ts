import type { Letter } from './types.js';
import { LETTERS } from './types.js';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function parseEmbedding(raw: string | null | undefined): number[] {
  if (!raw) return [];
  const inside = raw.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!inside) return [];
  return inside
    .split(',')
    .map(part => Number(part.trim()))
    .filter(value => Number.isFinite(value));
}

export function normalizeVector(vector: number[]): number[] {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) return vector.map(() => 0);
  return vector.map(value => value / norm);
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Spec 4: sentence counter that tolerates abbreviations and decimals.
export function countSentences(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const protectedText = trimmed
    .replace(/\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|approx|No|Fig|Ph\.D|M\.D|U\.S|B\.S)\./gi, match =>
      match.replace(/\./g, '\u0001'),
    )
    .replace(/\b(?:[A-Za-z]\.){2,}/g, match => match.replace(/\./g, '\u0001'))
    .replace(/\b[A-Z]\.(?=\s+[A-Z])/g, match => match.replace(/\./g, '\u0001'))
    .replace(/(\d)\.(\d)/g, '$1\u0001$2');

  const parts = protectedText
    .split(/[.!?]+(?=\s|$)/)
    .map(part => part.trim())
    .filter(part => part.length > 0);

  return parts.length;
}

function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function buildBigrams(text: string): Map<string, number> {
  const bigrams = new Map<string, number>();
  for (let i = 0; i < text.length - 1; i++) {
    const gram = text.slice(i, i + 2);
    bigrams.set(gram, (bigrams.get(gram) ?? 0) + 1);
  }
  return bigrams;
}

function bigramDice(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let overlap = 0;
  for (const [gram, count] of a) {
    const other = b.get(gram);
    if (other) overlap += Math.min(count, other);
  }
  return (2 * overlap) / (a.size + b.size);
}

// Spec 5: lightweight sliding-window fuzzy match. Bigram Dice handles light OCR noise.
export function fuzzyQuoteSimilarity(pageText: string, quote: string): number {
  const page = normalizeForMatch(pageText);
  const needle = normalizeForMatch(quote);
  if (!needle) return 0;
  if (page.includes(needle)) return 1;
  if (page.length < needle.length) return 0;

  const needleBigrams = buildBigrams(needle);
  const windowLength = needle.length;
  const step = Math.max(1, Math.floor(windowLength / 40));
  let best = 0;

  for (let start = 0; start + windowLength <= page.length; start += step) {
    const window = page.slice(start, start + windowLength);
    const similarity = bigramDice(needleBigrams, buildBigrams(window));
    if (similarity > best) best = similarity;
    if (best >= 0.999) break;
  }

  return best;
}

// Spec 3: each letter appears 10-15 times in 50, then shuffled.
export function balancedLetters(count: number, rng: () => number): Letter[] {
  const base = Math.floor(count / 4);
  const remainder = count % 4;
  const letters: Letter[] = [];
  LETTERS.forEach((letter, index) => {
    const occurrences = base + (index < remainder ? 1 : 0);
    for (let i = 0; i < occurrences; i++) letters.push(letter);
  });
  return shuffle(letters, rng);
}

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
}

// Spec 1: front matter / contents / index / references and low-signal text heuristics.
export function classifyChunk(content: string): EligibilityResult {
  const text = content.trim();
  if (text.length < 200) return { eligible: false, reason: 'short' };

  const head = text.split(/\r?\n/).slice(0, 12).join('\n');
  if (/(^|\n)\s*(table of contents|contents|index|references|bibliography)\s*($|\n)/i.test(head)) {
    return { eligible: false, reason: 'front-matter-heading' };
  }

  if (/\.{4,}\s*\d+/.test(text) || /(?:\.\s*){6,}\d+/.test(text)) {
    return { eligible: false, reason: 'dot-leader' };
  }

  const letterCount = (text.match(/\p{L}/gu) ?? []).length;
  const digitCount = (text.match(/\d/g) ?? []).length;
  if (digitCount >= 20 && digitCount > letterCount * 1.2) {
    return { eligible: false, reason: 'mostly-digits' };
  }

  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length >= 5) {
    const shortLines = lines.filter(line => line.length < 15).length;
    if (shortLines / lines.length > 0.6) {
      return { eligible: false, reason: 'mostly-short-lines' };
    }
  }

  return { eligible: true };
}

export function placeholderTopicName(content: string): string {
  const line = content
    .split(/\r?\n/)
    .map(value => value.trim())
    .find(value => value.length >= 3 && /\p{L}/u.test(value));
  return (line ?? 'Untitled topic').replace(/\s+/g, ' ').slice(0, 80);
}

export function normalizeObjective(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function isBannedChoice(value: string): boolean {
  const normalized = normalizeObjective(value);
  return normalized.includes('all of the above') || normalized.includes('none of the above');
}

export function distinctChoices(values: string[]): boolean {
  return new Set(values.map(value => value.trim().toLowerCase())).size === values.length;
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function redactSecret(input: string): string {
  return input
    .replace(/(bearer\s+)[A-Za-z0-9_\-.~+/=]+/gi, '$1[REDACTED]')
    .replace(/(key\s*[:=]\s*)[A-Za-z0-9_\-.~+/=]+/gi, '$1[REDACTED]')
    .replace(/(token\s*[:=]\s*)[A-Za-z0-9_\-.~+/=]+/gi, '$1[REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)[A-Za-z0-9_\-.~+/=]+/gi, '$1[REDACTED]')
    .replace(/(sk-[A-Za-z0-9]{10,})/gi, '[REDACTED]')
    .replace(/(AIza[0-9A-Za-z\-_]{20,})/gi, '[REDACTED]');
}

export function round4(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10000) / 10000;
}

export function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

export function extractJsonObject(text: string): string {
  const stripped = stripJsonFence(text);
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('No JSON object found in model response.');
  }
  return stripped.slice(start, end + 1);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

import {
  HEADING_SCAN_LINES,
  MIN_DISTINCT_PAGES,
  MIN_ELIGIBLE_CHUNK_CHARS,
  MIN_ELIGIBLE_CHUNKS,
} from '../generation.constants.js';

export interface ChunkInput {
  documentId: string;
  content: string;
  /** Physical 1-based PDF page. */
  page: number;
  chunkIndex: number;
  needsReview: boolean;
}

export type ChunkExclusionReason =
  | 'needs-review'
  | 'short'
  | 'front-matter'
  | 'reference-section'
  | 'bibliography-entry'
  | 'dot-leader'
  | 'mostly-digits'
  | 'mostly-short-lines';

export interface EligibilityState {
  /** Once a reference heading is seen, the rest of that document is excluded. */
  inReferenceSection: boolean;
}

export const INITIAL_ELIGIBILITY_STATE: EligibilityState = {
  inReferenceSection: false,
};

export interface ChunkClassification {
  eligible: boolean;
  reason?: ChunkExclusionReason;
  state: EligibilityState;
}

const FRONT_MATTER_HEADINGS = new Set([
  'table of contents',
  'contents',
  'dedication',
  'acknowledgement',
  'acknowledgements',
  'acknowledgment',
  'acknowledgments',
  'preface',
  'foreword',
  'list of tables',
  'list of figures',
  'list of abbreviations',
  'index',
]);

const REFERENCE_HEADINGS = new Set([
  'references',
  'bibliography',
  'works cited',
  'literature cited',
  'reference list',
  'suggested reading',
  'further reading',
]);

// "Smith JA, Doe B. Title. Journal. 2019;12(3):45-67."
const AUTHOR_YEAR_LINE =
  /^[A-Z][A-Za-z'’.-]+(?:\s+[A-Z][A-Za-z'’.-]*)?(?:\s+[A-Z]{1,3})?,.*\b(?:19|20)\d{2}\b/;
// Volume/issue/page, DOI, PMID, "et al." or a journal-style year;volume:pages.
const JOURNAL_MARKER =
  /\b(?:doi\s*:|https?:\/\/doi\.org\/|pmid\s*:?|et al\.|vol\.\s*\d+|pp\.\s*\d+\s*[-–]\s*\d+)\b|;\s*\d+\s*(?:\(\d+\))?\s*:/i;
const NUMBERED_REFERENCE_LINE =
  /^\s*\d{1,3}\.\s+[A-Z][^\n]{15,}\b(?:19|20)\d{2}\b/;

function headingKey(line: string): string {
  return line
    .replace(/^\s*(?:chapter|section|part)\s+[0-9ivxlc]+[.:)]?\s*/i, '')
    .replace(/^\s*[0-9]+(?:\.[0-9]+)*[.)]?\s+/, '')
    .replace(/[.:\s]+$/g, '')
    .trim()
    .toLowerCase();
}

function bodyLines(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function hasHeading(lines: readonly string[], headings: Set<string>): boolean {
  return lines.some((line) => headings.has(headingKey(line)));
}

function looksLikeBibliographyEntry(lines: readonly string[]): boolean {
  let authorYear = 0;
  let numbered = 0;
  let journal = 0;

  for (const line of lines) {
    if (AUTHOR_YEAR_LINE.test(line)) authorYear += 1;
    if (NUMBERED_REFERENCE_LINE.test(line)) numbered += 1;
    if (JOURNAL_MARKER.test(line)) journal += 1;
  }

  return (
    numbered >= 2 ||
    (authorYear >= 2 && journal >= 1) ||
    (authorYear >= 1 && journal >= 2)
  );
}

/**
 * Pure classifier. The returned state must be passed to the next chunk of the
 * same document, so a reference heading keeps excluding the entries after it.
 *
 * shortcut: once references start, the rest of that document is excluded.
 * Upgrade if a book places reference lists in the middle of the body.
 */
export function classifyChunk(
  chunk: ChunkInput,
  state: EligibilityState = INITIAL_ELIGIBILITY_STATE,
): ChunkClassification {
  if (chunk.needsReview) {
    return { eligible: false, reason: 'needs-review', state };
  }

  const text = chunk.content.trim();
  if (state.inReferenceSection) {
    return { eligible: false, reason: 'reference-section', state };
  }

  const lines = bodyLines(text);
  const head = lines.slice(0, HEADING_SCAN_LINES);

  if (hasHeading(head, FRONT_MATTER_HEADINGS)) {
    return { eligible: false, reason: 'front-matter', state };
  }

  if (hasHeading(lines, REFERENCE_HEADINGS)) {
    return {
      eligible: false,
      reason: 'reference-section',
      state: { inReferenceSection: true },
    };
  }

  if (looksLikeBibliographyEntry(lines)) {
    return { eligible: false, reason: 'bibliography-entry', state };
  }

  if (text.length < MIN_ELIGIBLE_CHUNK_CHARS) {
    return { eligible: false, reason: 'short', state };
  }

  if (/\.{4,}\s*\d+/.test(text) || /(?:\.\s*){6,}\d+/.test(text)) {
    return { eligible: false, reason: 'dot-leader', state };
  }

  const letterCount = (text.match(/\p{L}/gu) ?? []).length;
  const digitCount = (text.match(/\d/g) ?? []).length;
  if (digitCount >= 20 && digitCount > letterCount * 1.2) {
    return { eligible: false, reason: 'mostly-digits', state };
  }

  if (lines.length >= 5) {
    const shortLines = lines.filter((line) => line.length < 15).length;
    if (shortLines / lines.length > 0.6) {
      return { eligible: false, reason: 'mostly-short-lines', state };
    }
  }

  return { eligible: true, state };
}

export interface ClassifiedChunk {
  chunk: ChunkInput;
  eligible: boolean;
  reason?: ChunkExclusionReason;
}

/**
 * Classifies a whole document set in document/page/chunk order and threads the
 * heading state per document. Input order is irrelevant; output is sorted.
 */
export function classifyChunks(
  chunks: readonly ChunkInput[],
): ClassifiedChunk[] {
  const sorted = [...chunks].sort((a, b) => {
    if (a.documentId !== b.documentId) {
      return a.documentId.localeCompare(b.documentId);
    }
    if (a.page !== b.page) return a.page - b.page;
    return a.chunkIndex - b.chunkIndex;
  });

  const states = new Map<string, EligibilityState>();
  return sorted.map((chunk) => {
    const prior = states.get(chunk.documentId) ?? INITIAL_ELIGIBILITY_STATE;
    const result = classifyChunk(chunk, prior);
    states.set(chunk.documentId, result.state);
    return {
      chunk,
      eligible: result.eligible,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  });
}

export interface GateResult {
  eligibleChunks: number;
  eligiblePages: number;
  ok: boolean;
}

export interface GateOptions {
  minChunks?: number;
  minPages?: number;
}

export function evaluateGate(
  chunks: readonly ChunkInput[],
  options: GateOptions = {},
): GateResult {
  const minChunks = options.minChunks ?? MIN_ELIGIBLE_CHUNKS;
  const minPages = options.minPages ?? MIN_DISTINCT_PAGES;
  const pages = new Set<string>();
  let eligibleChunks = 0;

  for (const result of classifyChunks(chunks)) {
    if (!result.eligible) continue;
    eligibleChunks += 1;
    pages.add(`${result.chunk.documentId}:${result.chunk.page}`);
  }

  return {
    eligibleChunks,
    eligiblePages: pages.size,
    ok: eligibleChunks >= minChunks && pages.size >= minPages,
  };
}

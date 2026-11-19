import {
  AFFILIATION_PAIR_MIN,
  CREDENTIAL_MIN,
  CREDENTIAL_PAIR_MIN,
  FRONT_MATTER_SCAN_PAGES,
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

/** Prefixes checked against flattened production chunk text. Longest first. */
const FRONT_MATTER_ADMIN_HEADINGS = [
  'table of contents',
  'acknowledgements',
  'acknowledgments',
  'contributing authors',
  'list of contributors',
  'editorial board',
  'acknowledgement',
  'acknowledgment',
  'title page',
  'contributors',
  'dedication',
  'copyright',
  'contents',
  'preface',
  'foreword',
  'editors',
] as const;

/** Lowercase words that show a heading word is part of a normal sentence. */
const SENTENCE_CONTINUATIONS = new Set([
  'of',
  'the',
  'a',
  'an',
  'in',
  'on',
  'at',
  'was',
  'were',
  'is',
  'are',
  'has',
  'have',
  'had',
  'contain',
  'contains',
  'include',
  'includes',
  'consist',
  'consists',
]);

const CREDENTIAL_TOKEN =
  /\b(?:MBBS|MSc|MSN|MHS|PhD|MPH|FAAP|MD|MS|DO|RN)\b/gi;
const AFFILIATION_MARKER =
  /\b(?:University|Hospital|Department of|School of Medicine|Professor|Editor|Chief)\b/gi;

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

function stripFrontMatterLead(text: string): string {
  let rest = text.trimStart();
  for (;;) {
    const before = rest;
    rest = rest
      .replace(
        /^(?:chapter|section|part)\b[\s.:)]*(?:[0-9]+|[ivxlcdm]+)?[\s.:)]*/i,
        '',
      )
      .replace(/^[^A-Za-z]+/, '');
    if (rest === before) return rest;
  }
}

function startsWithAdminHeading(text: string): boolean {
  const stripped = stripFrontMatterLead(text);
  const lower = stripped.toLowerCase();

  for (const heading of FRONT_MATTER_ADMIN_HEADINGS) {
    if (!lower.startsWith(heading)) continue;

    const after = stripped.slice(heading.length);
    if (after !== '' && /\p{L}/u.test(after[0])) continue;

    const nextWord = /^[^\p{L}]*([\p{L}]+)/u.exec(after)?.[1];
    if (
      nextWord !== undefined &&
      nextWord[0] === nextWord[0].toLowerCase() &&
      SENTENCE_CONTINUATIONS.has(nextWord.toLowerCase())
    ) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Only a strong publisher marker blocks a chunk. A lone
 * copyright-symbol-year hit never blocks; when a strong marker sits beside it,
 * that marker is what blocks.
 */
function hasStrongPublisherMarker(text: string): boolean {
  return (
    /\bisbn\b/i.test(text) ||
    /all rights reserved/i.test(text) ||
    /library of congress/i.test(text) ||
    /printed in the united states/i.test(text)
  );
}

/** Rules whose hit spreads to the other chunks on the same physical page. */
function spreadsAcrossPage(
  text: string,
  firstPage: number | null | undefined,
): boolean {
  if (firstPage === null || firstPage === undefined) return false;
  if (
    !Number.isInteger(firstPage) ||
    firstPage < 1 ||
    firstPage > FRONT_MATTER_SCAN_PAGES
  ) {
    return false;
  }

  const flat = text.replace(/\s+/g, ' ').trim();
  if (startsWithAdminHeading(flat)) return true;
  if (hasStrongPublisherMarker(flat)) return true;
  return isCredentialDense(flat);
}

function isCredentialDense(text: string): boolean {
  const credentials = (text.match(CREDENTIAL_TOKEN) ?? []).length;
  if (credentials >= CREDENTIAL_MIN) return true;
  if (credentials < CREDENTIAL_PAIR_MIN) return false;

  const affiliations = (text.match(AFFILIATION_MARKER) ?? []).length;
  return affiliations >= AFFILIATION_PAIR_MIN;
}

/**
 * Detects administrative front matter on the single-line text production
 * chunks really have. The page window alone never excludes a chunk.
 *
 * shortcut: thresholds are provisional; calibrate them on real chunks.
 */
export function classifyFrontMatter(
  text: string,
  firstPage: number | null | undefined,
): ChunkExclusionReason | null {
  if (firstPage === null || firstPage === undefined) return null;
  if (
    !Number.isInteger(firstPage) ||
    firstPage < 1 ||
    firstPage > FRONT_MATTER_SCAN_PAGES
  ) {
    return null;
  }

  const flat = text.replace(/\s+/g, ' ').trim();
  if (startsWithAdminHeading(flat)) return 'front-matter';
  if (hasStrongPublisherMarker(flat)) return 'front-matter';
  if (isCredentialDense(flat)) return 'front-matter';
  return null;
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
  const frontMatterReason = classifyFrontMatter(text, chunk.page);
  if (frontMatterReason !== null) {
    return { eligible: false, reason: frontMatterReason, state };
  }

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
  const results = sorted.map((chunk) => {
    const prior = states.get(chunk.documentId) ?? INITIAL_ELIGIBILITY_STATE;
    const result = classifyChunk(chunk, prior);
    states.set(chunk.documentId, result.state);
    return {
      chunk,
      eligible: result.eligible,
      ...(result.reason ? { reason: result.reason } : {}),
    };
  });

  // A page that is really front matter carries that over to its other chunks.
  // Only pages inside the scan window and only spreading rules qualify.
  const spreads = new Set<string>();
  for (const result of results) {
    if (result.reason !== 'front-matter') continue;
    if (!spreadsAcrossPage(result.chunk.content.trim(), result.chunk.page)) {
      continue;
    }
    spreads.add(`${result.chunk.documentId}:${result.chunk.page}`);
  }

  return results.map((result) => {
    if (!result.eligible) return result;
    if (!spreads.has(`${result.chunk.documentId}:${result.chunk.page}`)) {
      return result;
    }
    return {
      chunk: result.chunk,
      eligible: false,
      reason: 'front-matter' as const,
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

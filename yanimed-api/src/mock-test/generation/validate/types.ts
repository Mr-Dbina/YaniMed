/**
 * Shapes for Check A. This step only accepts or rejects a drafted question, so
 * the draft types are the contract the drafter (a later step) must satisfy.
 */

export interface DraftChoice {
  text: string;
  explanation: string;
}

export interface DraftCitation {
  documentId: string;
  /** Physical 1-based PDF page. */
  page: number;
  /** Page number printed in the book. Optional and never used for lookup. */
  printedPage?: number | null;
  quote: string;
}

export interface DraftQuestion {
  stem: string;
  /** Optional lead-in. null means the question has none. */
  leadIn: string | null;
  /** Exactly 4 entries. */
  choices: DraftChoice[];
  /** 0..3, the only defensible answer. */
  keyIndex: number;
  objective: string;
  keyExplanation: string;
  topicKey: string;
  citation: DraftCitation;
}

export interface CitationDocument {
  title: string;
  pageCount: number;
}

export interface CitationPage {
  text: string;
  needsOcr: boolean;
}

/**
 * Everything Check A needs from outside. Tests pass a plain object; the worker
 * will adapt the job snapshot and the page reader to this shape.
 */
export interface CheckAContext {
  topicKeys: Set<string>;
  documents: Map<string, CitationDocument>;
  getPage: (documentId: string, page: number) => CitationPage | null;
}

/** Stable reason codes. Callers branch on these, never on detail text. */
export const REASON_CODES = {
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  STEM_SENTENCE_COUNT: 'STEM_SENTENCE_COUNT',
  CHOICES_NOT_FOUR: 'CHOICES_NOT_FOUR',
  CHOICES_NOT_DISTINCT: 'CHOICES_NOT_DISTINCT',
  CHOICE_BANNED: 'CHOICE_BANNED',
  CHOICE_LENGTH_UNEVEN: 'CHOICE_LENGTH_UNEVEN',
  EXPLANATION_MISSING: 'EXPLANATION_MISSING',
  KEY_INDEX_INVALID: 'KEY_INDEX_INVALID',
  TOPIC_UNKNOWN: 'TOPIC_UNKNOWN',
  OBJECTIVE_MISSING: 'OBJECTIVE_MISSING',
  LETTER_PREFIX: 'LETTER_PREFIX',
  CITATION_DOCUMENT_NOT_IN_SNAPSHOT: 'CITATION_DOCUMENT_NOT_IN_SNAPSHOT',
  CITATION_PAGE_OUT_OF_RANGE: 'CITATION_PAGE_OUT_OF_RANGE',
  CITATION_PAGE_MISSING: 'CITATION_PAGE_MISSING',
  CITATION_QUOTE_NOT_FOUND: 'CITATION_QUOTE_NOT_FOUND',
  CHOICES_ALL_IN_STATED_RANGE: 'CHOICES_ALL_IN_STATED_RANGE',
  MARKUP_DETECTED: 'MARKUP_DETECTED',
  VERIFIER_KEY_MISMATCH: 'VERIFIER_KEY_MISMATCH',
  VERIFIER_OUTSIDE_KNOWLEDGE: 'VERIFIER_OUTSIDE_KNOWLEDGE',
  VERIFIER_AMBIGUOUS: 'VERIFIER_AMBIGUOUS',
  VERIFIER_QUOTE_UNVERIFIED: 'VERIFIER_QUOTE_UNVERIFIED',
  VERIFIER_INVALID_OUTPUT: 'VERIFIER_INVALID_OUTPUT',
  DUPLICATE_IN_JOB: 'DUPLICATE_IN_JOB',
  DUPLICATE_IN_BANK: 'DUPLICATE_IN_BANK',
  SAME_TOPIC_SAME_OBJECTIVE: 'SAME_TOPIC_SAME_OBJECTIVE',
  SAME_PAGE_SAME_FACT: 'SAME_PAGE_SAME_FACT',
  EMBEDDING_INVALID: 'EMBEDDING_INVALID',
  /** Check D: rules that only hold for the finished set of questions. */
  SET_COUNT_WRONG: 'SET_COUNT_WRONG',
  SET_DUPLICATE_ID: 'SET_DUPLICATE_ID',
  SET_STATUS_INVALID: 'SET_STATUS_INVALID',
  SET_TOO_FEW_TOPICS: 'SET_TOO_FEW_TOPICS',
  SET_TOPIC_CAP_EXCEEDED: 'SET_TOPIC_CAP_EXCEEDED',
  SET_CITATION_MISSING: 'SET_CITATION_MISSING',
  SET_CITATION_DOCUMENT_GONE: 'SET_CITATION_DOCUMENT_GONE',
  SET_CITATION_PAGE_OUT_OF_RANGE: 'SET_CITATION_PAGE_OUT_OF_RANGE',
  SET_EMBEDDING_INVALID: 'SET_EMBEDDING_INVALID',
  SET_DUPLICATE_PAIR: 'SET_DUPLICATE_PAIR',
  SET_SAME_TOPIC_SAME_OBJECTIVE: 'SET_SAME_TOPIC_SAME_OBJECTIVE',
} as const;

export type ReasonCode = (typeof REASON_CODES)[keyof typeof REASON_CODES];

export interface CheckAReason {
  code: ReasonCode;
  detail?: string;
}

/** A rejected draft from Check B. */
export interface CheckBReason {
  code: ReasonCode;
  detail?: string;
}

export type CheckAResult =
  { ok: true; draft: DraftQuestion } | { ok: false; reasons: CheckAReason[] };

export interface CitationCheckResult {
  ok: boolean;
  /** Best bigram-Dice score. 0 when the quote could not be scored. */
  similarity: number;
  /** 0.90 normally, 0.80 when the page needs OCR. */
  thresholdUsed: number;
  reasons: CheckAReason[];
}

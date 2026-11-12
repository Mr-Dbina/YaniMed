/**
 * Approved M5 generation limits. The question count comes from the engine so
 * there is exactly one definition of 25 in the codebase.
 */
export {
  CHOICES_PER_QUESTION,
  LETTER_MAX,
  LETTER_MIN,
  QUESTIONS_PER_TEST,
} from '../engine/types.js';

/** Coverage rules. */
export const MIN_DISTINCT_TOPICS = 13;
export const MAX_QUESTIONS_PER_TOPIC = 2;

/** Stem length. */
export const STEM_MIN_SENTENCES = 1;
export const STEM_MAX_SENTENCES = 6;

/** Duplicate detection. */
export const DUPLICATE_COSINE_THRESHOLD = 0.85;

/** Citation quote matching. OCR pages get a lower floor. */
export const CITATION_QUOTE_MATCH = 0.9;
export const CITATION_QUOTE_MATCH_OCR = 0.8;

/** Content gate: eligible chunks and distinct physical pages. */
export const MIN_ELIGIBLE_CHUNKS = 30;
export const MIN_DISTINCT_PAGES = 25;

/** AI budget and limits. Retries count as calls. */
export const AI_CALLS_PER_JOB = 400;
export const AI_DAILY_BUDGET = 1_500;
export const AI_DAILY_TIME_ZONE = 'Asia/Manila';
export const AI_CALL_TIMEOUT_MS = 60_000;
export const AI_CALL_RETRIES = 3;
export const BREAKER_FAILURE_THRESHOLD = 5;
export const BREAKER_COOLDOWN_MS = 60_000;

/** Job lifecycle. */
export const JOB_TIMEOUT_MS = 45 * 60_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const STALL_AFTER_MS = 120_000;

/**
 * Text heuristics. These are not product rules, but they must be stable so a
 * re-run classifies the same chunk the same way.
 */
export const MIN_ELIGIBLE_CHUNK_CHARS = 200;
export const HEADING_SCAN_LINES = 12;
export const PAGE_MATCH_MAX_CHARS = 20_000;

import {
  DUPLICATE_COSINE_THRESHOLD,
  DUPLICATE_EMBEDDING_DIMENSIONS,
} from '../generation.constants.js';
import { normalizeObjective } from '../text/normalize.js';
import { cosine } from '../text/similarity.js';
import { isSameFact, type FactFields } from './same-fact.js';
import { REASON_CODES, type DraftQuestion } from './types.js';

export interface AcceptedQuestionRef {
  key: string;
  embedding: number[];
  topicKey: string;
  objective: string;
  documentId: string;
  page: number;
  quote: string;
  keyChoiceText: string;
}

/** The subject's question bank, excluding questions of the current job. */
export interface BankSource {
  loadRefs(): Promise<AcceptedQuestionRef[]>;
}

export interface CheckCContext {
  jobId: string;
  subjectId?: string;
  accepted: AcceptedQuestionRef[];
  bank: BankSource;
  embed: (args: { jobId: string; text: string }) => Promise<number[]>;
  signal?: AbortSignal;
}

export interface CheckCReason {
  code: string;
  detail?: string;
}

export type CheckCResult =
  | {
      ok: true;
      embedding: number[];
      maxSimilarity: number;
      skippedBankRefs: number;
    }
  | {
      ok: false;
      embedding: number[] | null;
      reasons: CheckCReason[];
      skippedBankRefs: number;
    };

function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('Check C aborted.');
  error.name = 'AbortError';
  return error;
}

function isValidEmbedding(vector: unknown): vector is number[] {
  if (!Array.isArray(vector)) return false;
  if (vector.length !== DUPLICATE_EMBEDDING_DIMENSIONS) return false;

  let nonZero = false;
  for (const value of vector) {
    if (!Number.isFinite(value)) return false;
    if (value !== 0) nonZero = true;
  }
  return nonZero;
}

function invalidEmbeddingDetail(vector: unknown): string {
  const length = Array.isArray(vector) ? vector.length : -1;
  const nonFinite =
    Array.isArray(vector) && vector.some((value) => !Number.isFinite(value));
  const allZero =
    Array.isArray(vector) && vector.every((value) => value === 0);
  return `length ${length}; nonFinite ${nonFinite}; allZero ${allZero}`;
}

function factsOf(ref: AcceptedQuestionRef): FactFields {
  return {
    documentId: ref.documentId,
    page: ref.page,
    objective: ref.objective,
    quote: ref.quote,
    keyChoiceText: ref.keyChoiceText,
  };
}

function draftFacts(draft: DraftQuestion): FactFields {
  return {
    documentId: draft.citation.documentId,
    page: draft.citation.page,
    objective: draft.objective,
    quote: draft.citation.quote,
    keyChoiceText: draft.choices[draft.keyIndex]?.text ?? '',
  };
}

function sameTopicAndObjective(
  draft: DraftQuestion,
  ref: AcceptedQuestionRef,
): boolean {
  const topic = draft.topicKey.trim();
  const objective = normalizeObjective(draft.objective);
  return (
    topic !== '' &&
    objective !== '' &&
    topic === ref.topicKey.trim() &&
    objective === normalizeObjective(ref.objective)
  );
}

function duplicateDetail(ref: AcceptedQuestionRef, similarity: number): string {
  return `${ref.key} ${similarity.toFixed(4)}`;
}

/**
 * Check C: rejects a draft that repeats the job, the subject's bank, or the
 * same fact on the same page. The cheap checks run before the one embed call,
 * so a draft rejected without AI costs no budget.
 */
export async function checkDuplicates(
  draft: DraftQuestion,
  ctx: CheckCContext,
): Promise<CheckCResult> {
  const reasons: CheckCReason[] = [];
  // DraftQuestion has no key; accept one when a caller supplies it so a draft
  // that leaked into the accepted list can never compare with itself.
  const draftKey = (draft as DraftQuestion & { key?: string }).key;
  const facts = draftFacts(draft);

  let sameTopicObjective = false;
  for (const ref of ctx.accepted) {
    if (draftKey !== undefined && ref.key === draftKey) continue;

    if (sameTopicAndObjective(draft, ref)) sameTopicObjective = true;

    const fact = isSameFact(facts, factsOf(ref));
    if (fact.same) {
      reasons.push({
        code: REASON_CODES.SAME_PAGE_SAME_FACT,
        detail: `${ref.key} ${fact.reason}`,
      });
    }
  }

  if (sameTopicObjective) {
    reasons.push({ code: REASON_CODES.SAME_TOPIC_SAME_OBJECTIVE });
  }

  if (reasons.length > 0) {
    return { ok: false, embedding: null, reasons, skippedBankRefs: 0 };
  }

  if (ctx.signal?.aborted) throw abortError(ctx.signal);

  const embedding: unknown = await ctx.embed({
    jobId: ctx.jobId,
    text: `${draft.stem}\n${draft.leadIn ?? ''}`,
  });

  if (!isValidEmbedding(embedding)) {
    return {
      ok: false,
      embedding: null,
      reasons: [
        {
          code: REASON_CODES.EMBEDDING_INVALID,
          detail: invalidEmbeddingDetail(embedding),
        },
      ],
      skippedBankRefs: 0,
    };
  }

  const bankRefs = await ctx.bank.loadRefs();
  let maxSimilarity: number | null = null;
  let skippedBankRefs = 0;

  const compare = (ref: AcceptedQuestionRef): void => {
    const similarity = cosine(embedding, ref.embedding ?? []);
    maxSimilarity =
      maxSimilarity === null ? similarity : Math.max(maxSimilarity, similarity);
    // Raw floats, no rounding: exactly 0.85 rejects.
    if (similarity >= DUPLICATE_COSINE_THRESHOLD) {
      reasons.push({
        code: REASON_CODES.DUPLICATE_IN_JOB,
        detail: duplicateDetail(ref, similarity),
      });
    }
  };

  for (const ref of ctx.accepted) {
    if (draftKey !== undefined && ref.key === draftKey) continue;
    compare(ref);
  }

  for (const ref of bankRefs) {
    if (draftKey !== undefined && ref.key === draftKey) continue;
    const bankEmbedding = ref.embedding as number[] | null | undefined;
    if (
      !Array.isArray(bankEmbedding) ||
      bankEmbedding.length !== DUPLICATE_EMBEDDING_DIMENSIONS
    ) {
      skippedBankRefs += 1;
      continue;
    }

    const similarity = cosine(embedding, bankEmbedding);
    maxSimilarity =
      maxSimilarity === null ? similarity : Math.max(maxSimilarity, similarity);
    if (similarity >= DUPLICATE_COSINE_THRESHOLD) {
      reasons.push({
        code: REASON_CODES.DUPLICATE_IN_BANK,
        detail: duplicateDetail(ref, similarity),
      });
    }
  }

  const max = maxSimilarity ?? 0;

  if (reasons.length > 0) {
    return {
      ok: false,
      embedding,
      reasons,
      skippedBankRefs,
    };
  }

  return { ok: true, embedding, maxSimilarity: max, skippedBankRefs };
}

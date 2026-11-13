import {
  DUPLICATE_COSINE_THRESHOLD,
  DUPLICATE_EMBEDDING_DIMENSIONS,
  MAX_QUESTIONS_PER_TOPIC,
  MIN_DISTINCT_TOPICS,
  QUESTIONS_PER_TEST,
} from '../generation.constants.js';
import { normalizeObjective } from '../text/normalize.js';
import { cosine } from '../text/similarity.js';
import { REASON_CODES } from './types.js';

/**
 * Questions are written held and only a completed job publishes them. The
 * constant is repeated here so this module stays free of the persistence layer.
 */
export const SET_HELD_STATUS = 'QUARANTINED' as const;

/** Status that removes a question from the subject permanently. */
const RETIRED_STATUS = 'RETIRED';

export interface SetQuestionRef {
  questionId: string;
  status: string;
  topicKey: string;
  objective: string;
  embedding: number[] | null;
  citations: { documentId: string | null; page: number }[];
}

export interface CheckDContext {
  expectedCount: number;
  minTopics: number;
  maxPerTopic: number;
  snapshotDocumentIds: Set<string>;
  documentPageCounts: Map<string, number>;
  heldStatus: string;
  duplicateThreshold: number;
}

export interface CheckDReason {
  code: string;
  detail?: string;
  questionIds?: string[];
}

export type CheckDResult =
  | { ok: true; topicCount: number; maxSimilarity: number }
  | { ok: false; reasons: CheckDReason[] };

export function defaultCheckDContext(
  snapshotDocumentIds: Set<string>,
  documentPageCounts: Map<string, number>,
): CheckDContext {
  return {
    expectedCount: QUESTIONS_PER_TEST,
    minTopics: MIN_DISTINCT_TOPICS,
    maxPerTopic: MAX_QUESTIONS_PER_TOPIC,
    snapshotDocumentIds,
    documentPageCounts,
    heldStatus: SET_HELD_STATUS,
    duplicateThreshold: DUPLICATE_COSINE_THRESHOLD,
  };
}

function isValidEmbedding(vector: number[] | null): vector is number[] {
  if (!Array.isArray(vector)) return false;
  if (vector.length !== DUPLICATE_EMBEDDING_DIMENSIONS) return false;

  let nonZero = false;
  for (const value of vector) {
    if (!Number.isFinite(value)) return false;
    if (value !== 0) nonZero = true;
  }
  return nonZero;
}

function addOnce(ids: string[], seen: Set<string>, id: string): void {
  if (seen.has(id)) return;
  seen.add(id);
  ids.push(id);
}

/**
 * Check D: validates the finished set as a whole. Pure and report-only. Topic
 * keys are compared after trim and case-sensitively, so "Cardiology" and
 * "cardiology" are different topics. Objectives compare after normalizeObjective.
 */
export function validateSet(
  questions: SetQuestionRef[],
  ctx: CheckDContext,
): CheckDResult {
  const reasons: CheckDReason[] = [];

  if (questions.length !== ctx.expectedCount) {
    reasons.push({
      code: REASON_CODES.SET_COUNT_WRONG,
      detail: `expected ${ctx.expectedCount}, actual ${questions.length}`,
    });
  }

  const idSeen = new Set<string>();
  const duplicateIds: string[] = [];
  const duplicateIdSeen = new Set<string>();
  for (const question of questions) {
    if (idSeen.has(question.questionId)) {
      addOnce(duplicateIds, duplicateIdSeen, question.questionId);
    } else {
      idSeen.add(question.questionId);
    }
  }
  if (duplicateIds.length > 0) {
    reasons.push({
      code: REASON_CODES.SET_DUPLICATE_ID,
      questionIds: duplicateIds,
    });
  }

  const invalidStatusIds: string[] = [];
  const invalidStatusSeen = new Set<string>();
  for (const question of questions) {
    if (
      question.status !== ctx.heldStatus ||
      question.status === RETIRED_STATUS
    ) {
      addOnce(invalidStatusIds, invalidStatusSeen, question.questionId);
    }
  }
  if (invalidStatusIds.length > 0) {
    reasons.push({
      code: REASON_CODES.SET_STATUS_INVALID,
      questionIds: invalidStatusIds,
    });
  }

  const topics = new Map<string, string[]>();
  for (const question of questions) {
    const topicKey = question.topicKey.trim();
    const ids = topics.get(topicKey);
    if (ids === undefined) topics.set(topicKey, [question.questionId]);
    else ids.push(question.questionId);
  }

  const topicCount = topics.size;
  if (topicCount < ctx.minTopics) {
    reasons.push({
      code: REASON_CODES.SET_TOO_FEW_TOPICS,
      detail: `found ${topicCount}, required ${ctx.minTopics}`,
    });
  }

  for (const [topicKey, ids] of topics) {
    if (ids.length > ctx.maxPerTopic) {
      reasons.push({
        code: REASON_CODES.SET_TOPIC_CAP_EXCEEDED,
        detail: `${topicKey} ${ids.length}`,
        questionIds: [...ids],
      });
    }
  }

  const missingCitationIds: string[] = [];
  const missingCitationSeen = new Set<string>();
  const goneDocumentIds: string[] = [];
  const goneDocumentSeen = new Set<string>();
  const outOfRangePageIds: string[] = [];
  const outOfRangePageSeen = new Set<string>();

  for (const question of questions) {
    if (question.citations.length === 0) {
      addOnce(missingCitationIds, missingCitationSeen, question.questionId);
    }

    for (const citation of question.citations) {
      const documentId = citation.documentId;
      const pageCount =
        documentId === null ? undefined : ctx.documentPageCounts.get(documentId);
      if (
        documentId === null ||
        !ctx.snapshotDocumentIds.has(documentId) ||
        pageCount === undefined
      ) {
        addOnce(goneDocumentIds, goneDocumentSeen, question.questionId);
        continue;
      }

      if (
        !Number.isInteger(citation.page) ||
        citation.page < 1 ||
        citation.page > pageCount
      ) {
        addOnce(outOfRangePageIds, outOfRangePageSeen, question.questionId);
      }
    }
  }

  if (missingCitationIds.length > 0) {
    reasons.push({
      code: REASON_CODES.SET_CITATION_MISSING,
      questionIds: missingCitationIds,
    });
  }
  if (goneDocumentIds.length > 0) {
    reasons.push({
      code: REASON_CODES.SET_CITATION_DOCUMENT_GONE,
      questionIds: goneDocumentIds,
    });
  }
  if (outOfRangePageIds.length > 0) {
    reasons.push({
      code: REASON_CODES.SET_CITATION_PAGE_OUT_OF_RANGE,
      questionIds: outOfRangePageIds,
    });
  }

  const invalidEmbeddingIds: string[] = [];
  const invalidEmbeddingSeen = new Set<string>();
  for (const question of questions) {
    if (!isValidEmbedding(question.embedding)) {
      addOnce(
        invalidEmbeddingIds,
        invalidEmbeddingSeen,
        question.questionId,
      );
    }
  }
  if (invalidEmbeddingIds.length > 0) {
    reasons.push({
      code: REASON_CODES.SET_EMBEDDING_INVALID,
      questionIds: invalidEmbeddingIds,
    });
  }

  let maxSimilarity = 0;
  for (let left = 0; left < questions.length; left += 1) {
    const a = questions[left];
    const aEmbedding = a.embedding;
    const aObjective = normalizeObjective(a.objective);

    for (let right = left + 1; right < questions.length; right += 1) {
      const b = questions[right];

      if (
        a.topicKey.trim() === b.topicKey.trim() &&
        aObjective !== '' &&
        aObjective === normalizeObjective(b.objective)
      ) {
        reasons.push({
          code: REASON_CODES.SET_SAME_TOPIC_SAME_OBJECTIVE,
          questionIds: [a.questionId, b.questionId],
        });
      }

      if (!isValidEmbedding(aEmbedding) || !isValidEmbedding(b.embedding)) {
        continue;
      }

      const similarity = cosine(aEmbedding, b.embedding);
      if (similarity > maxSimilarity) maxSimilarity = similarity;
      // Raw floats, no rounding: exactly the threshold rejects.
      if (similarity >= ctx.duplicateThreshold) {
        reasons.push({
          code: REASON_CODES.SET_DUPLICATE_PAIR,
          detail: `${a.questionId} ${b.questionId} ${similarity.toFixed(4)}`,
          questionIds: [a.questionId, b.questionId],
        });
      }
    }
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, topicCount, maxSimilarity };
}

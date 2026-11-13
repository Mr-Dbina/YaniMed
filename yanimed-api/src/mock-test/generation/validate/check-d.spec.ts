import { describe, expect, it } from 'vitest';
import {
  DUPLICATE_COSINE_THRESHOLD,
  DUPLICATE_EMBEDDING_DIMENSIONS,
  MAX_QUESTIONS_PER_TOPIC,
  MIN_DISTINCT_TOPICS,
  QUESTIONS_PER_TEST,
} from '../generation.constants.js';
import {
  defaultCheckDContext,
  validateSet,
  type CheckDContext,
  type CheckDResult,
  type SetQuestionRef,
} from './check-d.js';
import { REASON_CODES } from './types.js';

const DIM = DUPLICATE_EMBEDDING_DIMENSIONS;

/** e0, the reference direction for every hand-made comparison. */
function basis(index: number): number[] {
  const vector = Array.from({ length: DIM }, () => 0);
  vector[index] = 1;
  return vector;
}

/** A unit vector with an exact cosine of `similarity` against {@link basis}. */
function vectorAt(similarity: number): number[] {
  const vector = Array.from({ length: DIM }, () => 0);
  vector[0] = similarity;
  vector[1] = Math.sqrt(1 - similarity * similarity);
  return vector;
}

function zeroes(): number[] {
  return Array.from({ length: DIM }, () => 0);
}

function makeQuestion(
  index: number,
  overrides: Partial<SetQuestionRef> = {},
): SetQuestionRef {
  return {
    questionId: `q-${index}`,
    status: 'QUARANTINED',
    topicKey: `topic-${index % MIN_DISTINCT_TOPICS}`,
    objective: `Objective ${index}.`,
    embedding: basis(index),
    citations: [{ documentId: 'doc-1', page: (index % 100) + 1 }],
    ...overrides,
  };
}

function validQuestions(): SetQuestionRef[] {
  return Array.from({ length: QUESTIONS_PER_TEST }, (_, index) =>
    makeQuestion(index),
  );
}

function makeContext(overrides: Partial<CheckDContext> = {}): CheckDContext {
  return {
    ...defaultCheckDContext(
      new Set(['doc-1', 'doc-2']),
      new Map([
        ['doc-1', 100],
        ['doc-2', 50],
      ]),
    ),
    ...overrides,
  };
}

function codes(result: CheckDResult): string[] {
  return result.ok ? [] : result.reasons.map((reason) => reason.code);
}

function reasonOf(result: CheckDResult, code: string) {
  if (result.ok) return undefined;
  return result.reasons.find((reason) => reason.code === code);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('defaultCheckDContext', () => {
  it('fills every default from the generation constants', () => {
    const ctx = defaultCheckDContext(new Set(), new Map());

    expect(ctx.expectedCount).toBe(QUESTIONS_PER_TEST);
    expect(ctx.minTopics).toBe(MIN_DISTINCT_TOPICS);
    expect(ctx.maxPerTopic).toBe(MAX_QUESTIONS_PER_TOPIC);
    expect(ctx.duplicateThreshold).toBe(DUPLICATE_COSINE_THRESHOLD);
    expect(ctx.heldStatus).toBe('QUARANTINED');
  });
});

describe('validateSet', () => {
  it('accepts a valid set of 25 questions across 13 topics', () => {
    const result = validateSet(validQuestions(), makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.topicCount).toBe(13);
      expect(result.maxSimilarity).toBe(0);
    }
  });

  it('rejects 24 questions with the expected and actual counts', () => {
    const questions = validQuestions().slice(0, 24);
    const result = validateSet(questions, makeContext());

    expect(codes(result)).toContain(REASON_CODES.SET_COUNT_WRONG);
    expect(reasonOf(result, REASON_CODES.SET_COUNT_WRONG)?.detail).toBe(
      'expected 25, actual 24',
    );
  });

  it('rejects 26 questions with the expected and actual counts', () => {
    const questions = [...validQuestions(), makeQuestion(25)];
    const result = validateSet(questions, makeContext());

    expect(reasonOf(result, REASON_CODES.SET_COUNT_WRONG)?.detail).toBe(
      'expected 25, actual 26',
    );
  });

  it('reports a duplicate question id once', () => {
    const questions = validQuestions();
    questions[1] = makeQuestion(1, { questionId: 'q-0' });
    const result = validateSet(questions, makeContext());

    expect(codes(result)).toEqual([REASON_CODES.SET_DUPLICATE_ID]);
    expect(reasonOf(result, REASON_CODES.SET_DUPLICATE_ID)?.questionIds).toEqual(
      ['q-0'],
    );
  });

  it('reports an ACTIVE and a RETIRED question', () => {
    const questions = validQuestions();
    questions[0] = makeQuestion(0, { status: 'ACTIVE' });
    questions[1] = makeQuestion(1, { status: 'RETIRED' });
    const result = validateSet(questions, makeContext());

    expect(reasonOf(result, REASON_CODES.SET_STATUS_INVALID)?.questionIds).toEqual(
      ['q-0', 'q-1'],
    );
  });

  it('rejects 12 distinct topics', () => {
    const questions = validQuestions().map((question, index) =>
      makeQuestion(index, { topicKey: `topic-${index % 12}` }),
    );
    const result = validateSet(
      questions,
      makeContext({ maxPerTopic: 3 }),
    );

    expect(codes(result)).toEqual([REASON_CODES.SET_TOO_FEW_TOPICS]);
    expect(reasonOf(result, REASON_CODES.SET_TOO_FEW_TOPICS)?.detail).toBe(
      'found 12, required 13',
    );
  });

  it('reports a topic with three questions and its ids', () => {
    const questions = validQuestions();
    questions[14] = makeQuestion(14, { topicKey: 'topic-0' });
    const result = validateSet(questions, makeContext());

    const reason = reasonOf(result, REASON_CODES.SET_TOPIC_CAP_EXCEEDED);
    expect(reason?.detail).toBe('topic-0 3');
    expect(reason?.questionIds).toEqual(['q-0', 'q-13', 'q-14']);
  });

  it('reports a question with zero citations', () => {
    const questions = validQuestions();
    questions[3] = makeQuestion(3, { citations: [] });
    const result = validateSet(questions, makeContext());

    expect(reasonOf(result, REASON_CODES.SET_CITATION_MISSING)?.questionIds).toEqual(
      ['q-3'],
    );
  });

  it('reports a citation with a null documentId', () => {
    const questions = validQuestions();
    questions[3] = makeQuestion(3, {
      citations: [{ documentId: null, page: 5 }],
    });
    const result = validateSet(questions, makeContext());

    expect(
      reasonOf(result, REASON_CODES.SET_CITATION_DOCUMENT_GONE)?.questionIds,
    ).toEqual(['q-3']);
  });

  it('reports a document outside the snapshot', () => {
    const questions = validQuestions();
    questions[3] = makeQuestion(3, {
      citations: [{ documentId: 'doc-gone', page: 5 }],
    });
    const result = validateSet(questions, makeContext());

    expect(
      reasonOf(result, REASON_CODES.SET_CITATION_DOCUMENT_GONE)?.questionIds,
    ).toEqual(['q-3']);
  });

  it('reports a snapshot document missing from the page-count map', () => {
    const questions = validQuestions();
    questions[3] = makeQuestion(3, {
      citations: [{ documentId: 'doc-2', page: 5 }],
    });
    const result = validateSet(
      questions,
      makeContext({ documentPageCounts: new Map([['doc-1', 100]]) }),
    );

    expect(
      reasonOf(result, REASON_CODES.SET_CITATION_DOCUMENT_GONE)?.questionIds,
    ).toEqual(['q-3']);
  });

  it('reports page 0 and a page above the document page count', () => {
    const questions = validQuestions();
    questions[3] = makeQuestion(3, {
      citations: [{ documentId: 'doc-1', page: 0 }],
    });
    questions[4] = makeQuestion(4, {
      citations: [{ documentId: 'doc-1', page: 101 }],
    });
    const result = validateSet(questions, makeContext());

    expect(
      reasonOf(result, REASON_CODES.SET_CITATION_PAGE_OUT_OF_RANGE)?.questionIds,
    ).toEqual(['q-3', 'q-4']);
  });

  it('accepts a citation list with one valid and one invalid entry, reporting only the invalid one', () => {
    const questions = validQuestions();
    questions[3] = makeQuestion(3, {
      citations: [
        { documentId: 'doc-1', page: 5 },
        { documentId: 'doc-gone', page: 5 },
      ],
    });
    const result = validateSet(questions, makeContext());

    expect(codes(result)).toEqual([REASON_CODES.SET_CITATION_DOCUMENT_GONE]);
    expect(
      reasonOf(result, REASON_CODES.SET_CITATION_DOCUMENT_GONE)?.questionIds,
    ).toEqual(['q-3']);
  });

  it('rejects a null embedding', () => {
    const questions = validQuestions();
    questions[2] = makeQuestion(2, { embedding: null });
    const result = validateSet(questions, makeContext());

    expect(reasonOf(result, REASON_CODES.SET_EMBEDDING_INVALID)?.questionIds).toEqual(
      ['q-2'],
    );
  });

  it('rejects a wrong-length embedding', () => {
    const questions = validQuestions();
    questions[2] = makeQuestion(2, {
      embedding: Array.from({ length: DIM - 1 }, () => 0.5),
    });
    const result = validateSet(questions, makeContext());

    expect(reasonOf(result, REASON_CODES.SET_EMBEDDING_INVALID)?.questionIds).toEqual(
      ['q-2'],
    );
  });

  it('rejects an embedding with a NaN entry', () => {
    const questions = validQuestions();
    const embedding = basis(2);
    embedding[5] = Number.NaN;
    questions[2] = makeQuestion(2, { embedding });
    const result = validateSet(questions, makeContext());

    expect(reasonOf(result, REASON_CODES.SET_EMBEDDING_INVALID)?.questionIds).toEqual(
      ['q-2'],
    );
  });

  it('rejects an all-zero embedding', () => {
    const questions = validQuestions();
    questions[2] = makeQuestion(2, { embedding: zeroes() });
    const result = validateSet(questions, makeContext());

    expect(reasonOf(result, REASON_CODES.SET_EMBEDDING_INVALID)?.questionIds).toEqual(
      ['q-2'],
    );
  });

  it('keeps comparing pairs when embeddings have different lengths', () => {
    const questions = validQuestions();
    questions[1] = makeQuestion(1, {
      embedding: Array.from({ length: DIM - 1 }, () => 0.5),
    });
    questions[7] = makeQuestion(7, { embedding: basis(0) });
    const result = validateSet(questions, makeContext());

    expect(codes(result)).toContain(REASON_CODES.SET_EMBEDDING_INVALID);
    expect(reasonOf(result, REASON_CODES.SET_DUPLICATE_PAIR)?.questionIds).toEqual([
      'q-0',
      'q-7',
    ]);
  });

  it('accepts a pair at cosine 0.84', () => {
    const questions = validQuestions();
    questions[1] = makeQuestion(1, { embedding: vectorAt(0.84) });
    const result = validateSet(questions, makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.maxSimilarity).toBeCloseTo(0.84, 10);
  });

  it('rejects a pair at cosine 0.85', () => {
    const questions = validQuestions();
    questions[1] = makeQuestion(1, { embedding: vectorAt(0.85) });
    const result = validateSet(questions, makeContext());

    const reason = reasonOf(result, REASON_CODES.SET_DUPLICATE_PAIR);
    expect(reason?.questionIds).toEqual(['q-0', 'q-1']);
    expect(reason?.detail).toContain('0.8500');
  });

  it('rejects two identical embeddings and reports similarity 1', () => {
    const questions = validQuestions();
    questions[1] = makeQuestion(1, { embedding: basis(0) });
    const result = validateSet(questions, makeContext());

    const reason = reasonOf(result, REASON_CODES.SET_DUPLICATE_PAIR);
    expect(reason?.questionIds).toEqual(['q-0', 'q-1']);
    expect(reason?.detail).toContain('1.0000');
  });

  it('reports the same topic with the same normalized objective', () => {
    const questions = validQuestions();
    questions[13] = makeQuestion(13, { objective: '  OBJECTIVE 0!!' });
    const result = validateSet(questions, makeContext());

    expect(codes(result)).toEqual([REASON_CODES.SET_SAME_TOPIC_SAME_OBJECTIVE]);
    expect(
      reasonOf(result, REASON_CODES.SET_SAME_TOPIC_SAME_OBJECTIVE)?.questionIds,
    ).toEqual(['q-0', 'q-13']);
  });

  it('treats topic keys differing by case as different topics', () => {
    const questions = validQuestions();
    questions[13] = makeQuestion(13, {
      topicKey: 'Topic-0',
      objective: 'Objective 0.',
    });
    const result = validateSet(questions, makeContext());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.topicCount).toBe(14);
  });

  it('collects every failure in one result', () => {
    const questions = validQuestions();
    questions[0] = makeQuestion(0, { status: 'ACTIVE' });
    questions[1] = makeQuestion(1, { citations: [] });
    questions[2] = makeQuestion(2, { embedding: zeroes() });
    questions[3] = makeQuestion(3, {
      citations: [{ documentId: 'doc-gone', page: 5 }],
    });
    questions[4] = makeQuestion(4, {
      citations: [{ documentId: 'doc-1', page: 0 }],
    });
    questions[5] = makeQuestion(5, {
      citations: [{ documentId: 'doc-1', page: 101 }],
    });
    questions[6] = makeQuestion(6, {
      topicKey: 'topic-0',
      objective: 'objective 0',
    });
    questions[7] = makeQuestion(7, { embedding: basis(0) });
    questions[8] = makeQuestion(8, { questionId: 'q-9' });
    const result = validateSet(questions, makeContext());

    expect(new Set(codes(result))).toEqual(
      new Set([
        REASON_CODES.SET_DUPLICATE_ID,
        REASON_CODES.SET_STATUS_INVALID,
        REASON_CODES.SET_TOPIC_CAP_EXCEEDED,
        REASON_CODES.SET_CITATION_MISSING,
        REASON_CODES.SET_CITATION_DOCUMENT_GONE,
        REASON_CODES.SET_CITATION_PAGE_OUT_OF_RANGE,
        REASON_CODES.SET_EMBEDDING_INVALID,
        REASON_CODES.SET_DUPLICATE_PAIR,
        REASON_CODES.SET_SAME_TOPIC_SAME_OBJECTIVE,
      ]),
    );
    expect(codes(result)).toHaveLength(9);
  });

  it('reports an empty set as the wrong count and too few topics', () => {
    const result = validateSet([], makeContext());

    expect(reasonOf(result, REASON_CODES.SET_COUNT_WRONG)?.detail).toBe(
      'expected 25, actual 0',
    );
    expect(codes(result)).toContain(REASON_CODES.SET_TOO_FEW_TOPICS);
  });

  it('does not mutate its inputs', () => {
    const questions = deepFreeze(validQuestions());
    const snapshot = structuredClone(questions);

    const result = validateSet(questions, makeContext());

    expect(result.ok).toBe(true);
    expect(questions).toEqual(snapshot);
  });

  it('does not include question text in reasons', () => {
    const questions = validQuestions();
    questions[6] = makeQuestion(6, {
      topicKey: 'topic-0',
      objective: 'A distinctive objective sentence.',
    });
    questions[13] = makeQuestion(13, {
      objective: 'A distinctive objective sentence.',
    });
    const result = validateSet(questions, makeContext());

    expect(reasonOf(result, REASON_CODES.SET_SAME_TOPIC_SAME_OBJECTIVE)?.detail).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { DUPLICATE_EMBEDDING_DIMENSIONS } from '../generation.constants.js';
import {
  checkDuplicates,
  type AcceptedQuestionRef,
  type BankSource,
  type CheckCContext,
  type CheckCResult,
} from './check-c.js';
import { REASON_CODES, type DraftQuestion } from './types.js';

const DIM = DUPLICATE_EMBEDDING_DIMENSIONS;

/** e0, the reference direction for every hand-made comparison. */
function basis(): number[] {
  const vector = Array.from({ length: DIM }, () => 0);
  vector[0] = 1;
  return vector;
}

/** A unit vector with an exact cosine of `similarity` against {@link basis}. */
function vectorAt(similarity: number): number[] {
  const vector = Array.from({ length: DIM }, () => 0);
  vector[0] = similarity;
  vector[1] = Math.sqrt(1 - similarity * similarity);
  return vector;
}

function makeDraft(overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    stem: 'Which drug is first-line for type 2 diabetes?',
    leadIn: null,
    choices: [
      { text: 'Metformin 500 mg', explanation: 'Choice A.' },
      { text: 'Insulin glargine', explanation: 'Choice B.' },
      { text: 'Glipizide', explanation: 'Choice C.' },
      { text: 'Diet alone', explanation: 'Choice D.' },
    ],
    keyIndex: 0,
    objective: 'Choose first-line drug therapy.',
    keyExplanation: 'Metformin is first-line.',
    topicKey: 'diabetes',
    citation: {
      documentId: 'doc-1',
      page: 10,
      quote: 'Metformin is first-line therapy for type 2 diabetes.',
    },
    ...overrides,
  };
}

function makeRef(
  key: string,
  embedding: number[],
  overrides: Partial<AcceptedQuestionRef> = {},
): AcceptedQuestionRef {
  return {
    key,
    embedding,
    topicKey: 'cardiology',
    objective: 'State the target heart rate.',
    documentId: 'doc-2',
    page: 20,
    quote: 'A different fact about heart rate control.',
    keyChoiceText: 'Target heart rate',
    ...overrides,
  };
}

interface FakeEmbed {
  embed: CheckCContext['embed'];
  calls: Array<{ jobId: string; text: string }>;
}

function fakeEmbed(result: number[] | Error): FakeEmbed {
  const calls: Array<{ jobId: string; text: string }> = [];
  const embed = async (args: {
    jobId: string;
    text: string;
  }): Promise<number[]> => {
    calls.push({ jobId: args.jobId, text: args.text });
    if (result instanceof Error) throw result;
    return result;
  };
  return { embed, calls };
}

interface FakeBank extends BankSource {
  calls: number;
}

function fakeBank(refs: AcceptedQuestionRef[]): FakeBank {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    loadRefs: async () => {
      calls += 1;
      return refs;
    },
  };
}

function makeContext(overrides: Partial<CheckCContext> = {}): CheckCContext {
  return {
    jobId: 'job-1',
    accepted: [],
    bank: fakeBank([]),
    embed: fakeEmbed(basis()).embed,
    ...overrides,
  };
}

function codes(result: CheckCResult): string[] {
  return result.ok ? [] : result.reasons.map((reason) => reason.code);
}

describe('checkDuplicates', () => {
  it('accepts a unique draft and returns its embedding after one call', async () => {
    const draft = makeDraft();
    const embed = fakeEmbed(basis());
    const bank = fakeBank([]);

    const result = await checkDuplicates(
      draft,
      makeContext({ embed: embed.embed, bank }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.embedding).toEqual(basis());
      expect(result.maxSimilarity).toBe(0);
      expect(result.skippedBankRefs).toBe(0);
    }
    expect(embed.calls).toEqual([
      { jobId: 'job-1', text: `${draft.stem}\n` },
    ]);
    expect(bank.calls).toBe(1);
  });

  it('accepts a cosine of 0.84 against an accepted question', async () => {
    const embed = fakeEmbed(vectorAt(0.84));
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({
        embed: embed.embed,
        accepted: [makeRef('accepted-1', basis())],
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.maxSimilarity).toBeCloseTo(0.84, 10);
    expect(codes(result)).toEqual([]);
  });

  it('rejects a cosine of 0.85 against an accepted question', async () => {
    const embed = fakeEmbed(vectorAt(0.85));
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({
        embed: embed.embed,
        accepted: [makeRef('accepted-1', basis())],
      }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(REASON_CODES.DUPLICATE_IN_JOB);
    if (!result.ok) expect(result.embedding).toEqual(vectorAt(0.85));
  });

  it('rejects a duplicate in the subject bank', async () => {
    const embed = fakeEmbed(basis());
    const bank = fakeBank([makeRef('bank-1', basis())]);
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({ embed: embed.embed, bank }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual([REASON_CODES.DUPLICATE_IN_BANK]);
    if (!result.ok) {
      expect(result.reasons[0].detail).toContain('bank-1');
      expect(result.reasons[0].detail).toContain('1.0000');
      expect(result.reasons[0].detail).not.toContain('Metformin');
    }
  });

  it('reports both a job duplicate and a bank duplicate', async () => {
    const embed = fakeEmbed(basis());
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({
        embed: embed.embed,
        accepted: [makeRef('accepted-1', basis())],
        bank: fakeBank([makeRef('bank-1', basis())]),
      }),
    );

    expect(codes(result)).toContain(REASON_CODES.DUPLICATE_IN_JOB);
    expect(codes(result)).toContain(REASON_CODES.DUPLICATE_IN_BANK);
  });

  it('rejects same topic and normalized objective without calling embed', async () => {
    const draft = makeDraft({
      objective: 'Choose  FIRST-line drug therapy!',
    });
    const embed = fakeEmbed(basis());
    const bank = fakeBank([]);
    const result = await checkDuplicates(
      draft,
      makeContext({
        embed: embed.embed,
        bank,
        accepted: [
          makeRef('accepted-1', basis(), {
            topicKey: 'diabetes',
            objective: 'choose first line drug therapy',
          }),
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual([REASON_CODES.SAME_TOPIC_SAME_OBJECTIVE]);
    expect(embed.calls).toHaveLength(0);
    expect(bank.calls).toBe(0);
  });

  it('rejects the same fact on the same page without calling embed', async () => {
    const embed = fakeEmbed(basis());
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({
        embed: embed.embed,
        accepted: [
          makeRef('accepted-1', basis(), {
            topicKey: 'cardiology',
            objective: 'State the target heart rate.',
            documentId: 'doc-1',
            page: 10,
            quote: 'Metformin is first-line therapy for type 2 diabetes.',
            keyChoiceText: 'Insulin glargine',
          }),
        ],
      }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual([REASON_CODES.SAME_PAGE_SAME_FACT]);
    expect(embed.calls).toHaveLength(0);
  });

  it('reports same-page fact and same-topic objective together', async () => {
    const embed = fakeEmbed(basis());
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({
        embed: embed.embed,
        accepted: [
          makeRef('accepted-1', basis(), {
            topicKey: 'diabetes',
            objective: 'Choose first-line drug therapy.',
            documentId: 'doc-1',
            page: 10,
            quote: 'Metformin is first-line therapy for type 2 diabetes.',
            keyChoiceText: 'Metformin 500 mg',
          }),
        ],
      }),
    );

    expect(codes(result)).toContain(REASON_CODES.SAME_PAGE_SAME_FACT);
    expect(codes(result)).toContain(REASON_CODES.SAME_TOPIC_SAME_OBJECTIVE);
    expect(embed.calls).toHaveLength(0);
  });

  it('rejects an embedding with the wrong length', async () => {
    const embed = fakeEmbed(Array.from({ length: DIM - 1 }, () => 0.5));
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({ embed: embed.embed }),
    );

    expect(result.ok).toBe(false);
    expect(codes(result)).toEqual([REASON_CODES.EMBEDDING_INVALID]);
    if (!result.ok) expect(result.embedding).toBeNull();
  });

  it('rejects an embedding with a NaN entry', async () => {
    const invalid = basis();
    invalid[5] = Number.NaN;
    const embed = fakeEmbed(invalid);
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({ embed: embed.embed }),
    );

    expect(codes(result)).toEqual([REASON_CODES.EMBEDDING_INVALID]);
    if (!result.ok) expect(result.embedding).toBeNull();
  });

  it('rejects an all-zero embedding', async () => {
    const embed = fakeEmbed(Array.from({ length: DIM }, () => 0));
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({ embed: embed.embed }),
    );

    expect(codes(result)).toEqual([REASON_CODES.EMBEDDING_INVALID]);
    if (!result.ok) expect(result.embedding).toBeNull();
  });

  it('skips and counts bank refs with null or wrong-dimension embeddings', async () => {
    const embed = fakeEmbed(basis());
    const bank = fakeBank([
      makeRef('bank-null', null as unknown as number[]),
      makeRef('bank-short', Array.from({ length: DIM - 1 }, () => 0.1)),
    ]);
    const result = await checkDuplicates(
      makeDraft(),
      makeContext({ embed: embed.embed, bank }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.skippedBankRefs).toBe(2);
  });

  it('propagates an embed error', async () => {
    const embed = fakeEmbed(new Error('budget exhausted'));
    await expect(
      checkDuplicates(makeDraft(), makeContext({ embed: embed.embed })),
    ).rejects.toThrow('budget exhausted');
    expect(embed.calls).toHaveLength(1);
  });

  it('throws the abort reason before embedding', async () => {
    const controller = new AbortController();
    const reason = new Error('job cancelled');
    controller.abort(reason);
    const embed = fakeEmbed(basis());

    await expect(
      checkDuplicates(
        makeDraft(),
        makeContext({ embed: embed.embed, signal: controller.signal }),
      ),
    ).rejects.toBe(reason);
    expect(embed.calls).toHaveLength(0);
  });
});

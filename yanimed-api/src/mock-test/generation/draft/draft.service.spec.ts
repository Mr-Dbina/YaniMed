import { describe, expect, it } from 'vitest';
import type {
  CompleteInput,
  CompleteResult,
  GenerationAiService,
} from '../ai/generation-ai.service.js';
import {
  DRAFT_REASON_CODES,
  draftQuestion,
  type DraftQuestionArgs,
} from './draft.service.js';
import { PROMPT_VERSION } from './prompt-version.js';
import type { SeedChunk } from './prompts.js';

const CHOICES = [
  { text: 'Metformin 500 mg', explanation: 'It is first-line therapy.' },
  { text: 'Insulin glargine', explanation: 'Insulin is added later.' },
  { text: 'Glipizide', explanation: 'Sulfonylureas are not first choice.' },
  { text: 'Diet alone', explanation: 'Lifestyle alone is not enough.' },
];

const CHUNKS: SeedChunk[] = [
  {
    chunkId: 'chunk-1',
    documentId: 'doc-1',
    documentTitle: 'Doc One',
    pageStart: 10,
    pageEnd: 11,
    text: 'Metformin is first-line therapy for type 2 diabetes.',
  },
  {
    chunkId: 'chunk-2',
    documentId: 'doc-2',
    documentTitle: 'Doc Two',
    pageStart: 12,
    pageEnd: 13,
    text: 'Insulin is added when glucose stays high.',
  },
];

const BASE = {
  stem: 'A 45-year-old adult has type 2 diabetes. Which starting treatment is first-line?',
  leadIn: null,
  choices: CHOICES,
  keyIndex: 1,
  objective: 'Choose first-line drug therapy for type 2 diabetes.',
  keyExplanation: 'Metformin is first-line per the cited page.',
  citation: {
    documentId: 'doc-1',
    page: 10,
    printedPage: 12,
    quote: 'Metformin is first-line therapy for type 2 diabetes.',
  },
};

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...BASE, ...overrides });
}

function args(overrides: Partial<DraftQuestionArgs> = {}): DraftQuestionArgs {
  return {
    jobId: 'job-1',
    subjectId: 'subject-1',
    subjectName: 'Endocrinology',
    topic: { topicKey: 'diabetes', name: 'Diabetes mellitus' },
    seedChunks: CHUNKS,
    acceptedObjectives: [],
    ...overrides,
  };
}

interface FakeAi {
  ai: Pick<GenerationAiService, 'complete'>;
  calls: CompleteInput[];
}

function fakeAi(...script: Array<string | Error>): FakeAi {
  const calls: CompleteInput[] = [];
  const complete = async (input: CompleteInput): Promise<CompleteResult> => {
    calls.push(input);
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    if (next instanceof Error) throw next;
    return {
      text: next,
      model: 'primary-model',
      tokensIn: null,
      tokensOut: null,
      latencyMs: 1,
    };
  };
  return { ai: { complete }, calls };
}

function reasonOf(result: Awaited<ReturnType<typeof draftQuestion>>): string {
  return result.ok ? 'OK' : result.reason;
}

describe('draftQuestion', () => {
  it('returns one valid draft from one call with model and prompt version', async () => {
    const fake = fakeAi(response());

    const result = await draftQuestion(args({ seedChunks: [CHUNKS[0]] }), fake.ai);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.stem).toBe(BASE.stem);
      expect(result.draft.leadIn).toBeNull();
      expect(result.draft.choices).toEqual(CHOICES);
      expect(result.draft.keyIndex).toBe(1);
      expect(result.draft.objective).toBe(BASE.objective);
      expect(result.draft.keyExplanation).toBe(BASE.keyExplanation);
      expect(result.draft.citation).toEqual(BASE.citation);
      expect(result.draft.topicKey).toBe('diabetes');
      expect(result.model).toBe('primary-model');
      expect(result.promptVersion).toBe(PROMPT_VERSION);
    }

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      purpose: 'DRAFT',
      jobId: 'job-1',
      subjectId: 'subject-1',
      temperature: 0.4,
      jsonMode: true,
    });
    expect(fake.calls[0].messages).toHaveLength(2);
  });

  it('accepts JSON wrapped in a markdown fence', async () => {
    const fake = fakeAi(`\`\`\`json\n${response()}\n\`\`\``);

    const result = await draftQuestion(args(), fake.ai);

    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
  });

  it('retries once after invalid JSON and accepts the second response', async () => {
    const fake = fakeAi('not json at all', response());

    const result = await draftQuestion(args(), fake.ai);

    expect(result.ok).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it('returns DRAFT_INVALID_JSON after two invalid responses', async () => {
    const fake = fakeAi('not json', 'still not json');

    const result = await draftQuestion(args(), fake.ai);

    expect(reasonOf(result)).toBe(DRAFT_REASON_CODES.DRAFT_INVALID_JSON);
    expect(result.model).toBe('primary-model');
    expect(result.promptVersion).toBe(PROMPT_VERSION);
    expect(fake.calls).toHaveLength(2);
  });

  it('returns DRAFT_SHAPE_INVALID when either response has three choices', async () => {
    const threeChoices = response({ choices: CHOICES.slice(0, 3) });
    const fake = fakeAi(threeChoices, threeChoices);

    const result = await draftQuestion(args(), fake.ai);

    expect(reasonOf(result)).toBe(DRAFT_REASON_CODES.DRAFT_SHAPE_INVALID);
    expect(fake.calls).toHaveLength(2);
  });

  it('rejects an out-of-range or string keyIndex as DRAFT_SHAPE_INVALID', async () => {
    for (const keyIndex of [4, -1, '2']) {
      const fake = fakeAi(response({ keyIndex }));
      const result = await draftQuestion(args(), fake.ai);

      expect(reasonOf(result)).toBe(DRAFT_REASON_CODES.DRAFT_SHAPE_INVALID);
      expect(fake.calls).toHaveLength(2);
    }
  });

  it('rejects a missing choice explanation as DRAFT_SHAPE_INVALID', async () => {
    const broken = [
      { text: 'Metformin 500 mg' },
      ...CHOICES.slice(1),
    ];
    const fake = fakeAi(
      response({ choices: broken }),
      response({ choices: broken }),
    );

    const result = await draftQuestion(args(), fake.ai);

    expect(reasonOf(result)).toBe(DRAFT_REASON_CODES.DRAFT_SHAPE_INVALID);
    expect(fake.calls).toHaveLength(2);
  });

  it('rejects a citation page outside every seed range without retrying', async () => {
    const fake = fakeAi(
      response({
        citation: {
          ...BASE.citation,
          page: 12,
        },
      }),
    );

    const result = await draftQuestion(
      args({ seedChunks: [CHUNKS[0]] }),
      fake.ai,
    );

    expect(reasonOf(result)).toBe(
      DRAFT_REASON_CODES.DRAFT_CITATION_NOT_IN_SEEDS,
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('rejects a page that belongs to another document seed without retrying', async () => {
    const fake = fakeAi(
      response({
        citation: {
          ...BASE.citation,
          documentId: 'doc-1',
          page: 12,
        },
      }),
    );

    const result = await draftQuestion(args(), fake.ai);

    expect(reasonOf(result)).toBe(
      DRAFT_REASON_CODES.DRAFT_CITATION_NOT_IN_SEEDS,
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('accepts a citation from the second document seed', async () => {
    const fake = fakeAi(
      response({
        citation: {
          documentId: 'doc-2',
          page: 12,
          printedPage: null,
          quote: 'Insulin is added when glucose stays high.',
        },
      }),
    );

    const result = await draftQuestion(args(), fake.ai);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.citation.documentId).toBe('doc-2');
    }
  });

  it('rejects a different non-empty topicKey without retrying', async () => {
    const fake = fakeAi(response({ topicKey: 'cardiology' }));

    const result = await draftQuestion(args(), fake.ai);

    expect(reasonOf(result)).toBe(DRAFT_REASON_CODES.DRAFT_TOPIC_MISMATCH);
    expect(fake.calls).toHaveLength(1);
  });

  it('accepts an absent or matching topicKey', async () => {
    for (const topicKey of [undefined, 'diabetes', '  ']) {
      const fake = fakeAi(response({ topicKey }));
      const result = await draftQuestion(args(), fake.ai);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.draft.topicKey).toBe('diabetes');
      expect(fake.calls).toHaveLength(1);
    }
  });

  it('propagates a budget error from complete()', async () => {
    const fake = fakeAi(new Error('budget exhausted'));

    await expect(draftQuestion(args(), fake.ai)).rejects.toThrow(
      'budget exhausted',
    );
    expect(fake.calls).toHaveLength(1);
  });

  it('passes the abort signal through to complete()', async () => {
    const controller = new AbortController();
    const fake = fakeAi(response());

    await draftQuestion(args({ signal: controller.signal }), fake.ai);

    expect(fake.calls[0].signal).toBe(controller.signal);
  });

  it('normalizes a missing printedPage to null', async () => {
    const fake = fakeAi(
      response({
        citation: {
          documentId: 'doc-1',
          page: 10,
          quote: BASE.citation.quote,
        },
      }),
    );

    const result = await draftQuestion(args(), fake.ai);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.citation.printedPage).toBeNull();
  });

  it('turns missing, null or empty leadIn into null', async () => {
    for (const leadIn of [undefined, null, '']) {
      const fake = fakeAi(response({ leadIn }));
      const result = await draftQuestion(args(), fake.ai);

      expect(result.ok).toBe(true);
      if (result.ok) expect(result.draft.leadIn).toBeNull();
    }
  });

  it('does not strip a letter prefix from a choice', async () => {
    const choices = CHOICES.map((choice, index) =>
      index === 0 ? { ...choice, text: 'A. Metformin 500 mg' } : choice,
    );
    const fake = fakeAi(response({ choices }));

    const result = await draftQuestion(args(), fake.ai);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft.choices[0].text).toBe('A. Metformin 500 mg');
  });
});

import { describe, expect, it } from 'vitest';
import type {
  CompleteInput,
  CompleteResult,
  GenerationAiService,
} from '../ai/generation-ai.service.js';
import { GenerationError } from '../generation.errors.js';
import { mismatchedVerdicts, verifyDraft } from './check-b.js';
import { REASON_CODES, type DraftQuestion } from './types.js';
import type { VerifierVerdict } from './verifier-prompt.js';

const PAGE =
  'Metformin is first-line therapy for type 2 diabetes. ' +
  'The usual starting dose is 500 mg twice daily. ' +
  'Insulin is added when glucose stays high.';

const Q_MET = 'Metformin is first-line therapy for type 2 diabetes.';
const Q_DOSE = 'The usual starting dose is 500 mg twice daily.';
const Q_INSULIN = 'Insulin is added when glucose stays high.';

const CHOICE_TEXTS = ['Metformin', 'Insulin', 'Glipizide', 'Diet alone'];

const NORMAL_STEM = 'Which of the following is a feature of metformin therapy?';
const NEGATED_STEM =
  'Which of the following is NOT a feature of metformin therapy?';

type Entry = [VerifierVerdict, string];

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
      model: 'verifier-model',
      tokensIn: null,
      tokensOut: null,
      latencyMs: 1,
    };
  };
  return { ai: { complete }, calls };
}

function response(
  entries: Entry[],
  flags: { needsOutsideKnowledge?: boolean; ambiguous?: boolean } = {},
): string {
  return JSON.stringify({
    verdicts: entries.map(([verdict, quote], index) => ({
      index,
      verdict,
      quote,
    })),
    needsOutsideKnowledge: flags.needsOutsideKnowledge ?? false,
    ambiguous: flags.ambiguous ?? false,
  });
}

function makeDraft(overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    stem: NORMAL_STEM,
    leadIn: null,
    choices: CHOICE_TEXTS.map((text, index) => ({
      text,
      explanation: `Explanation for choice ${index}.`,
    })),
    keyIndex: 0,
    objective: 'Choose the keyed fact about metformin.',
    keyExplanation: 'The page supports metformin as first-line.',
    topicKey: 'diabetes',
    citation: { documentId: 'doc-1', page: 1, quote: Q_MET },
    ...overrides,
  };
}

function verify(
  draft: DraftQuestion,
  ai: FakeAi['ai'],
  signal?: AbortSignal,
): ReturnType<typeof verifyDraft> {
  return verifyDraft(draft, PAGE, ai, { jobId: 'job-1', signal });
}

function codes(result: Awaited<ReturnType<typeof verifyDraft>>): string[] {
  return result.ok ? [] : result.reasons.map((reason) => reason.code);
}

describe('mismatchedVerdicts', () => {
  it('accepts a NORMAL key when the other choices are not SUPPORTED', () => {
    expect(
      mismatchedVerdicts('NORMAL', 0, [
        'SUPPORTED',
        'CONTRADICTED',
        'NOT_ADDRESSED',
        'NOT_ADDRESSED',
      ]),
    ).toEqual([]);
  });

  it('rejects a NORMAL key that is not SUPPORTED and any other SUPPORTED', () => {
    expect(
      mismatchedVerdicts('NORMAL', 0, [
        'NOT_ADDRESSED',
        'SUPPORTED',
        'SUPPORTED',
        'NOT_ADDRESSED',
      ]),
    ).toEqual([0, 1, 2]);
  });

  it('inverts the rule for NEGATED', () => {
    expect(
      mismatchedVerdicts('NEGATED', 2, [
        'SUPPORTED',
        'SUPPORTED',
        'CONTRADICTED',
        'SUPPORTED',
      ]),
    ).toEqual([]);
    expect(
      mismatchedVerdicts('NEGATED', 2, [
        'SUPPORTED',
        'SUPPORTED',
        'SUPPORTED',
        'SUPPORTED',
      ]),
    ).toEqual([2]);
  });
});

describe('verifyDraft NORMAL stems', () => {
  it('accepts the key when the page supports only it', async () => {
    const { ai, calls } = fakeAi(
      response([
        ['SUPPORTED', Q_MET],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    const result = await verify(makeDraft(), ai);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.polarity).toBe('NORMAL');
      expect(result.verdicts).toHaveLength(4);
      expect(result.verdicts[0].verdict).toBe('SUPPORTED');
    }
    expect(calls).toHaveLength(1);
  });

  it('rejects a wrong key and names the disagreeing indices only', async () => {
    const { ai } = fakeAi(
      response([
        ['NOT_ADDRESSED', ''],
        ['SUPPORTED', Q_INSULIN],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    const result = await verify(makeDraft(), ai);
    expect(codes(result)).toContain(REASON_CODES.VERIFIER_KEY_MISMATCH);
    const detail = result.ok ? '' : (result.reasons[0].detail ?? '');
    expect(detail).toContain('choices[0]');
    expect(detail).toContain('choices[1]');
    expect(JSON.stringify(result)).not.toContain(Q_INSULIN);
  });

  it('rejects when two choices are SUPPORTED', async () => {
    const { ai } = fakeAi(
      response([
        ['SUPPORTED', Q_MET],
        ['NOT_ADDRESSED', ''],
        ['SUPPORTED', Q_DOSE],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    const result = await verify(makeDraft(), ai);
    expect(codes(result)).toContain(REASON_CODES.VERIFIER_KEY_MISMATCH);
    if (!result.ok) {
      expect(result.reasons[0].detail).toBe('choices[2]');
    }
  });
});

describe('verifyDraft NEGATED stems', () => {
  it('accepts a keyed choice that the page contradicts', async () => {
    const { ai } = fakeAi(
      response([
        ['SUPPORTED', Q_MET],
        ['SUPPORTED', Q_INSULIN],
        ['CONTRADICTED', Q_DOSE],
        ['SUPPORTED', Q_MET],
      ]),
    );

    const result = await verify(makeDraft({ stem: NEGATED_STEM, keyIndex: 2 }), ai);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.polarity).toBe('NEGATED');
      expect(result.verdicts[2].verdict).toBe('CONTRADICTED');
    }
  });

  it('rejects when every choice is SUPPORTED including the key', async () => {
    const { ai } = fakeAi(
      response([
        ['SUPPORTED', Q_MET],
        ['SUPPORTED', Q_INSULIN],
        ['SUPPORTED', Q_DOSE],
        ['SUPPORTED', Q_MET],
      ]),
    );

    const result = await verify(makeDraft({ stem: NEGATED_STEM, keyIndex: 2 }), ai);
    expect(codes(result)).toContain(REASON_CODES.VERIFIER_KEY_MISMATCH);
    if (!result.ok) {
      expect(result.reasons[0].detail).toBe('choices[2]');
    }
  });
});

describe('verifyDraft flags', () => {
  it('rejects a verdict that needs outside knowledge', async () => {
    const { ai } = fakeAi(
      response(
        [
          ['SUPPORTED', Q_MET],
          ['NOT_ADDRESSED', ''],
          ['NOT_ADDRESSED', ''],
          ['NOT_ADDRESSED', ''],
        ],
        { needsOutsideKnowledge: true },
      ),
    );

    expect(codes(await verify(makeDraft(), ai))).toContain(
      REASON_CODES.VERIFIER_OUTSIDE_KNOWLEDGE,
    );
  });

  it('rejects an ambiguous page', async () => {
    const { ai } = fakeAi(
      response(
        [
          ['SUPPORTED', Q_MET],
          ['NOT_ADDRESSED', ''],
          ['NOT_ADDRESSED', ''],
          ['NOT_ADDRESSED', ''],
        ],
        { ambiguous: true },
      ),
    );

    expect(codes(await verify(makeDraft(), ai))).toContain(
      REASON_CODES.VERIFIER_AMBIGUOUS,
    );
  });

  it('collects every reason instead of stopping at the first', async () => {
    const { ai } = fakeAi(
      response(
        [
          ['NOT_ADDRESSED', ''],
          ['NOT_ADDRESSED', ''],
          ['NOT_ADDRESSED', ''],
          ['NOT_ADDRESSED', ''],
        ],
        { needsOutsideKnowledge: true, ambiguous: true },
      ),
    );

    const result = await verify(makeDraft(), ai);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        REASON_CODES.VERIFIER_KEY_MISMATCH,
        REASON_CODES.VERIFIER_OUTSIDE_KNOWLEDGE,
        REASON_CODES.VERIFIER_AMBIGUOUS,
      ]),
    );
  });
});

describe('verifyDraft quote checks', () => {
  it('downgrades a SUPPORTED verdict whose quote is not on the page', async () => {
    const { ai } = fakeAi(
      response([
        ['SUPPORTED', 'Aspirin is the preferred treatment for all adults.'],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    const result = await verify(makeDraft(), ai);
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        REASON_CODES.VERIFIER_QUOTE_UNVERIFIED,
        REASON_CODES.VERIFIER_KEY_MISMATCH,
      ]),
    );
    expect(JSON.stringify(result)).not.toContain('Aspirin');
  });

  it('downgrades a SUPPORTED verdict with an empty quote', async () => {
    const { ai } = fakeAi(
      response([
        ['SUPPORTED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    expect(codes(await verify(makeDraft(), ai))).toContain(
      REASON_CODES.VERIFIER_QUOTE_UNVERIFIED,
    );
  });

  it('accepts a quote that differs only in case, spacing and punctuation', async () => {
    const { ai } = fakeAi(
      response([
        ['SUPPORTED', '  metformin is FIRST-LINE therapy for type 2 diabetes  '],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    expect((await verify(makeDraft(), ai)).ok).toBe(true);
  });
});

describe('verifyDraft output parsing', () => {
  it('retries once after invalid JSON and accepts the second answer', async () => {
    const { ai, calls } = fakeAi(
      'not json at all',
      response([
        ['SUPPORTED', Q_MET],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    expect((await verify(makeDraft(), ai)).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('returns VERIFIER_INVALID_OUTPUT after two invalid answers', async () => {
    const { ai, calls } = fakeAi('not json', '{"verdicts":[]}');

    const result = await verify(makeDraft(), ai);
    expect(codes(result)).toEqual([REASON_CODES.VERIFIER_INVALID_OUTPUT]);
    expect(calls).toHaveLength(2);
  });

  it('rejects a lowercase verdict instead of coercing it', async () => {
    const { ai, calls } = fakeAi(
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: 'supported', quote: Q_MET },
          { index: 1, verdict: 'NOT_ADDRESSED', quote: '' },
          { index: 2, verdict: 'NOT_ADDRESSED', quote: '' },
          { index: 3, verdict: 'NOT_ADDRESSED', quote: '' },
        ],
        needsOutsideKnowledge: false,
        ambiguous: false,
      }),
    );

    expect(codes(await verify(makeDraft(), ai))).toEqual([
      REASON_CODES.VERIFIER_INVALID_OUTPUT,
    ]);
    expect(calls).toHaveLength(2);
  });

  it('ignores extra fields and tolerates a JSON fence', async () => {
    const body = JSON.parse(
      response([
        ['SUPPORTED', Q_MET],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    ) as Record<string, unknown>;
    body.model = 'verifier-v1';
    const { ai } = fakeAi(`\`\`\`json\n${JSON.stringify(body)}\n\`\`\``);

    expect((await verify(makeDraft(), ai)).ok).toBe(true);
  });
});

describe('verifyDraft provider contract', () => {
  it('propagates a budget error and does not retry it', async () => {
    const error = new GenerationError('GENERATION_BUDGET_EXHAUSTED', {
      jobId: 'job-1',
    });
    const { ai, calls } = fakeAi(error);

    await expect(verify(makeDraft(), ai)).rejects.toBe(error);
    expect(calls).toHaveLength(1);
  });

  it('propagates a provider outage', async () => {
    const error = new GenerationError('GENERATION_PROVIDER_UNAVAILABLE', {
      jobId: 'job-1',
    });
    const { ai } = fakeAi(error);
    await expect(verify(makeDraft(), ai)).rejects.toBe(error);
  });

  it('calls VERIFY with temperature 0, json mode and the caller signal', async () => {
    const controller = new AbortController();
    const { ai, calls } = fakeAi(
      response([
        ['SUPPORTED', Q_MET],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    await verify(makeDraft(), ai, controller.signal);
    expect(calls[0]).toMatchObject({
      purpose: 'VERIFY',
      jobId: 'job-1',
      temperature: 0,
      jsonMode: true,
      signal: controller.signal,
    });
  });

  it('never sends the key index, the objective or any explanation', async () => {
    const draft = makeDraft({
      keyIndex: 3,
      objective: 'OBJECTIVE_SENTINEL',
      keyExplanation: 'KEY_EXPLANATION_SENTINEL',
      choices: CHOICE_TEXTS.map((text, index) => ({
        text,
        explanation: `EXPLANATION_SENTINEL_${index}`,
      })),
    });
    const { ai, calls } = fakeAi(
      response([
        ['SUPPORTED', Q_MET],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    await verify(draft, ai);
    const sent = calls[0].messages.map((message) => message.content).join('\n');
    for (const sentinel of [
      'OBJECTIVE_SENTINEL',
      'KEY_EXPLANATION_SENTINEL',
      'EXPLANATION_SENTINEL_0',
      'EXPLANATION_SENTINEL_3',
      'keyIndex',
    ]) {
      expect(sent).not.toContain(sentinel);
    }
  });

  it('does not mutate the draft', async () => {
    const draft = makeDraft();
    const snapshot = JSON.parse(JSON.stringify(draft));
    const { ai } = fakeAi(
      response([
        ['SUPPORTED', Q_MET],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
        ['NOT_ADDRESSED', ''],
      ]),
    );

    await verify(draft, ai);
    expect(draft).toEqual(snapshot);
  });
});

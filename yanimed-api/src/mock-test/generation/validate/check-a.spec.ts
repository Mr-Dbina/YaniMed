import { describe, expect, it } from 'vitest';
import { validateDraft } from './check-a.js';
import {
  REASON_CODES,
  type CheckAContext,
  type CheckAResult,
  type DraftQuestion,
} from './types.js';

const PAGE_TEXT =
  'Metformin is first-line therapy for type 2 diabetes. ' +
  'The usual starting dose is 500 mg twice daily.';

const DOCUMENTS = new Map([
  ['doc-1', { title: 'Primary Care', pageCount: 12 }],
]);

function makeContext(pageText: string | null = PAGE_TEXT): CheckAContext {
  return {
    topicKeys: new Set(['diabetes']),
    documents: DOCUMENTS,
    getPage: (documentId, page) =>
      documentId === 'doc-1' && page === 1 && pageText !== null
        ? { text: pageText, needsOcr: false }
        : null,
  };
}

function validDraft(): DraftQuestion {
  return {
    stem: 'A 45-year-old adult has type 2 diabetes. Which starting treatment is first-line?',
    leadIn: 'A 45-year-old adult has type 2 diabetes.',
    choices: [
      {
        text: 'Metformin 500 mg twice daily',
        explanation: 'Metformin is first-line for type 2 diabetes.',
      },
      {
        text: 'Insulin glargine once daily',
        explanation: 'Insulin is added later, not first-line here.',
      },
      {
        text: 'Glipizide before meals',
        explanation: 'Sulfonylureas are not the first choice.',
      },
      {
        text: 'Diet and exercise alone',
        explanation: 'Lifestyle change alone is not enough at this stage.',
      },
    ],
    keyIndex: 0,
    objective: 'Choose first-line drug therapy for type 2 diabetes.',
    keyExplanation:
      'Metformin is first-line, as stated in Primary Care on page 1.',
    topicKey: 'diabetes',
    citation: {
      documentId: 'doc-1',
      page: 1,
      quote: 'Metformin is first-line therapy for type 2 diabetes.',
    },
  };
}

function validate(
  overrides: Record<string, unknown> = {},
  ctx: CheckAContext = makeContext(),
): CheckAResult {
  return validateDraft({ ...validDraft(), ...overrides }, ctx);
}

function codes(result: CheckAResult): string[] {
  return result.ok ? [] : result.reasons.map((reason) => reason.code);
}

function expectReason(result: CheckAResult, code: string): void {
  expect(result.ok).toBe(false);
  expect(codes(result)).toContain(code);
}

describe('validateDraft schema', () => {
  it('accepts a fully valid draft', () => {
    const result = validate();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.keyIndex).toBe(0);
      expect(result.draft.topicKey).toBe('diabetes');
    }
  });

  it('rejects null, undefined, arrays and primitives', () => {
    for (const value of [null, undefined, [], 'draft', 7]) {
      const result = validateDraft(value, makeContext());
      expectReason(result, REASON_CODES.SCHEMA_INVALID);
    }
  });

  it('rejects a numeric keyIndex given as a string', () => {
    const result = validate({ keyIndex: '1' });
    expectReason(result, REASON_CODES.SCHEMA_INVALID);
  });

  it('rejects a missing or non-string citation field', () => {
    expectReason(
      validate({ citation: { documentId: 'doc-1', page: 1 } }),
      REASON_CODES.SCHEMA_INVALID,
    );
    expectReason(
      validate({
        citation: { documentId: 'doc-1', page: '1', quote: 'x' },
      }),
      REASON_CODES.SCHEMA_INVALID,
    );
  });

  it('accepts extra unknown fields', () => {
    const result = validate({ model: 'drafter-v1', nested: { x: 1 } });
    expect(result.ok).toBe(true);
  });

  it('does not mutate the input and returns trimmed strings', () => {
    const draft = {
      ...validDraft(),
      stem: `  ${validDraft().stem}  `,
      leadIn: '',
      topicKey: '  diabetes  ',
      citation: {
        ...validDraft().citation,
        quote: `  ${validDraft().citation.quote}  `,
      },
    };
    const snapshot = JSON.parse(JSON.stringify(draft));
    const result = validateDraft(draft, makeContext());
    expect(draft).toEqual(snapshot);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.draft.stem).toBe(validDraft().stem);
      expect(result.draft.leadIn).toBeNull();
      expect(result.draft.topicKey).toBe('diabetes');
      expect(result.draft.citation.quote).toBe(validDraft().citation.quote);
    }
  });

  it('treats a null and an empty lead-in as none', () => {
    expect(validate({ leadIn: null }).ok).toBe(true);
    expect(validate({ leadIn: '' }).ok).toBe(true);
  });
});

describe('stem rules', () => {
  it('rejects a stem with 7 sentences', () => {
    const result = validate({
      stem: 'One. Two. Three. Four. Five. Six. Seven.',
    });
    expectReason(result, REASON_CODES.STEM_SENTENCE_COUNT);
  });

  it('rejects an empty stem', () => {
    expectReason(validate({ stem: '   ' }), REASON_CODES.STEM_SENTENCE_COUNT);
  });

  it('accepts exactly 1 and exactly 6 sentences', () => {
    expect(validate({ stem: 'Only one sentence here.' }).ok).toBe(true);
    expect(
      validate({
        stem: 'One. Two. Three. Four. Five. Six.',
      }).ok,
    ).toBe(true);
  });

  it('counts abbreviations, initials and decimals in one stem', () => {
    expect(
      validate({ stem: 'Dr. J. R. Smith took 2.5 mg of the drug.' }).ok,
    ).toBe(true);
  });
});

describe('choice rules', () => {
  it('rejects a draft without four choices', () => {
    const result = validate({
      choices: validDraft().choices.slice(0, 3),
    });
    expectReason(result, REASON_CODES.CHOICES_NOT_FOUR);
  });

  it('rejects duplicates after case and whitespace normalization', () => {
    const choices = validDraft().choices.map((choice, index) =>
      index === 1
        ? { ...choice, text: '  metformin 500 mg TWICE daily ' }
        : choice,
    );
    expectReason(validate({ choices }), REASON_CODES.CHOICES_NOT_DISTINCT);
  });

  it('rejects a choice letter prefix', () => {
    const choices = validDraft().choices.map((choice, index) =>
      index === 0 ? { ...choice, text: 'A. Metformin 500 mg' } : choice,
    );
    expectReason(validate({ choices }), REASON_CODES.LETTER_PREFIX);
  });

  it('rejects all, none and both of the above', () => {
    for (const banned of [
      'All of the above',
      'None of the above',
      'Both of the above',
    ]) {
      const choices = validDraft().choices.map((choice, index) =>
        index === 3 ? { ...choice, text: banned } : choice,
      );
      expectReason(validate({ choices }), REASON_CODES.CHOICE_BANNED);
    }
  });

  it('rejects a choice more than 5x longer than the shortest', () => {
    const texts = ['Fever', 'Cough', 'Rash', 'A very long choice text here'];
    const choices = validDraft().choices.map((choice, index) => ({
      ...choice,
      text: texts[index],
    }));
    expectReason(validate({ choices }), REASON_CODES.CHOICE_LENGTH_UNEVEN);
  });

  it('ignores choices under 4 characters when comparing lengths', () => {
    const texts = ['Fever', 'Cough', 'OK', 'A long option text here'];
    const choices = validDraft().choices.map((choice, index) => ({
      ...choice,
      text: texts[index],
    }));
    expect(validate({ choices }).ok).toBe(true);
  });

  it('rejects a missing key or distractor explanation', () => {
    const choices = validDraft().choices.map((choice, index) =>
      index === 2 ? { ...choice, explanation: '   ' } : choice,
    );
    const result = validate({ choices, keyExplanation: '' });
    expectReason(result, REASON_CODES.EXPLANATION_MISSING);
    expect(JSON.stringify(result)).toContain('choices[2].explanation');
    expect(JSON.stringify(result)).toContain('keyExplanation');
  });

  it('rejects keyIndex outside 0..3 and non-integers', () => {
    for (const keyIndex of [4, -1, 1.5]) {
      expectReason(validate({ keyIndex }), REASON_CODES.KEY_INDEX_INVALID);
    }
  });
});

describe('topic and objective rules', () => {
  it('rejects a topic outside the plan', () => {
    expectReason(
      validate({ topicKey: 'not-in-plan' }),
      REASON_CODES.TOPIC_UNKNOWN,
    );
  });

  it('rejects an empty objective', () => {
    expectReason(validate({ objective: '  ' }), REASON_CODES.OBJECTIVE_MISSING);
  });
});

describe('markup', () => {
  it('rejects a script tag in the stem', () => {
    expectReason(
      validate({ stem: '<script>alert(1)</script>' }),
      REASON_CODES.MARKUP_DETECTED,
    );
  });

  it('rejects an HTML tag in a choice', () => {
    const choices = validDraft().choices.map((choice, index) =>
      index === 0 ? { ...choice, text: '<b>x</b>' } : choice,
    );
    expectReason(validate({ choices }), REASON_CODES.MARKUP_DETECTED);
  });

  it('accepts plain comparison brackets', () => {
    expect(
      validate({
        objective: 'Give <5 mg or >10 mg depending on weight.',
      }).ok,
    ).toBe(true);
  });

  it('rejects a javascript: URL in an explanation', () => {
    const choices = validDraft().choices.map((choice, index) =>
      index === 0
        ? { ...choice, explanation: 'See javascript:alert(1)' }
        : choice,
    );
    expectReason(validate({ choices }), REASON_CODES.MARKUP_DETECTED);
  });
});

describe('citation reasons through Check A', () => {
  it('rejects a document that is not in the snapshot', () => {
    expectReason(
      validate({
        citation: { ...validDraft().citation, documentId: 'doc-x' },
      }),
      REASON_CODES.CITATION_DOCUMENT_NOT_IN_SNAPSHOT,
    );
  });

  it('rejects page 0 and a page above pageCount', () => {
    for (const page of [0, 13]) {
      expectReason(
        validate({
          citation: { ...validDraft().citation, page },
        }),
        REASON_CODES.CITATION_PAGE_OUT_OF_RANGE,
      );
    }
  });

  it('rejects a page with no text', () => {
    expectReason(
      validate({
        citation: { ...validDraft().citation, page: 2 },
      }),
      REASON_CODES.CITATION_PAGE_MISSING,
    );
  });

  it('rejects a quote that is not on the page', () => {
    expectReason(
      validate({
        citation: {
          ...validDraft().citation,
          quote: 'Completely unrelated sentence about insulin.',
        },
      }),
      REASON_CODES.CITATION_QUOTE_NOT_FOUND,
    );
  });
});

describe('choices all in a stated range', () => {
  const RANGE_TEXT = 'The dose ranges between 8 and 20 mg daily.';

  function numericDraft(texts: string[]): Record<string, unknown> {
    const choices = validDraft().choices.map((choice, index) => ({
      ...choice,
      text: texts[index],
    }));
    return {
      choices,
      citation: {
        documentId: 'doc-1',
        page: 1,
        quote: RANGE_TEXT,
      },
    };
  }

  it('rejects when one stated range encloses all four numbers', () => {
    expectReason(
      validate(
        numericDraft(['10 mg', '12 mg', '14 mg', '16 mg']),
        makeContext(RANGE_TEXT),
      ),
      REASON_CODES.CHOICES_ALL_IN_STATED_RANGE,
    );
  });

  it('rejects with a unicode en dash range', () => {
    const text = 'Adults take 10\u201320 mg daily.';
    expectReason(
      validate(
        numericDraft(['10 mg', '12 mg', '14 mg', '16 mg']),
        makeContext(text),
      ),
      REASON_CODES.CHOICES_ALL_IN_STATED_RANGE,
    );
  });

  it('accepts when one choice has no number', () => {
    expect(
      validate(
        numericDraft(['10 mg', '12 mg', '14 mg', 'As needed']),
        makeContext(RANGE_TEXT),
      ).ok,
    ).toBe(true);
  });

  it('accepts when the range does not enclose all four', () => {
    expect(
      validate(
        numericDraft(['10 mg', '12 mg', '14 mg', '26 mg']),
        makeContext(RANGE_TEXT),
      ).ok,
    ).toBe(true);
  });
});

describe('multiple reasons and stable codes', () => {
  it('collects several reasons at once', () => {
    const result = validate({
      stem: 'One. Two. Three. Four. Five. Six. Seven.',
      keyIndex: 9,
      topicKey: 'not-in-plan',
    });
    expect(codes(result)).toEqual(
      expect.arrayContaining([
        REASON_CODES.STEM_SENTENCE_COUNT,
        REASON_CODES.KEY_INDEX_INVALID,
        REASON_CODES.TOPIC_UNKNOWN,
      ]),
    );
  });

  it('exports stable reason codes', () => {
    expect(REASON_CODES.STEM_SENTENCE_COUNT).toBe('STEM_SENTENCE_COUNT');
    expect(REASON_CODES.CHOICES_ALL_IN_STATED_RANGE).toBe(
      'CHOICES_ALL_IN_STATED_RANGE',
    );
  });
});

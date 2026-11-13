import { describe, expect, it } from 'vitest';
import {
  isSameFact,
  quoteDice,
  SAME_FACT_REASONS,
  type FactFields,
} from './same-fact.js';

function fields(overrides: Partial<FactFields> = {}): FactFields {
  return {
    documentId: 'doc-1',
    page: 10,
    objective: 'Identify first-line drug therapy.',
    quote: 'Metformin is first-line therapy for type 2 diabetes.',
    keyChoiceText: 'Metformin 500 mg',
    ...overrides,
  };
}

const QUOTE_A = 'a'.repeat(101);
/** 59 shared 'aa' bigrams out of 200: Dice = 0.59. */
const QUOTE_59 = 'a'.repeat(60) + 'b'.repeat(41);
/** 61 shared 'aa' bigrams out of 200: Dice = 0.61. */
const QUOTE_61 = 'a'.repeat(62) + 'b'.repeat(39);

describe('isSameFact', () => {
  it('flags the same page with the same normalized objective', () => {
    const result = isSameFact(
      fields({ objective: 'Choose  FIRST-line therapy!' }),
      fields({
        objective: 'choose first line therapy',
        quote: 'A different sentence about insulin.',
        keyChoiceText: 'Insulin glargine',
      }),
    );
    expect(result).toEqual({
      same: true,
      reason: SAME_FACT_REASONS.SAME_OBJECTIVE,
    });
  });

  it('does not flag the same page with a different fact', () => {
    const result = isSameFact(
      fields({ quote: 'Metformin is first-line therapy for type 2 diabetes.' }),
      fields({
        objective: 'State the insulin starting dose.',
        quote: 'Insulin is started at ten units nightly.',
        keyChoiceText: 'Ten units nightly',
      }),
    );
    expect(result.same).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('does not flag the same objective on a different page', () => {
    const result = isSameFact(
      fields({ page: 10 }),
      fields({ page: 11, quote: 'A different sentence.' }),
    );
    expect(result.same).toBe(false);
  });

  it('does not flag the same page number in a different document', () => {
    const result = isSameFact(
      fields({ documentId: 'doc-1' }),
      fields({ documentId: 'doc-2', quote: 'A different sentence.' }),
    );
    expect(result.same).toBe(false);
  });

  it('does not flag a quote Dice score of 0.59', () => {
    expect(quoteDice(QUOTE_A, QUOTE_59)).toBeCloseTo(0.59, 10);
    const result = isSameFact(
      fields({ quote: QUOTE_A, keyChoiceText: 'alpha' }),
      fields({
        quote: QUOTE_59,
        objective: 'State the insulin dose.',
        keyChoiceText: 'beta',
      }),
    );
    expect(result.same).toBe(false);
  });

  it('flags a quote Dice score of 0.61', () => {
    expect(quoteDice(QUOTE_A, QUOTE_61)).toBeCloseTo(0.61, 10);
    const result = isSameFact(
      fields({ quote: QUOTE_A, keyChoiceText: 'alpha' }),
      fields({
        quote: QUOTE_61,
        objective: 'State the insulin dose.',
        keyChoiceText: 'beta',
      }),
    );
    expect(result).toEqual({
      same: true,
      reason: SAME_FACT_REASONS.QUOTE_MATCH,
    });
  });

  it('does not treat an identical key text under 6 characters as enough', () => {
    const result = isSameFact(
      fields({ keyChoiceText: 'abc', quote: QUOTE_A }),
      fields({
        keyChoiceText: 'abc',
        quote: QUOTE_59,
        objective: 'State the insulin dose.',
      }),
    );
    expect(result.same).toBe(false);
  });

  it('flags an identical non-trivial normalized key text', () => {
    const result = isSameFact(
      fields({ keyChoiceText: 'Metformin 500 mg', quote: QUOTE_A }),
      fields({
        keyChoiceText: 'metformin, 500 MG',
        quote: QUOTE_59,
        objective: 'State the insulin dose.',
      }),
    );
    expect(result).toEqual({
      same: true,
      reason: SAME_FACT_REASONS.KEY_CHOICE_MATCH,
    });
  });
});

describe('quoteDice', () => {
  it('returns 0 when either quote is empty after normalization', () => {
    expect(quoteDice('', 'metformin')).toBe(0);
    expect(quoteDice('---', 'metformin')).toBe(0);
  });
});

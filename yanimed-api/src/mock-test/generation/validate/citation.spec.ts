import { describe, expect, it } from 'vitest';
import { verifyCitation } from './citation.js';
import {
  REASON_CODES,
  type CheckAContext,
  type DraftCitation,
} from './types.js';

const PAGE_TEXT =
  'Metformin is first-line therapy for type 2 diabetes. ' +
  'The usual starting dose is 500 mg twice daily.';

const NEAR_PAGE_TEXT =
  'Amoxicillin 500 mg is given every eight hours for seven days in adults with pneumonia.';
// Bigram-Dice score of this quote against NEAR_PAGE_TEXT is about 0.87.
const NEAR_QUOTE =
  'Amoxicillin 500 mg is given every eight hours for ten days in adults with bronchitis.';

const DOCUMENTS = new Map([
  ['doc-1', { title: 'Primary Care', pageCount: 12 }],
]);

function context(
  pages: Record<number, { text: string; needsOcr: boolean } | null>,
): CheckAContext {
  return {
    topicKeys: new Set(['diabetes']),
    documents: DOCUMENTS,
    getPage: (documentId, page) =>
      documentId === 'doc-1' ? (pages[page] ?? null) : null,
  };
}

function pageContext(
  text: string = PAGE_TEXT,
  needsOcr = false,
): CheckAContext {
  return context({ 1: { text, needsOcr } });
}

function citation(overrides: Partial<DraftCitation> = {}): DraftCitation {
  return {
    documentId: 'doc-1',
    page: 1,
    quote: 'Metformin is first-line therapy for type 2 diabetes.',
    ...overrides,
  };
}

function codes(result: { reasons: { code: string }[] }): string[] {
  return result.reasons.map((reason) => reason.code);
}

describe('verifyCitation', () => {
  it('accepts an exact quote at similarity 1 and threshold 0.9', () => {
    const result = verifyCitation(citation(), pageContext());
    expect(result.ok).toBe(true);
    expect(result.similarity).toBe(1);
    expect(result.thresholdUsed).toBe(0.9);
    expect(result.reasons).toEqual([]);
  });

  it('accepts the same quote with different case and whitespace', () => {
    const result = verifyCitation(
      citation({
        quote: '  metformin   IS first-line   therapy for type 2 diabetes. ',
      }),
      pageContext(),
    );
    expect(result.ok).toBe(true);
    expect(result.similarity).toBe(1);
  });

  it('rejects a quote that is on another page', () => {
    const result = verifyCitation(
      citation(),
      context({
        1: {
          text: 'Insulin is a hormone produced by the pancreas.',
          needsOcr: false,
        },
        2: { text: PAGE_TEXT, needsOcr: false },
      }),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(REASON_CODES.CITATION_QUOTE_NOT_FOUND);
    expect(result.similarity).toBeLessThan(0.9);
  });

  it('accepts a near quote at 0.87 on an OCR page with threshold 0.8', () => {
    const result = verifyCitation(
      citation({ quote: NEAR_QUOTE }),
      pageContext(NEAR_PAGE_TEXT, true),
    );
    expect(result.ok).toBe(true);
    expect(result.thresholdUsed).toBe(0.8);
    expect(result.similarity).toBeGreaterThanOrEqual(0.8);
    expect(result.similarity).toBeLessThan(0.9);
  });

  it('rejects the same near quote on a normal page', () => {
    const result = verifyCitation(
      citation({ quote: NEAR_QUOTE }),
      pageContext(NEAR_PAGE_TEXT, false),
    );
    expect(result.ok).toBe(false);
    expect(result.thresholdUsed).toBe(0.9);
    expect(codes(result)).toContain(REASON_CODES.CITATION_QUOTE_NOT_FOUND);
  });

  it('rejects page 0', () => {
    const result = verifyCitation(citation({ page: 0 }), pageContext());
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(REASON_CODES.CITATION_PAGE_OUT_OF_RANGE);
  });

  it('rejects a page above the document page count', () => {
    const result = verifyCitation(citation({ page: 13 }), pageContext());
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(REASON_CODES.CITATION_PAGE_OUT_OF_RANGE);
  });

  it('rejects a non-integer page', () => {
    const result = verifyCitation(citation({ page: 1.5 }), pageContext());
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(REASON_CODES.CITATION_PAGE_OUT_OF_RANGE);
  });

  it('rejects a document that is not in the snapshot', () => {
    const result = verifyCitation(
      citation({ documentId: 'doc-missing' }),
      pageContext(),
    );
    expect(result.ok).toBe(false);
    expect(result.similarity).toBe(0);
    expect(codes(result)).toContain(
      REASON_CODES.CITATION_DOCUMENT_NOT_IN_SNAPSHOT,
    );
  });

  it('rejects a null page and an empty page', () => {
    const nullPage = verifyCitation(citation(), context({ 1: null }));
    const emptyPage = verifyCitation(
      citation(),
      context({ 1: { text: '   ', needsOcr: false } }),
    );
    expect(codes(nullPage)).toContain(REASON_CODES.CITATION_PAGE_MISSING);
    expect(codes(emptyPage)).toContain(REASON_CODES.CITATION_PAGE_MISSING);
  });

  it('rejects an empty quote', () => {
    const result = verifyCitation(citation({ quote: '  ' }), pageContext());
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(REASON_CODES.CITATION_QUOTE_NOT_FOUND);
  });

  it('ignores printedPage', () => {
    const result = verifyCitation(citation({ printedPage: 99 }), pageContext());
    expect(result.ok).toBe(true);
  });

  it('finds a quote inside the 20,000-char page cap', () => {
    const filler =
      'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(600);
    const result = verifyCitation(
      citation({ quote: 'The target sentence is here.' }),
      pageContext(`The target sentence is here. ${filler}`),
    );
    expect(result.ok).toBe(true);
  });

  it('does not find a quote that starts after the 20,000-char cap', () => {
    const filler =
      'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(600);
    const result = verifyCitation(
      citation({ quote: 'The target sentence is here.' }),
      pageContext(`${filler} The target sentence is here.`),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain(REASON_CODES.CITATION_QUOTE_NOT_FOUND);
  });
});

import { describe, expect, it } from 'vitest';
import {
  classifyChunk,
  classifyChunks,
  evaluateGate,
  type ChunkInput,
} from './eligibility.js';

const NORMAL =
  'Neonatal jaundice is common in the first week of life. ' +
  'A total serum bilirubin should be measured when the clinical level is unclear. ' +
  'Treatment depends on age, gestation and the bilirubin trend over time.';

/** The production shape: no line breaks anywhere in a chunk. */
const CONTRIBUTOR_DENSE =
  'Pediatric faculty Jane Smith MD, John Doe MD, Alice Brown MD, ' +
  'Bob Green MD, Carol White MD, David Black MD. ' +
  NORMAL;

const PAIR_DENSE =
  'Pediatric faculty Jane Smith MD, John Doe MD, Alice Brown MD. ' +
  'University Hospital, Department of Pediatrics, School of Medicine. ' +
  NORMAL;

const ADMIN_HEADINGS = [
  'table of contents',
  'contents',
  'dedication',
  'acknowledgement',
  'acknowledgements',
  'acknowledgment',
  'acknowledgments',
  'preface',
  'foreword',
  'list of contributors',
  'contributors',
  'contributing authors',
  'editorial board',
  'editors',
  'title page',
  'copyright',
] as const;

function makeChunk(overrides: Partial<ChunkInput> = {}): ChunkInput {
  return {
    documentId: 'doc-1',
    content: NORMAL,
    page: 1,
    chunkIndex: 0,
    needsReview: false,
    ...overrides,
  };
}

function eligibleChunk(index: number, page = index + 1): ChunkInput {
  return makeChunk({
    documentId: `doc-${Math.floor(index / 30)}`,
    page,
    chunkIndex: index,
  });
}

describe('classifyChunk', () => {
  it('accepts a normal teaching chunk', () => {
    const result = classifyChunk(makeChunk());
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('always excludes needsReview chunks', () => {
    const result = classifyChunk(makeChunk({ needsReview: true }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('needs-review');
  });

  it('excludes very short chunks', () => {
    const result = classifyChunk(makeChunk({ content: 'Too short.' }));
    expect(result.reason).toBe('short');
  });

  it('excludes contents, dedication and acknowledgements headings', () => {
    const body = `${NORMAL} ${NORMAL}`;
    expect(
      classifyChunk(makeChunk({ content: `Contents\n${body}` })).reason,
    ).toBe('front-matter');
    expect(
      classifyChunk(makeChunk({ content: `Dedication\n${body}` })).reason,
    ).toBe('front-matter');
    expect(
      classifyChunk(makeChunk({ content: `Acknowledgements\n${body}` })).reason,
    ).toBe('front-matter');
  });

  it('excludes a references heading', () => {
    const result = classifyChunk(
      makeChunk({ content: `References\n${NORMAL} ${NORMAL}` }),
    );
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('reference-section');
    expect(result.state.inReferenceSection).toBe(true);
  });

  it('carries the reference state to the next chunk of the same document', () => {
    const first = classifyChunk(
      makeChunk({ content: `References\n${NORMAL} ${NORMAL}` }),
    );
    const second = classifyChunk(
      makeChunk({ content: NORMAL, chunkIndex: 1 }),
      first.state,
    );

    expect(second.eligible).toBe(false);
    expect(second.reason).toBe('reference-section');
  });

  it('does not carry the reference state into another document', () => {
    const chunks = [
      makeChunk({ content: `References\n${NORMAL} ${NORMAL}` }),
      makeChunk({
        documentId: 'doc-2',
        content: NORMAL,
        chunkIndex: 1,
      }),
    ];
    const results = classifyChunks(chunks);

    expect(results.find((item) => item.chunk.documentId === 'doc-1')?.eligible)
      .toBe(false);
    expect(results.find((item) => item.chunk.documentId === 'doc-2')?.eligible)
      .toBe(true);
  });

  it('catches a bibliography the old M2 classifier missed', () => {
    const content = [
      'Smith JA, Doe B. Neonatal jaundice in term infants. J Pediatr. 2019;12(3):45-67.',
      'Reyes MC, Cruz PL. Dengue in children. Phil J Pediatr. 2020;33(2):101-110.',
      'Tan RK, Lim WS. Acute asthma in school children. Ann Pediatr. 2021;8(4):221-229.',
    ].join('\n');

    // Long enough, no heading, no dot leader and no digit dominance: the old
    // classifier returned eligible for this chunk.
    expect(content.length).toBeGreaterThan(200);
    const result = classifyChunk(makeChunk({ content }));
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('bibliography-entry');
  });

  it('excludes numbered reference entries', () => {
    const content = [
      '1. Smith JA. Neonatal jaundice. J Pediatr. 2019;12(3):45-67.',
      '2. Reyes MC. Dengue in children. Phil J Pediatr. 2020;33(2):101-110.',
    ].join('\n');
    expect(classifyChunk(makeChunk({ content })).reason).toBe(
      'bibliography-entry',
    );
  });

  it('excludes dot leaders and digit-heavy text', () => {
    expect(
      classifyChunk(
        makeChunk({ content: `Chapter one........12\n${NORMAL} ${NORMAL}` }),
      ).reason,
    ).toBe('dot-leader');
    expect(
      classifyChunk(
        makeChunk({ content: `${'1234567890 '.repeat(20)}abc` }),
      ).reason,
    ).toBe('mostly-digits');
  });

  it('excludes pages that are mostly short lines', () => {
    const content = Array.from(
      { length: 30 },
      (_, index) => `line ${index}`,
    ).join('\n');
    expect(classifyChunk(makeChunk({ content })).reason).toBe(
      'mostly-short-lines',
    );
  });
});

describe('classifyChunk front matter on flattened text', () => {
  it('excludes a credential-dense contributor list with no admin heading', () => {
    const result = classifyChunk(makeChunk({ content: CONTRIBUTOR_DENSE }));

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('front-matter');
  });

  it('excludes a credential and affiliation pair list', () => {
    const result = classifyChunk(makeChunk({ content: PAIR_DENSE }));

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('front-matter');
  });

  it('keeps a list below both density thresholds eligible', () => {
    const content =
      'Pediatric faculty Jane Smith MD, John Doe MD. ' +
      'University Hospital, Department of Pediatrics. ' +
      NORMAL;

    expect(content).not.toContain('\n');
    expect(classifyChunk(makeChunk({ content })).eligible).toBe(true);
  });

  it('excludes an editorial board page', () => {
    const content = `Editorial Board Jane Smith MD, John Doe MD. ${NORMAL}`;
    const result = classifyChunk(makeChunk({ content }));

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('front-matter');
  });

  it('excludes a dedication phrase', () => {
    const content = `Dedication In memory of the founding editors. ${NORMAL}`;
    const result = classifyChunk(makeChunk({ content }));

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('front-matter');
  });

  it('excludes a table of contents without dot leaders', () => {
    const content =
      `Contents Chapter 1 Introduction Chapter 2 Assessment ${NORMAL}`;
    const result = classifyChunk(makeChunk({ content }));

    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('front-matter');
  });

  it('excludes strong publisher markers anywhere in the window', () => {
    const markers = [
      'ISBN 978-1-2345-6789-0',
      'All rights reserved',
      'Library of Congress',
      'Printed in the United States',
    ];

    for (const marker of markers) {
      const content = `Pediatric handbook ${marker}. ${NORMAL}`;
      expect(content).not.toContain('\n');
      expect(classifyChunk(makeChunk({ content })).reason).toBe(
        'front-matter',
      );
    }
  });

  it('keeps a short chunk with only a copyright symbol eligible', () => {
    const content = `Pediatric handbook \u00a9 2020. ${NORMAL}`;

    expect(content.length).toBeLessThan(600);
    expect(classifyChunk(makeChunk({ content })).eligible).toBe(true);
  });

  it('blocks when a copyright symbol sits beside a strong marker', () => {
    const content =
      `Pediatric handbook \u00a9 2020. All rights reserved. ${NORMAL}`;

    expect(classifyChunk(makeChunk({ content })).reason).toBe('front-matter');
  });

  for (const heading of ADMIN_HEADINGS) {
    it(`excludes a single-line chunk that starts with "${heading}"`, () => {
      const content = `${heading} ${NORMAL}`;

      expect(content).not.toContain('\n');
      expect(classifyChunk(makeChunk({ content })).reason).toBe(
        'front-matter',
      );
    });
  }

  it('strips chapter numbering before matching a heading', () => {
    const content = `Chapter 3 Contents ${NORMAL}`;
    const result = classifyChunk(makeChunk({ content }));

    expect(result.reason).toBe('front-matter');
  });

  it('does not treat a sentence beginning with "Contents of" as a heading', () => {
    const content =
      `Contents of the stomach were aspirated before the procedure. ` +
      `${NORMAL} ${NORMAL}`;
    const result = classifyChunk(makeChunk({ content }));

    expect(result.eligible).toBe(true);
  });

  it('excludes a short admin chunk before the length rule', () => {
    const result = classifyChunk(
      makeChunk({ content: 'Dedication In memory.' }),
    );

    expect(result.reason).toBe('front-matter');
  });

  it('applies front matter rules through page 30 only', () => {
    expect(
      classifyChunk(makeChunk({ content: CONTRIBUTOR_DENSE, page: 30 })).reason,
    ).toBe('front-matter');
    expect(
      classifyChunk(makeChunk({ content: CONTRIBUTOR_DENSE, page: 31 }))
        .eligible,
    ).toBe(true);
  });

  it('treats a missing or zero page as outside the window', () => {
    expect(
      classifyChunk(makeChunk({ content: CONTRIBUTOR_DENSE, page: 0 }))
        .eligible,
    ).toBe(true);
    expect(
      classifyChunk(
        makeChunk({
          content: CONTRIBUTOR_DENSE,
          page: undefined as unknown as number,
        }),
      ).eligible,
    ).toBe(true);
  });

  it('applies the same front matter rules in another document', () => {
    const chunks = [
      makeChunk({
        documentId: 'doc-1',
        content: CONTRIBUTOR_DENSE,
        page: 1,
        chunkIndex: 0,
      }),
      makeChunk({
        documentId: 'doc-2',
        content: CONTRIBUTOR_DENSE,
        page: 1,
        chunkIndex: 0,
      }),
      makeChunk({
        documentId: 'doc-3',
        content: NORMAL,
        page: 1,
        chunkIndex: 0,
      }),
    ];

    const results = classifyChunks(chunks);

    for (const documentId of ['doc-1', 'doc-2']) {
      expect(
        results.find((item) => item.chunk.documentId === documentId)?.eligible,
      ).toBe(false);
    }
    expect(
      results.find((item) => item.chunk.documentId === 'doc-3')?.eligible,
    ).toBe(true);
  });

  it('keeps normal clinical text with incidental terms eligible', () => {
    const content =
      'Gastric contents were clear. Body mass index was normal. ' +
      'The preface was brief. The University of Manila and the ' +
      'Department of Health reported one MD reviewer. ' +
      `${NORMAL} ${NORMAL}`;

    expect(content).not.toContain('\n');
    expect(classifyChunk(makeChunk({ content })).eligible).toBe(true);
  });
});

describe('classifyChunks front matter page propagation', () => {
  const LONG_CLINICAL = `${NORMAL} ${NORMAL} ${NORMAL}`;

  it('keeps a long clinical chunk with a lone copyright symbol eligible', () => {
    const content = `${LONG_CLINICAL} Figure \u00a9 2024 Elsevier.`;

    expect(content.length).toBeGreaterThanOrEqual(600);
    expect(classifyChunk(makeChunk({ content, page: 10 })).eligible).toBe(true);
  });

  it('blocks a long chunk when the copyright symbol has another marker', () => {
    const content = `${LONG_CLINICAL} Library of Congress \u00a9 2024.`;

    expect(content.length).toBeGreaterThanOrEqual(600);
    expect(classifyChunk(makeChunk({ content, page: 10 })).reason).toBe(
      'front-matter',
    );
  });

  it('propagates an ISBN page to its other chunks', () => {
    const results = classifyChunks([
      makeChunk({
        page: 3,
        chunkIndex: 2,
        content: `ISBN 978-1-2345-6789-0 ${NORMAL}`,
      }),
      makeChunk({ page: 3, chunkIndex: 3 }),
      makeChunk({ page: 3, chunkIndex: 4 }),
      makeChunk({ page: 4, chunkIndex: 5 }),
    ]);

    const page3 = results.filter((result) => result.chunk.page === 3);
    expect(page3).toHaveLength(3);
    expect(page3.every((result) => result.reason === 'front-matter')).toBe(
      true,
    );
    expect(results.find((result) => result.chunk.page === 4)?.eligible).toBe(
      true,
    );
  });

  it('propagates a preface heading page', () => {
    const results = classifyChunks([
      makeChunk({ page: 13, chunkIndex: 29, content: `Preface ${NORMAL}` }),
      makeChunk({ page: 13, chunkIndex: 30 }),
    ]);

    expect(results.every((result) => result.reason === 'front-matter')).toBe(
      true,
    );
  });

  it('propagates a contributor page to a zero-credential tail chunk', () => {
    const results = classifyChunks([
      makeChunk({ page: 18, chunkIndex: 41, content: CONTRIBUTOR_DENSE }),
      makeChunk({ page: 18, chunkIndex: 42 }),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.reason === 'front-matter')).toBe(
      true,
    );
  });

  it('leaves a clinical page with no flags untouched', () => {
    const results = classifyChunks([
      makeChunk({ page: 10, chunkIndex: 21 }),
      makeChunk({ page: 10, chunkIndex: 22 }),
    ]);

    expect(results.every((result) => result.eligible)).toBe(true);
  });

  it('never propagates beyond page 30', () => {
    const results = classifyChunks([
      makeChunk({
        page: 31,
        chunkIndex: 40,
        content: `ISBN 978-1-2345-6789-0 ${NORMAL}`,
      }),
      makeChunk({ page: 31, chunkIndex: 41 }),
      makeChunk({ page: 32, chunkIndex: 42 }),
    ]);

    expect(results.every((result) => result.eligible)).toBe(true);
  });

  it('does not propagate from a lone copyright symbol', () => {
    const results = classifyChunks([
      makeChunk({
        page: 10,
        chunkIndex: 20,
        content: `${LONG_CLINICAL} Figure \u00a9 2024 Elsevier.`,
      }),
      makeChunk({ page: 10, chunkIndex: 21 }),
    ]);

    expect(results.every((result) => result.eligible)).toBe(true);
  });
});

describe('evaluateGate', () => {
  it('passes at 30 chunks over 25 distinct pages', () => {
    const chunks = Array.from({ length: 30 }, (_, index) =>
      eligibleChunk(index, (index % 25) + 1),
    );
    expect(evaluateGate(chunks)).toEqual({
      eligibleChunks: 30,
      eligiblePages: 25,
      ok: true,
    });
  });

  it('fails at 29 chunks', () => {
    const chunks = Array.from({ length: 29 }, (_, index) =>
      eligibleChunk(index, (index % 25) + 1),
    );
    const gate = evaluateGate(chunks);
    expect(gate.eligibleChunks).toBe(29);
    expect(gate.ok).toBe(false);
  });

  it('fails at 24 distinct pages', () => {
    const chunks = Array.from({ length: 30 }, (_, index) =>
      eligibleChunk(index, (index % 24) + 1),
    );
    const gate = evaluateGate(chunks);
    expect(gate.eligiblePages).toBe(24);
    expect(gate.ok).toBe(false);
  });

  it('ignores excluded chunks in both counts', () => {
    const chunks = [
      ...Array.from({ length: 30 }, (_, index) =>
        eligibleChunk(index, (index % 25) + 1),
      ),
      makeChunk({ needsReview: true, page: 99, chunkIndex: 99 }),
    ];
    const gate = evaluateGate(chunks);
    expect(gate.eligibleChunks).toBe(30);
    expect(gate.eligiblePages).toBe(25);
  });
});

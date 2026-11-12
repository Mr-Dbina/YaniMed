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

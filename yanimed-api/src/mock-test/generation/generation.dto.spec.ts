import { describe, expect, it } from 'vitest';
import {
  deriveGenerationPhase,
  toGenerationProgressDto,
  type GenerationJobProgressSource,
} from './generation.dto.js';

const SOURCE: GenerationJobProgressSource = {
  id: 'job-1',
  subjectId: 'subject-1',
  state: 'RUNNING',
  requestedCount: 25,
  acceptedCount: 4,
  aiCallCount: 12,
  recoveryCount: 1,
  failureReason: null,
  planJson: { topics: [{ topicKey: 'zz-topic', name: 'ZZ topic' }] },
  startedAt: new Date('2026-01-01T00:00:01.000Z'),
  heartbeatAt: new Date('2026-01-01T00:00:02.000Z'),
  finishedAt: null,
  documents: [
    { document: { id: 'doc-1', title: 'ZZ document one' } },
    { document: { id: 'doc-2', title: 'ZZ document two' } },
  ],
};

const FORBIDDEN_KEYS = [
  'stem',
  'leadIn',
  'choices',
  'choice',
  'correctChoiceId',
  'selectedChoiceId',
  'isCorrect',
  'explanation',
  'keyExplanation',
  'citation',
  'citations',
  'quote',
  'source',
  'sourceText',
  'text',
  'question',
  'questions',
];

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysOf(child),
  ]);
}

describe('deriveGenerationPhase', () => {
  it('is PLANNING until a plan is stored', () => {
    expect(
      deriveGenerationPhase({
        planJson: null,
        acceptedCount: 0,
        requestedCount: 25,
      }),
    ).toBe('PLANNING');
    expect(
      deriveGenerationPhase({
        planJson: undefined,
        acceptedCount: 3,
        requestedCount: 25,
      }),
    ).toBe('PLANNING');
  });

  it('is DRAFTING below the requested count', () => {
    expect(
      deriveGenerationPhase({
        planJson: { topics: [] },
        acceptedCount: 24,
        requestedCount: 25,
      }),
    ).toBe('DRAFTING');
  });

  it('is FINALIZING at or above the requested count', () => {
    expect(
      deriveGenerationPhase({
        planJson: { topics: [] },
        acceptedCount: 25,
        requestedCount: 25,
      }),
    ).toBe('FINALIZING');
  });
});

describe('toGenerationProgressDto', () => {
  it('maps the progress contract exactly', () => {
    expect(toGenerationProgressDto(SOURCE)).toEqual({
      jobId: 'job-1',
      subjectId: 'subject-1',
      state: 'RUNNING',
      requestedCount: 25,
      acceptedCount: 4,
      aiCallCount: 12,
      recoveryCount: 1,
      failureReason: null,
      phase: 'DRAFTING',
      startedAt: new Date('2026-01-01T00:00:01.000Z'),
      heartbeatAt: new Date('2026-01-01T00:00:02.000Z'),
      finishedAt: null,
      documents: [
        { id: 'doc-1', title: 'ZZ document one' },
        { id: 'doc-2', title: 'ZZ document two' },
      ],
    });
  });

  it('carries no question text, key, explanation, citation or source text', () => {
    const keys = keysOf(JSON.parse(JSON.stringify(toGenerationProgressDto(SOURCE))));
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
    expect(keys).not.toContain('planJson');
  });
});

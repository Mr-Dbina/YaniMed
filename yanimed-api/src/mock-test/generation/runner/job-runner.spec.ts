import { describe, expect, it, vi } from 'vitest';
import {
  QUESTIONS_PER_TEST,
  REPLACEMENT_BUDGET,
  VALIDATOR_VERSION,
} from '../generation.constants.js';
import { GenerationError } from '../generation.errors.js';
import type { DraftQuestionArgs, DraftResult } from '../draft/draft.service.js';
import {
  PlanInsufficientContentError,
  type GenerationPlan,
} from '../plan/planner.js';
import type { PlannerChunkInput } from '../plan/clustering.js';
import type { DraftQuestion } from '../validate/types.js';
import type { SetQuestionRef } from '../validate/check-d.js';
import type { WriteQuestionArgs } from '../persist/question-writer.js';
import type {
  JobInputs,
  Progress,
  RunnerDeps,
  WrittenQuestion,
} from './ports.js';
import { mapRunnerError, runJob, type RunJobArgs } from './job-runner.js';

const DIM = 768;
const SOURCE_SENTINEL = 'SOURCE-TEXT-MUST-NOT-LEAK';
const TOPICS = 13;

function basis(index: number): number[] {
  const vector = Array.from({ length: DIM }, () => 0);
  vector[index % DIM] = 1;
  return vector;
}

function makePlan(slotCount = QUESTIONS_PER_TEST): GenerationPlan {
  const topics: GenerationPlan['topics'] = [];
  const slots: GenerationPlan['slots'] = [];
  const candidates: Record<string, string[]> = {};

  for (let topic = 1; topic <= TOPICS; topic += 1) {
    const count = topic <= 12 ? 2 : 1;
    const topicKey = `topic-${topic}`;
    topics.push({
      topicKey,
      name: `Topic ${topic}`,
      clusterId: topic,
      slotCount: count,
    });
    candidates[topicKey] = Array.from(
      { length: 5 },
      (_, index) => `chunk-${topic}-${index}`,
    );
    for (let ordinal = 0; ordinal < count; ordinal += 1) {
      slots.push({
        index: slots.length,
        topicKey,
        seedChunkIds: [`chunk-${topic}-${ordinal}`],
      });
    }
  }

  return {
    topics,
    slots: slots.slice(0, slotCount),
    candidates,
    stats: {
      eligibleChunks: 65,
      distinctPages: 65,
      clusters: TOPICS,
      attempt: 1,
      excludedEmbeddings: 0,
    },
  };
}

function makeInputs(): JobInputs {
  const chunks: PlannerChunkInput[] = [];
  for (const topic of Array.from({ length: TOPICS }, (_, index) => index + 1)) {
    for (let index = 0; index < 5; index += 1) {
      chunks.push({
        id: `chunk-${topic}-${index}`,
        documentId: 'doc-1',
        content: `${SOURCE_SENTINEL} ${topic} ${index}`,
        page: 1,
        chunkIndex: index,
        needsReview: false,
        embedding: basis(topic * 5 + index),
      });
    }
  }
  return {
    subjectId: 'subject-1',
    subjectName: 'Subject One',
    styleHint: 'CLINICAL_STEM',
    requestedCount: QUESTIONS_PER_TEST,
    snapshotDocumentIds: new Set(['doc-1']),
    documents: new Map([['doc-1', { title: 'Doc One', pageCount: 100 }]]),
    pages: new Map([['doc-1:1', { text: SOURCE_SENTINEL, needsOcr: false }]]),
    chunks,
  };
}

function makeDraft(topicKey: string, index: number): DraftQuestion {
  return {
    stem: `${SOURCE_SENTINEL} stem ${index}.`,
    leadIn: null,
    choices: [
      { text: 'Choice A', explanation: 'Explanation A' },
      { text: 'Choice B', explanation: 'Explanation B' },
      { text: 'Choice C', explanation: 'Explanation C' },
      { text: 'Choice D', explanation: 'Explanation D' },
    ],
    keyIndex: 0,
    objective: `Objective ${index}.`,
    keyExplanation: 'Key explanation.',
    topicKey,
    citation: { documentId: 'doc-1', page: 1, quote: SOURCE_SENTINEL },
  };
}

function writtenQuestion(index: number, topicKey: string): WrittenQuestion {
  return {
    questionId: `question-${index}`,
    status: 'QUARANTINED',
    topicKey,
    stem: `stem ${index}`,
    leadIn: null,
    objective: `objective ${index}`,
    keyChoiceText: 'Choice A',
    citations: [{ documentId: 'doc-1', page: 1, quote: 'quote' }],
  };
}

interface Harness {
  deps: RunnerDeps;
  written: WrittenQuestion[];
  writeCalls: WriteQuestionArgs[];
  draftCalls: DraftQuestionArgs[];
  embedCalls: Array<{ jobId: string; text: string }>;
  progress: Progress[];
  planCalls: number;
  saveCalls: Array<{ fence: { jobId: string; recoveryCount: number }; plan: GenerationPlan }>;
  listCalls: number;
  checkDArgs: Array<{ questions: SetQuestionRef[]; expectedCount: number }>;
}

function makeHarness(
  options: {
    written?: WrittenQuestion[];
    savedPlan?: GenerationPlan | null;
    deps?: Partial<RunnerDeps>;
  } = {},
): Harness {
  const plan = makePlan();
  const written = [...(options.written ?? [])];
  const writeCalls: WriteQuestionArgs[] = [];
  const draftCalls: DraftQuestionArgs[] = [];
  const embedCalls: Array<{ jobId: string; text: string }> = [];
  const progress: Progress[] = [];
  const saveCalls: Harness['saveCalls'] = [];
  const checkDArgs: Harness['checkDArgs'] = [];
  let planCalls = 0;
  let listCalls = 0;
  let embedIndex = 0;
  let checkCIndex = 0;

  const deps: RunnerDeps = {
    source: { load: async () => makeInputs() },
    planStore: {
      load: async () => options.savedPlan ?? null,
      save: async (fence, saved) => {
        saveCalls.push({ fence, plan: saved });
      },
    },
    writtenStore: {
      listWritten: async () => {
        listCalls += 1;
        return [...written];
      },
    },
    ensureTopics: async (_subjectId, planTopics) =>
      new Map(
        planTopics.map((topic) => [topic.topicKey, `topic-id-${topic.topicKey}`]),
      ),
    planner: {
      plan: async () => {
        planCalls += 1;
        return plan;
      },
    },
    draft: async (args) => {
      draftCalls.push(args);
      const result: DraftResult = {
        ok: true,
        draft: makeDraft(args.topic.topicKey, draftCalls.length),
        model: `draft-model-${draftCalls.length}`,
        promptVersion: 'prompt-v1',
      };
      return result;
    },
    checkA: (value) => ({ ok: true, draft: value as DraftQuestion }),
    checkB: async () => ({ ok: true, polarity: 'NORMAL', verdicts: [] }),
    checkC: async () => ({
      ok: true,
      embedding: basis(checkCIndex++),
      maxSimilarity: 0,
      skippedBankRefs: 0,
    }),
    checkD: (questions, ctx) => {
      checkDArgs.push({ questions, expectedCount: ctx.expectedCount });
      return { ok: true, topicCount: TOPICS, maxSimilarity: 0 };
    },
    writeQuestion: async (args) => {
      const index = writeCalls.length + 1;
      writeCalls.push(args);
      const question = writtenQuestion(index, args.draft.topicKey);
      written.push(question);
      return { questionId: question.questionId, acceptedCount: written.length };
    },
    embed: async (input) => {
      embedCalls.push(input);
      return basis(embedIndex++);
    },
    bank: { loadRefs: async () => [] },
    models: { verifier: 'verify-model-1' },
    onProgress: (value) => progress.push(value),
    ...options.deps,
  };

  return {
    deps,
    written,
    writeCalls,
    draftCalls,
    embedCalls,
    progress,
    get planCalls() {
      return planCalls;
    },
    saveCalls,
    get listCalls() {
      return listCalls;
    },
    checkDArgs,
  };
}

function makeArgs(
  overrides: Partial<RunJobArgs> = {},
): RunJobArgs {
  return {
    job: { id: 'job-1', subjectId: 'subject-1', requestedCount: 25 },
    fence: { jobId: 'job-1', recoveryCount: 2 },
    signal: new AbortController().signal,
    ...overrides,
  };
}

function interruptedDraft(error: Error): RunnerDeps['draft'] {
  return async () => {
    throw error;
  };
}

describe('runJob', () => {
  it('completes 25 questions and passes Check D', async () => {
    const harness = makeHarness();

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toEqual({ kind: 'COMPLETED', acceptedCount: 25 });
    expect(harness.writeCalls).toHaveLength(25);
    expect(harness.planCalls).toBe(1);
    expect(harness.saveCalls).toHaveLength(1);
    expect(harness.saveCalls[0].fence).toEqual({
      jobId: 'job-1',
      recoveryCount: 2,
    });
    expect(harness.checkDArgs).toHaveLength(1);
    expect(harness.checkDArgs[0].questions).toHaveLength(25);
    expect(harness.checkDArgs[0].expectedCount).toBe(25);
    expect(
      harness.checkDArgs[0].questions.every(
        (question) => question.embedding !== null,
      ),
    ).toBe(true);
    expect(harness.progress[0]).toEqual({
      phase: 'PLANNING',
      acceptedCount: 0,
    });
    expect(harness.progress[harness.progress.length - 1]).toEqual({
      phase: 'FINALIZING',
      acceptedCount: 25,
    });
    expect(
      harness.progress.filter((item) => item.phase === 'DRAFTING'),
    ).toHaveLength(25);
    expect(
      harness.progress.filter((item) => item.phase === 'VALIDATING'),
    ).toHaveLength(25);
    expect(harness.writeCalls[0].provenance).toEqual({
      draftModel: 'draft-model-1',
      verifierModel: 'verify-model-1',
      promptVersion: 'prompt-v1',
      validatorVersion: VALIDATOR_VERSION,
    });
  });

  it('reuses a saved plan and skips planning and saving', async () => {
    const harness = makeHarness({ savedPlan: makePlan() });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result.kind).toBe('COMPLETED');
    expect(harness.planCalls).toBe(0);
    expect(harness.saveCalls).toHaveLength(0);
    expect(harness.embedCalls).toHaveLength(0);
    expect(harness.writeCalls).toHaveLength(25);
  });

  it('runs the planner and saves the plan when none is stored', async () => {
    const harness = makeHarness();

    await runJob(makeArgs(), harness.deps);

    expect(harness.planCalls).toBe(1);
    expect(harness.saveCalls).toHaveLength(1);
    expect(harness.saveCalls[0].plan.slots).toHaveLength(25);
    expect(harness.saveCalls[0].plan.candidates['topic-1']).toHaveLength(5);
  });

  it('resumes with ten written questions and runs only the remaining fifteen slots', async () => {
    const written: WrittenQuestion[] = [];
    let index = 0;
    for (let topic = 1; topic <= 5; topic += 1) {
      for (let ordinal = 0; ordinal < 2; ordinal += 1) {
        index += 1;
        written.push(writtenQuestion(index, `topic-${topic}`));
      }
    }
    const harness = makeHarness({ written, savedPlan: makePlan() });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toEqual({ kind: 'COMPLETED', acceptedCount: 25 });
    expect(harness.embedCalls).toHaveLength(10);
    expect(harness.draftCalls).toHaveLength(15);
    expect(harness.writeCalls).toHaveLength(15);

    const draftedTopics = new Set(
      harness.draftCalls.map((call) => call.topic.topicKey),
    );
    for (let topic = 1; topic <= 5; topic += 1) {
      expect(draftedTopics.has(`topic-${topic}`)).toBe(false);
    }
    expect(harness.checkDArgs[0].questions).toHaveLength(25);
    expect(
      harness.checkDArgs[0].questions.every(
        (question) => question.embedding !== null,
      ),
    ).toBe(true);
  });

  it('fails VALIDATION_EXHAUSTED when Check D rejects the set', async () => {
    const harness = makeHarness({
      deps: {
        checkD: () => ({
          ok: false,
          reasons: [{ code: 'SET_EMBEDDING_INVALID' }],
        }),
      },
    });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toMatchObject({
      kind: 'FAILED',
      reason: 'VALIDATION_EXHAUSTED',
      code: 'SET_EMBEDDING_INVALID',
    });
  });

  it('maps a gone citation document to SOURCE_CHANGED even with other reasons', async () => {
    const harness = makeHarness({
      deps: {
        checkD: () => ({
          ok: false,
          reasons: [
            { code: 'SET_EMBEDDING_INVALID' },
            { code: 'SET_CITATION_DOCUMENT_GONE' },
          ],
        }),
      },
    });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toMatchObject({
      kind: 'FAILED',
      reason: 'SOURCE_CHANGED',
      code: 'SET_EMBEDDING_INVALID',
    });
  });

  it('fails INTERNAL before any dependency call for a requestedCount of 24', async () => {
    const harness = makeHarness();
    const load = vi.spyOn(harness.deps.source, 'load');

    const result = await runJob(
      makeArgs({ job: { id: 'job-1', subjectId: 'subject-1', requestedCount: 24 } }),
      harness.deps,
    );

    expect(result).toMatchObject({ kind: 'FAILED', reason: 'INTERNAL' });
    expect(load).not.toHaveBeenCalled();
  });

  it('fails VALIDATION_EXHAUSTED when the plan runs out of slots', async () => {
    const plan = makePlan(24);
    const harness = makeHarness({ savedPlan: plan });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toMatchObject({
      kind: 'FAILED',
      reason: 'VALIDATION_EXHAUSTED',
    });
    expect(harness.writeCalls).toHaveLength(24);
  });

  it.each([
    ['GENERATION_PROVIDER_UNAVAILABLE', 'PROVIDER_UNAVAILABLE'],
    ['GENERATION_AI_TIMEOUT', 'PROVIDER_UNAVAILABLE'],
    ['GENERATION_BUDGET_EXHAUSTED', 'BUDGET_EXHAUSTED'],
  ] as const)('maps %s to %s', async (code, reason) => {
    const harness = makeHarness();
    harness.deps.draft = interruptedDraft(
      new GenerationError(code, { jobId: 'job-1' }),
    );

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toMatchObject({ kind: 'FAILED', reason, code });
  });

  it('maps a verifier configuration error to INTERNAL and keeps the code', async () => {
    const harness = makeHarness();
    harness.deps.draft = interruptedDraft(
      new GenerationError('GENERATION_VERIFIER_NOT_CONFIGURED'),
    );

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toEqual({
      kind: 'FAILED',
      reason: 'INTERNAL',
      code: 'GENERATION_VERIFIER_NOT_CONFIGURED',
      detail: 'GenerationError',
    });
  });

  it('maps the source not-found error to SOURCE_CHANGED', async () => {
    const harness = makeHarness({
      deps: {
        source: {
          load: async () => {
            throw new GenerationError('GENERATION_NOT_FOUND', {
              jobId: 'job-1',
            });
          },
        },
      },
    });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toMatchObject({
      kind: 'FAILED',
      reason: 'SOURCE_CHANGED',
      code: 'GENERATION_NOT_FOUND',
    });
  });

  it('maps insufficient content with numeric details', async () => {
    const harness = makeHarness({
      deps: {
        planner: {
          plan: async () => {
            throw new PlanInsufficientContentError({
              eligibleChunks: 30,
              distinctPages: 25,
              clusters: 1,
            });
          },
        },
      },
    });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toEqual({
      kind: 'FAILED',
      reason: 'INSUFFICIENT_CONTENT',
      code: 'INSUFFICIENT_CONTENT',
      detail: 'eligibleChunks 30, distinctPages 25, clusters 1',
    });
  });

  it('stops with STALE_WORKER from the writer and makes no further calls', async () => {
    let writes = 0;
    const checkD = vi.fn(() => ({
      ok: true as const,
      topicCount: TOPICS,
      maxSimilarity: 0,
    }));
    const harness = makeHarness({
      deps: {
        writeQuestion: async () => {
          writes += 1;
          throw new GenerationError('GENERATION_STALE_WORKER', {
            jobId: 'job-1',
          });
        },
        checkD,
      },
    });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toEqual({ kind: 'STOPPED', cause: 'STALE_WORKER' });
    expect(writes).toBe(1);
    expect(harness.draftCalls).toHaveLength(1);
    expect(checkD).not.toHaveBeenCalled();
  });

  it('maps a budget error during resume re-embedding', async () => {
    const harness = makeHarness({
      written: [writtenQuestion(1, 'topic-1')],
      savedPlan: makePlan(),
      deps: {
        embed: async () => {
          throw new GenerationError('GENERATION_BUDGET_EXHAUSTED');
        },
      },
    });

    const result = await runJob(makeArgs(), harness.deps);

    expect(result).toMatchObject({
      kind: 'FAILED',
      reason: 'BUDGET_EXHAUSTED',
    });
    expect(harness.draftCalls).toHaveLength(0);
    expect(harness.writeCalls).toHaveLength(0);
  });

  it('stops before any call when the signal is already aborted', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    controller.abort('CANCEL');
    const load = vi.spyOn(harness.deps.source, 'load');

    const result = await runJob(
      makeArgs({ signal: controller.signal }),
      harness.deps,
    );

    expect(result).toEqual({ kind: 'STOPPED', cause: 'CANCEL' });
    expect(load).not.toHaveBeenCalled();
  });

  it.each(['CANCEL', 'DEADLINE', 'SHUTDOWN', 'STALE_WORKER'] as const)(
    'stops with %s when aborted during a draft',
    async (cause) => {
      const harness = makeHarness();
      const controller = new AbortController();
      harness.deps.draft = async () => {
        controller.abort(cause);
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      };

      const result = await runJob(
        makeArgs({ signal: controller.signal }),
        harness.deps,
      );

      expect(result).toEqual({ kind: 'STOPPED', cause });
    },
  );

  it('keeps the first abort reason when two causes race', async () => {
    const harness = makeHarness();
    const controller = new AbortController();
    harness.deps.draft = async () => {
      controller.abort('CANCEL');
      controller.abort('DEADLINE');
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };

    const result = await runJob(
      makeArgs({ signal: controller.signal }),
      harness.deps,
    );

    expect(result).toEqual({ kind: 'STOPPED', cause: 'CANCEL' });
  });

  it('never copies source or model text into an outcome', async () => {
    const harness = makeHarness();
    harness.deps.draft = async () => {
      throw new Error(`provider said ${SOURCE_SENTINEL}`);
    };

    const failed = await runJob(makeArgs(), harness.deps);

    expect(failed).toMatchObject({
      kind: 'FAILED',
      reason: 'INTERNAL',
      detail: 'Error',
    });
    expect(JSON.stringify(failed)).not.toContain(SOURCE_SENTINEL);

    const completed = await runJob(makeArgs(), makeHarness().deps);
    expect(JSON.stringify(completed)).not.toContain(SOURCE_SENTINEL);
    expect(REPLACEMENT_BUDGET).toBe(5);
  });

  it('maps an unknown thrown value to INTERNAL with only its name', () => {
    const signal = new AbortController().signal;
    const result = mapRunnerError({ name: 'WeirdError', message: 'secret' }, signal);

    expect(result).toEqual({
      kind: 'FAILED',
      reason: 'INTERNAL',
      detail: 'WeirdError',
    });
  });
});

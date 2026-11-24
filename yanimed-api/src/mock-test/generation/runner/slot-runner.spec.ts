import { describe, expect, it, vi } from 'vitest';
import {
  DRAFT_ATTEMPTS_PER_SLOT,
  REPLACEMENTS_PER_SLOT,
  VALIDATOR_VERSION,
} from '../generation.constants.js';
import type { DraftQuestionArgs, DraftResult } from '../draft/draft.service.js';
import type { GenerationPlan } from '../plan/planner.js';
import type { PlannerChunkInput } from '../plan/clustering.js';
import type { DraftQuestion } from '../validate/types.js';
import type { AcceptedQuestionRef } from '../validate/check-c.js';
import type { JobInputs, Progress } from './ports.js';
import type { WorkerLogger } from '../worker/worker.types.js';
import {
  emptyRejectionCounts,
  runSlot,
  stopCauseOf,
  type SlotRunArgs,
  type SlotRunnerDeps,
} from './slot-runner.js';

const DIM = 8;
const SOURCE_SENTINEL = 'SOURCE-TEXT-MUST-NOT-LEAK';

function basis(index: number): number[] {
  const vector = Array.from({ length: DIM }, () => 0);
  vector[index % DIM] = 1;
  return vector;
}

function chunk(index: number, topic = 1): PlannerChunkInput {
  return {
    id: `chunk-${topic}-${index}`,
    documentId: 'doc-1',
    content: `${SOURCE_SENTINEL} ${index}`,
    page: index + 1,
    chunkIndex: index,
    needsReview: false,
    embedding: basis(index),
  };
}

function makePlan(
  candidatesPerTopic = 10,
  slotCount = 1,
): GenerationPlan {
  const candidates = Array.from(
    { length: candidatesPerTopic },
    (_, index) => `chunk-1-${index}`,
  );
  const slots = Array.from({ length: slotCount }, (_, index) => ({
    index,
    topicKey: 'topic-1',
    seedChunkIds: [candidates[index]],
  }));
  return {
    topics: [
      { topicKey: 'topic-1', name: 'Topic One', clusterId: 1, slotCount },
    ],
    slots,
    candidates: { 'topic-1': candidates },
    stats: {
      eligibleChunks: candidatesPerTopic,
      distinctPages: candidatesPerTopic,
      clusters: 1,
      attempt: 1,
      excludedEmbeddings: 0,
    },
  };
}

function makeInputs(candidatesPerTopic = 10): JobInputs {
  return {
    subjectId: 'subject-1',
    subjectName: 'Subject One',
    styleHint: 'SHORT_RECALL',
    requestedCount: 25,
    snapshotDocumentIds: new Set(['doc-1']),
    documents: new Map([['doc-1', { title: 'Doc One', pageCount: 100 }]]),
    pages: new Map([['doc-1:1', { text: SOURCE_SENTINEL, needsOcr: false }]]),
    chunks: Array.from({ length: candidatesPerTopic }, (_, index) =>
      chunk(index),
    ),
  };
}

function makeDraft(overrides: Partial<DraftQuestion> = {}): DraftQuestion {
  return {
    stem: 'Stem one.',
    leadIn: null,
    choices: [
      { text: 'Choice A', explanation: 'Explanation A' },
      { text: 'Choice B', explanation: 'Explanation B' },
      { text: 'Choice C', explanation: 'Explanation C' },
      { text: 'Choice D', explanation: 'Explanation D' },
    ],
    keyIndex: 0,
    objective: 'Objective one.',
    keyExplanation: 'Key explanation.',
    topicKey: 'topic-1',
    citation: { documentId: 'doc-1', page: 1, quote: SOURCE_SENTINEL },
    ...overrides,
  };
}

function draftOk(draft = makeDraft()): DraftResult {
  return {
    ok: true,
    draft,
    model: 'draft-model-1',
    promptVersion: 'prompt-v1',
  };
}

function fakeDeps(overrides: Partial<SlotRunnerDeps> = {}): SlotRunnerDeps {
  return {
    draft: async () => draftOk(),
    checkA: (value) => ({ ok: true, draft: value as DraftQuestion }),
    checkB: async () => ({ ok: true, polarity: 'NORMAL', verdicts: [] }),
    checkC: async () => ({
      ok: true,
      embedding: basis(0),
      maxSimilarity: 0,
      skippedBankRefs: 0,
    }),
    writeQuestion: async () => ({ questionId: 'question-1', acceptedCount: 1 }),
    embed: async () => basis(0),
    bank: { loadRefs: async () => [] },
    models: { verifier: 'verify-model-1' },
    ...overrides,
  };
}

function makeArgs(overrides: Partial<SlotRunArgs> = {}): SlotRunArgs {
  const plan = overrides.plan ?? makePlan();
  return {
    slot: plan.slots[0],
    plan,
    inputs: makeInputs(),
    fence: { jobId: 'job-1', recoveryCount: 2 },
    subjectId: 'subject-1',
    subjectName: 'Subject One',
    topicId: 'topic-id-1',
    signal: new AbortController().signal,
    accepted: [],
    acceptedObjectives: [],
    usedPrimaryIds: new Set(),
    replacementBudgetRemaining: REPLACEMENTS_PER_SLOT,
    deps: fakeDeps(),
    counts: emptyRejectionCounts(),
    ...overrides,
  };
}

interface FakeLogger {
  logger: WorkerLogger;
  warns: Array<{ event: string; fields?: Record<string, string | number | undefined> }>;
}

function fakeLogger(): FakeLogger {
  const warns: FakeLogger['warns'] = [];
  return {
    logger: {
      info: () => {},
      warn: (event, fields) => warns.push({ event, fields }),
      error: () => {},
    },
    warns,
  };
}

function acceptedRef(): AcceptedQuestionRef {
  return {
    key: 'accepted-1',
    embedding: basis(0),
    topicKey: 'topic-1',
    objective: 'Old objective.',
    documentId: 'doc-1',
    page: 1,
    quote: 'Quote.',
    keyChoiceText: 'Choice A',
  };
}

describe('runSlot', () => {
  it('accepts a clean slot on the first draft', async () => {
    const writeQuestion = vi.fn(async () => ({
      questionId: 'question-1',
      acceptedCount: 1,
    }));
    const draft = vi.fn(async () => draftOk());
    const progress: Progress[] = [];
    const result = await runSlot(
      makeArgs({
        deps: fakeDeps({ draft, writeQuestion }),
        onProgress: (value) => progress.push(value),
      }),
    );

    expect(result.kind).toBe('ACCEPTED');
    if (result.kind !== 'ACCEPTED') return;
    expect(result.ref.key).toBe('question-1');
    expect(result.ref.topicKey).toBe('topic-1');
    expect(result.replacementBudgetUsed).toBe(0);
    expect(draft).toHaveBeenCalledTimes(1);
    expect(writeQuestion).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([{ phase: 'VALIDATING', acceptedCount: 0 }]);
  });

  it('passes the writer provenance from the draft result and models', async () => {
    const writeQuestion = vi.fn(async () => ({
      questionId: 'question-1',
      acceptedCount: 1,
    }));

    await runSlot(makeArgs({ deps: fakeDeps({ writeQuestion }) }));

    expect(writeQuestion).toHaveBeenCalledWith(
      expect.objectContaining({
        fence: { jobId: 'job-1', recoveryCount: 2 },
        subjectId: 'subject-1',
        topicId: 'topic-id-1',
        provenance: {
          draftModel: 'draft-model-1',
          verifierModel: 'verify-model-1',
          promptVersion: 'prompt-v1',
          validatorVersion: VALIDATOR_VERSION,
        },
      }),
    );
  });

  it('accepts on the second attempt after Check A fails, with avoidStems growing', async () => {
    const draft = vi.fn(async (args: DraftQuestionArgs) =>
      draftOk(makeDraft({ stem: `Stem ${args.avoidStems?.length ?? 0}.` })),
    );
    const checkA = vi
      .fn<SlotRunnerDeps['checkA']>()
      .mockReturnValueOnce({ ok: false, reasons: [] })
      .mockImplementation((value) => ({
        ok: true,
        draft: value as DraftQuestion,
      }));
    const checkB = vi.fn(fakeDeps().checkB);

    const result = await runSlot(
      makeArgs({ deps: fakeDeps({ draft, checkA, checkB }) }),
    );

    expect(result.kind).toBe('ACCEPTED');
    expect(draft).toHaveBeenCalledTimes(2);
    expect(draft.mock.calls[1][0].avoidStems).toEqual(['Stem 0.']);
    expect(checkB).toHaveBeenCalledTimes(1);
  });

  it('passes the last rejection code to the next draft', async () => {
    const draft = vi.fn<SlotRunnerDeps['draft']>(async () => draftOk());
    const checkA = vi
      .fn<SlotRunnerDeps['checkA']>()
      .mockReturnValueOnce({
        ok: false,
        reasons: [{ code: 'CHOICES_ALL_IN_STATED_RANGE' }],
      })
      .mockImplementation((value) => ({
        ok: true,
        draft: value as DraftQuestion,
      }));

    await runSlot(makeArgs({ deps: fakeDeps({ draft, checkA }) }));

    expect(draft.mock.calls[0][0].lastRejectionCode).toBeUndefined();
    expect(draft.mock.calls[1][0].lastRejectionCode).toBe(
      'CHOICES_ALL_IN_STATED_RANGE',
    );
  });

  it('passes a draft rejection reason to the next draft', async () => {
    const draft = vi
      .fn<SlotRunnerDeps['draft']>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_SHAPE_INVALID',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValue(draftOk());

    await runSlot(makeArgs({ deps: fakeDeps({ draft }) }));

    expect(draft.mock.calls[1][0].lastRejectionCode).toBe(
      'DRAFT_SHAPE_INVALID',
    );
  });

  it('does not run later checks after Check A fails', async () => {
    const plan = makePlan(1, 1);
    const checkA = vi.fn<SlotRunnerDeps['checkA']>(() => ({
      ok: false,
      reasons: [],
    }));
    const checkB = vi.fn(fakeDeps().checkB);
    const checkC = vi.fn(fakeDeps().checkC);
    const writeQuestion = vi.fn(fakeDeps().writeQuestion);

    const result = await runSlot(
      makeArgs({
        plan,
        slot: plan.slots[0],
        deps: fakeDeps({ checkA, checkB, checkC, writeQuestion }),
      }),
    );

    expect(result.kind).toBe('EXHAUSTED');
    expect(checkA).toHaveBeenCalledTimes(3);
    expect(checkB).not.toHaveBeenCalled();
    expect(checkC).not.toHaveBeenCalled();
    expect(writeQuestion).not.toHaveBeenCalled();
  });

  it('retries after Check B fails', async () => {
    const checkB = vi
      .fn<SlotRunnerDeps['checkB']>()
      .mockResolvedValueOnce({ ok: false, polarity: 'NORMAL', reasons: [] })
      .mockResolvedValue({ ok: true, polarity: 'NORMAL', verdicts: [] });
    const checkC = vi.fn(fakeDeps().checkC);

    const result = await runSlot(
      makeArgs({ deps: fakeDeps({ checkB, checkC }) }),
    );

    expect(result.kind).toBe('ACCEPTED');
    expect(checkB).toHaveBeenCalledTimes(2);
    expect(checkC).toHaveBeenCalledTimes(1);
  });

  it('retries after Check C fails', async () => {
    const checkC = vi
      .fn<SlotRunnerDeps['checkC']>()
      .mockResolvedValueOnce({
        ok: false,
        embedding: null,
        reasons: [],
        skippedBankRefs: 0,
      })
      .mockResolvedValue({
        ok: true,
        embedding: basis(1),
        maxSimilarity: 0,
        skippedBankRefs: 0,
      });

    const result = await runSlot(
      makeArgs({ deps: fakeDeps({ checkC }) }),
    );

    expect(result.kind).toBe('ACCEPTED');
    if (result.kind === 'ACCEPTED') {
      expect(result.ref.embedding).toEqual(basis(1));
    }
    expect(checkC).toHaveBeenCalledTimes(2);
  });

  it('uses one attempt when the draft result is not ok', async () => {
    const draft = vi
      .fn<SlotRunnerDeps['draft']>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValue(draftOk());

    const result = await runSlot(makeArgs({ deps: fakeDeps({ draft }) }));

    expect(result.kind).toBe('ACCEPTED');
    expect(draft).toHaveBeenCalledTimes(2);
  });

  it('takes the next seed set after three failures and succeeds', async () => {
    const draft = vi
      .fn<SlotRunnerDeps['draft']>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValue(draftOk());

    const result = await runSlot(makeArgs({ deps: fakeDeps({ draft }) }));

    expect(result.kind).toBe('ACCEPTED');
    if (result.kind === 'ACCEPTED') {
      expect(result.replacementBudgetUsed).toBe(1);
      expect(result.primaryChunkId).toBe('chunk-1-1');
    }
    expect(draft).toHaveBeenCalledTimes(4);
    expect(draft.mock.calls[3][0].seedChunks[0].chunkId).toBe('chunk-1-1');
  });

  it('never reuses a reserved or accepted primary chunk', async () => {
    const plan = makePlan(10, 2);
    const draft = vi
      .fn<SlotRunnerDeps['draft']>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValue(draftOk());

    const result = await runSlot(
      makeArgs({
        plan,
        slot: plan.slots[0],
        usedPrimaryIds: new Set(['chunk-1-0']),
        deps: fakeDeps({ draft }),
      }),
    );

    expect(result.kind).toBe('ACCEPTED');
    if (result.kind === 'ACCEPTED') {
      expect(result.primaryChunkId).toBe('chunk-1-2');
    }
  });

  it('ends EXHAUSTED when the replacement budget is spent', async () => {
    const draft = vi.fn(async (): Promise<DraftResult> => ({
      ok: false,
      reason: 'DRAFT_INVALID_JSON',
      model: null,
      promptVersion: 'prompt-v1',
    }));

    const result = await runSlot(
      makeArgs({
        replacementBudgetRemaining: 0,
        deps: fakeDeps({ draft }),
      }),
    );

    expect(result).toMatchObject({
      kind: 'EXHAUSTED',
      replacementBudgetUsed: 0,
    });
    if (result.kind === 'EXHAUSTED') {
      expect(result.detail).toBe(
        'slot 0, attempts 3, replacements 0, budget 0',
      );
    }
    expect(draft).toHaveBeenCalledTimes(DRAFT_ATTEMPTS_PER_SLOT);
  });

  it('uses one replacement then ends EXHAUSTED', async () => {
    const draft = vi.fn(async (): Promise<DraftResult> => ({
      ok: false,
      reason: 'DRAFT_INVALID_JSON',
      model: null,
      promptVersion: 'prompt-v1',
    }));

    const result = await runSlot(makeArgs({ deps: fakeDeps({ draft }) }));

    expect(result).toMatchObject({
      kind: 'EXHAUSTED',
      replacementBudgetUsed: REPLACEMENTS_PER_SLOT,
    });
    expect(draft).toHaveBeenCalledTimes(DRAFT_ATTEMPTS_PER_SLOT * 2);
  });

  it('ends EXHAUSTED when no candidate primary is left', async () => {
    const plan = makePlan(1, 1);
    const draft = vi.fn(async (): Promise<DraftResult> => ({
      ok: false,
      reason: 'DRAFT_INVALID_JSON',
      model: null,
      promptVersion: 'prompt-v1',
    }));

    const result = await runSlot(
      makeArgs({ plan, slot: plan.slots[0], deps: fakeDeps({ draft }) }),
    );

    expect(result.kind).toBe('EXHAUSTED');
    expect(draft).toHaveBeenCalledTimes(DRAFT_ATTEMPTS_PER_SLOT);
  });

  it('ends EXHAUSTED immediately when the slot has no seed chunk id', async () => {
    const plan = makePlan();
    const slot = { index: 0, topicKey: 'topic-1', seedChunkIds: [] };
    const draft = vi.fn(fakeDeps().draft);

    const result = await runSlot(
      makeArgs({ plan, slot, deps: fakeDeps({ draft }) }),
    );

    expect(result.kind).toBe('EXHAUSTED');
    expect(draft).not.toHaveBeenCalled();
  });

  it('stops before the draft when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort('CANCEL');
    const draft = vi.fn(fakeDeps().draft);

    const result = await runSlot(
      makeArgs({ signal: controller.signal, deps: fakeDeps({ draft }) }),
    );

    expect(result).toEqual({ kind: 'STOPPED', cause: 'CANCEL' });
    expect(draft).not.toHaveBeenCalled();
  });

  it('stops before the write when the signal aborts during Check C', async () => {
    const controller = new AbortController();
    const checkC = vi.fn(async () => {
      controller.abort('DEADLINE');
      return {
        ok: true as const,
        embedding: basis(0),
        maxSimilarity: 0,
        skippedBankRefs: 0,
      };
    });
    const writeQuestion = vi.fn(fakeDeps().writeQuestion);

    const result = await runSlot(
      makeArgs({
        signal: controller.signal,
        deps: fakeDeps({ checkC, writeQuestion }),
      }),
    );

    expect(result).toEqual({ kind: 'STOPPED', cause: 'DEADLINE' });
    expect(writeQuestion).not.toHaveBeenCalled();
  });

  it('treats an unknown abort reason as a shutdown', () => {
    const controller = new AbortController();
    controller.abort('WHATEVER');
    expect(stopCauseOf(controller.signal)).toBe('SHUTDOWN');
  });

  it('does not leak source text in failed outcomes', async () => {
    const draft = vi.fn(async (): Promise<DraftResult> => ({
      ok: false,
      reason: 'DRAFT_INVALID_JSON',
      model: null,
      promptVersion: 'prompt-v1',
    }));
    const result = await runSlot(
      makeArgs({
        replacementBudgetRemaining: 0,
        deps: fakeDeps({ draft }),
      }),
    );

    expect(JSON.stringify(result)).not.toContain(SOURCE_SENTINEL);
  });

  it('does not mutate the accepted refs or used primary ids', async () => {
    const accepted = [acceptedRef()];
    const used = new Set(['chunk-1-0']);
    const draft = vi
      .fn<SlotRunnerDeps['draft']>()
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValueOnce({
        ok: false,
        reason: 'DRAFT_INVALID_JSON',
        model: null,
        promptVersion: 'prompt-v1',
      })
      .mockResolvedValue(draftOk());

    await runSlot(
      makeArgs({ accepted, usedPrimaryIds: used, deps: fakeDeps({ draft }) }),
    );

    expect(accepted).toHaveLength(1);
    expect([...used]).toEqual(['chunk-1-0']);
  });
});

/** One slot that loses one draft to each check, then is accepted. */
function oneRejectionPerCheck(logger?: WorkerLogger): SlotRunArgs {
  const draft = vi
    .fn<SlotRunnerDeps['draft']>()
    .mockResolvedValueOnce({
      ok: false,
      reason: 'DRAFT_INVALID_JSON',
      model: null,
      promptVersion: 'prompt-v1',
    })
    .mockResolvedValue(draftOk());
  const checkA = vi
    .fn<SlotRunnerDeps['checkA']>()
    .mockReturnValueOnce({ ok: false, reasons: [{ code: 'STEM_SENTENCE_COUNT' }] })
    .mockImplementation((value) => ({
      ok: true,
      draft: value as DraftQuestion,
    }));
  const checkB = vi
    .fn<SlotRunnerDeps['checkB']>()
    .mockResolvedValueOnce({
      ok: false,
      polarity: 'NORMAL',
      reasons: [{ code: 'VERIFIER_KEY_MISMATCH' }],
    })
    .mockResolvedValue({ ok: true, polarity: 'NORMAL', verdicts: [] });
  const checkC = vi
    .fn<SlotRunnerDeps['checkC']>()
    .mockResolvedValueOnce({
      ok: false,
      embedding: null,
      reasons: [{ code: 'DUPLICATE_IN_JOB' }],
      skippedBankRefs: 0,
    })
    .mockResolvedValue({
      ok: true,
      embedding: basis(1),
      maxSimilarity: 0,
      skippedBankRefs: 0,
    });

  return makeArgs({
    deps: fakeDeps({
      draft,
      checkA,
      checkB,
      checkC,
      ...(logger === undefined ? {} : { logger }),
    }),
  });
}

describe('runSlot rejection logging', () => {
  it('logs one rejection line per check with the first reason code only', async () => {
    const { logger, warns } = fakeLogger();

    const result = await runSlot(oneRejectionPerCheck(logger));

    expect(result.kind).toBe('ACCEPTED');
    expect(warns).toEqual([
      {
        event: 'generation.slot.rejected',
        fields: {
          jobId: 'job-1',
          slot: 0,
          check: 'DRAFT',
          code: 'DRAFT_INVALID_JSON',
        },
      },
      {
        event: 'generation.slot.rejected',
        fields: {
          jobId: 'job-1',
          slot: 0,
          check: 'A',
          code: 'STEM_SENTENCE_COUNT',
        },
      },
      {
        event: 'generation.slot.rejected',
        fields: {
          jobId: 'job-1',
          slot: 0,
          check: 'B',
          code: 'VERIFIER_KEY_MISMATCH',
        },
      },
      {
        event: 'generation.slot.rejected',
        fields: {
          jobId: 'job-1',
          slot: 0,
          check: 'C',
          code: 'DUPLICATE_IN_JOB',
        },
      },
    ]);
  });

  it('counts each rejection per check', async () => {
    const args = oneRejectionPerCheck(fakeLogger().logger);

    await runSlot(args);

    expect(args.counts).toEqual({ DRAFT: 1, A: 1, B: 1, C: 1 });
  });

  it('writes no source, stem, choice or quote text into the logs', async () => {
    const { logger, warns } = fakeLogger();

    await runSlot(oneRejectionPerCheck(logger));

    const logged = JSON.stringify(warns);
    expect(logged).not.toContain(SOURCE_SENTINEL);
    expect(logged).not.toContain('Stem one.');
    expect(logged).not.toContain('Choice A');
    expect(logged).not.toContain('Explanation A');
  });

  it('leaves the outcome unchanged and still counts without a logger', async () => {
    const args = oneRejectionPerCheck();

    const result = await runSlot(args);

    expect(result.kind).toBe('ACCEPTED');
    expect(args.counts).toEqual({ DRAFT: 1, A: 1, B: 1, C: 1 });
  });

  it('logs exhausted with attempts and replacements on slot failure', async () => {
    const { logger, warns } = fakeLogger();
    const draft = vi.fn(async (): Promise<DraftResult> => ({
      ok: false,
      reason: 'DRAFT_INVALID_JSON',
      model: null,
      promptVersion: 'prompt-v1',
    }));

    const result = await runSlot(
      makeArgs({
        replacementBudgetRemaining: 0,
        deps: fakeDeps({ draft, logger }),
      }),
    );

    expect(result.kind).toBe('EXHAUSTED');
    expect(warns).toContainEqual({
      event: 'generation.slot.exhausted',
      fields: { jobId: 'job-1', slot: 0, attempts: 3, replacements: 0 },
    });
  });

  it('logs a verifier retry when Check B asks for one', async () => {
    const { logger, warns } = fakeLogger();
    const checkB = vi.fn<SlotRunnerDeps['checkB']>(
      async (_draft, _pageText, opts) => {
        opts.onVerifierRetry?.();
        return { ok: true, polarity: 'NORMAL', verdicts: [] };
      },
    );

    await runSlot(makeArgs({ deps: fakeDeps({ checkB, logger }) }));

    expect(warns).toContainEqual({
      event: 'generation.slot.verifier_retry',
      fields: { jobId: 'job-1', slot: 0 },
    });
  });

  it('logs the Check C match key and similarity but no stem text', async () => {
    const { logger, warns } = fakeLogger();
    const checkC = vi
      .fn<SlotRunnerDeps['checkC']>()
      .mockResolvedValueOnce({
        ok: false,
        embedding: null,
        reasons: [
          { code: 'DUPLICATE_IN_BANK', detail: 'bank-question-7 0.9123' },
        ],
        skippedBankRefs: 0,
      })
      .mockResolvedValue({
        ok: true,
        embedding: basis(1),
        maxSimilarity: 0,
        skippedBankRefs: 0,
      });

    await runSlot(makeArgs({ deps: fakeDeps({ checkC, logger }) }));

    expect(warns).toContainEqual({
      event: 'generation.slot.rejected',
      fields: {
        jobId: 'job-1',
        slot: 0,
        check: 'C',
        code: 'DUPLICATE_IN_BANK',
        detail: 'bank-question-7 0.9123',
      },
    });
    expect(JSON.stringify(warns)).not.toContain('Stem one.');
  });
});

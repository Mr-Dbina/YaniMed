import { DRAFT_ATTEMPTS_PER_SLOT, VALIDATOR_VERSION } from '../generation.constants.js';
import type { GenerationPlan } from '../plan/planner.js';
import type { PlannedSlot } from '../plan/slots.js';
import type { SeedChunk } from '../draft/prompts.js';
import type { DraftQuestion } from '../validate/types.js';
import type { CheckAContext } from '../validate/types.js';
import type {
  AcceptedQuestionRef,
  BankSource,
} from '../validate/check-c.js';
import { REASON_CODES } from '../validate/types.js';
import type {
  DraftPort,
  CheckAPort,
  CheckBPort,
  CheckCPort,
  EmbedPort,
  JobInputs,
  Progress,
  RunnerFence,
  StopCause,
  WriteQuestionPort,
} from './ports.js';
import type { WorkerLogger } from '../worker/worker.types.js';

const STOP_CAUSES: ReadonlySet<string> = new Set([
  'CANCEL',
  'DEADLINE',
  'SHUTDOWN',
  'STALE_WORKER',
]);

/** The first abort reason wins; anything unknown is treated as a shutdown. */
export function stopCauseOf(signal: AbortSignal): StopCause {
  const reason: unknown = signal.reason;
  if (typeof reason === 'string' && STOP_CAUSES.has(reason)) {
    return reason as StopCause;
  }
  return 'SHUTDOWN';
}

export interface SlotRunnerDeps {
  draft: DraftPort;
  checkA: CheckAPort;
  checkB: CheckBPort;
  checkC: CheckCPort;
  writeQuestion: WriteQuestionPort;
  embed: EmbedPort;
  bank: BankSource;
  models: { verifier: string };
  logger?: WorkerLogger;
}

export type RejectionCheck = 'DRAFT' | 'A' | 'B' | 'C';

/** Chunks and pages to avoid first; used only when no fresher seed is left. */
export interface SeedExclusions {
  chunkIds?: ReadonlySet<string>;
  /** Key is documentId + ':' + page. */
  pages?: ReadonlySet<string>;
}

/** Rejections that forced a slot to move off its current chunk. */
const ROTATE_CODES: ReadonlySet<string> = new Set([
  REASON_CODES.DUPLICATE_IN_BANK,
  REASON_CODES.SAME_PAGE_SAME_FACT,
]);

/** Per-check rejection totals for one job. */
export type RejectionCounts = Record<RejectionCheck, number>;

export function emptyRejectionCounts(): RejectionCounts {
  return { DRAFT: 0, A: 0, B: 0, C: 0 };
}

export interface SlotRunArgs {
  slot: PlannedSlot;
  plan: GenerationPlan;
  inputs: JobInputs;
  fence: RunnerFence;
  subjectId: string;
  subjectName: string;
  topicId: string;
  signal: AbortSignal;
  accepted: AcceptedQuestionRef[];
  acceptedObjectives: string[];
  /** Bank objectives to avoid for this slot; may be empty. */
  bankObjectives?: readonly string[];
  /** Primaries of accepted questions in this topic and earlier seed sets. */
  usedPrimaryIds: ReadonlySet<string>;
  /** Bank-cited chunks/pages to avoid before falling back to any seed. */
  seedExclusions?: SeedExclusions;
  /** Shared job set of chunks that produced a duplicate/same-page rejection. */
  rejectedChunkIds?: Set<string>;
  replacementBudgetRemaining: number;
  deps: SlotRunnerDeps;
  onProgress?: (progress: Progress) => void;
  /** Shared with the job runner for the end-of-job summary. */
  counts: RejectionCounts;
}

export type SlotOutcome =
  | {
      kind: 'ACCEPTED';
      ref: AcceptedQuestionRef;
      primaryChunkId: string;
      replacementBudgetUsed: number;
    }
  | {
      kind: 'EXHAUSTED';
      detail: string;
      replacementBudgetUsed: number;
    }
  | { kind: 'STOPPED'; cause: StopCause };

interface SeedSet {
  primary: string;
  ids: string[];
}

function exhaustedOutcome(
  slotIndex: number,
  attempts: number,
  replacements: number,
  remaining: number,
): SlotOutcome {
  return {
    kind: 'EXHAUSTED',
    detail: `slot ${slotIndex}, attempts ${attempts}, replacements ${replacements}, budget ${remaining}`,
    replacementBudgetUsed: replacements,
  };
}

function toSeedChunks(
  ids: readonly string[],
  inputs: JobInputs,
): SeedChunk[] {
  const chunks = new Map(inputs.chunks.map((chunk) => [chunk.id, chunk]));
  const seeds: SeedChunk[] = [];
  for (const id of ids) {
    const chunk = chunks.get(id);
    if (chunk === undefined) continue;
    seeds.push({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      documentTitle: inputs.documents.get(chunk.documentId)?.title ?? '',
      pageStart: chunk.page,
      pageEnd: chunk.page,
      text: chunk.content,
    });
  }
  return seeds;
}

function reservedPrimaries(plan: GenerationPlan, topicKey: string): Set<string> {
  const primaries = new Set<string>();
  for (const slot of plan.slots) {
    if (slot.topicKey !== topicKey) continue;
    const primary = slot.seedChunkIds[0];
    if (primary !== undefined) primaries.add(primary);
  }
  return primaries;
}

function isFreshChunk(
  id: string,
  pageByChunkId: ReadonlyMap<string, string>,
  exclusions: { chunkIds: ReadonlySet<string>; pages: ReadonlySet<string> },
): boolean {
  if (exclusions.chunkIds.has(id)) return false;
  const page = pageByChunkId.get(id);
  return page === undefined || !exclusions.pages.has(page);
}

function pickFresh(
  available: readonly string[],
  pageByChunkId: ReadonlyMap<string, string>,
  exclusions: { chunkIds: ReadonlySet<string>; pages: ReadonlySet<string> },
): string {
  return (
    available.find((id) => isFreshChunk(id, pageByChunkId, exclusions)) ??
    available.find((id) => !exclusions.chunkIds.has(id)) ??
    available[0]
  );
}

function alternativeSeed(
  plan: GenerationPlan,
  topicKey: string,
  used: ReadonlySet<string>,
  chunkIds: ReadonlySet<string>,
  pageByChunkId: ReadonlyMap<string, string>,
  exclusions: {
    chunkIds: ReadonlySet<string>;
    pages: ReadonlySet<string>;
  },
): SeedSet | null {
  const candidates = (plan.candidates[topicKey] ?? []).filter(
    (id) => chunkIds.has(id) && !used.has(id),
  );
  const reserved = reservedPrimaries(plan, topicKey);
  const available = candidates.filter((id) => !reserved.has(id));
  if (available.length === 0) return null;

  const primary = pickFresh(available, pageByChunkId, exclusions);
  const companions = available
    .filter((id) => id !== primary)
    .sort(
      (a, b) =>
        Number(isFreshChunk(b, pageByChunkId, exclusions)) -
        Number(isFreshChunk(a, pageByChunkId, exclusions)),
    )
    .slice(0, 2);
  return { primary, ids: [primary, ...companions] };
}

/**
 * The plan's primary unless the bank already cites its chunk or page. In that
 * case pick the freshest candidate the other slots have not reserved.
 */
function initialSeed(
  plan: GenerationPlan,
  slot: PlannedSlot,
  basePrimary: string,
  used: ReadonlySet<string>,
  chunkIds: ReadonlySet<string>,
  pageByChunkId: ReadonlyMap<string, string>,
  exclusions: {
    chunkIds: ReadonlySet<string>;
    pages: ReadonlySet<string>;
  },
): SeedSet {
  const base: SeedSet = {
    primary: basePrimary,
    ids: [...slot.seedChunkIds],
  };
  if (isFreshChunk(basePrimary, pageByChunkId, exclusions)) return base;

  const reserved = reservedPrimaries(plan, slot.topicKey);
  reserved.delete(basePrimary);
  const available = (plan.candidates[slot.topicKey] ?? []).filter(
    (id) =>
      chunkIds.has(id) && !used.has(id) && !reserved.has(id),
  );
  if (available.length === 0) return base;

  const primary = pickFresh(available, pageByChunkId, exclusions);
  const companions = slot.seedChunkIds
    .filter(
      (id) =>
        id !== basePrimary &&
        chunkIds.has(id) &&
        !used.has(id) &&
        isFreshChunk(id, pageByChunkId, exclusions),
    )
    .slice(0, 2);
  return { primary, ids: [primary, ...companions] };
}

function pageTextOf(draft: DraftQuestion, inputs: JobInputs): string {
  return (
    inputs.pages.get(`${draft.citation.documentId}:${draft.citation.page}`)
      ?.text ?? ''
  );
}

/**
 * Drafts, validates and writes one slot. Provider, budget and stale-worker
 * errors propagate to the job runner so one mapper owns the outcome.
 */
export async function runSlot(args: SlotRunArgs): Promise<SlotOutcome> {
  const { slot, inputs, deps, signal } = args;
  const logger = deps.logger;
  const jobId = args.fence.jobId;

  let lastRejectionCode: string | undefined;

  const logReject = (
    check: RejectionCheck,
    code: string | undefined,
    detail?: string,
  ): void => {
    args.counts[check] += 1;
    lastRejectionCode = code;
    logger?.warn('generation.slot.rejected', {
      jobId,
      slot: slot.index,
      check,
      code,
      ...(check === 'C' && detail !== undefined ? { detail } : {}),
    });
  };

  const exhausted = (attempts: number, replacements: number): SlotOutcome => {
    logger?.warn('generation.slot.exhausted', {
      jobId,
      slot: slot.index,
      attempts,
      replacements,
    });
    return exhaustedOutcome(
      slot.index,
      attempts,
      replacements,
      args.replacementBudgetRemaining,
    );
  };

  const basePrimary = slot.seedChunkIds[0];
  if (basePrimary === undefined) {
    return exhausted(0, 0);
  }

  const chunkIds = new Set(inputs.chunks.map((chunk) => chunk.id));
  const pageByChunkId = new Map(
    inputs.chunks.map((chunk) => [
      chunk.id,
      `${chunk.documentId}:${chunk.page}`,
    ]),
  );
  const excludedChunkIds = new Set(args.seedExclusions?.chunkIds ?? []);
  const excludedPages = new Set(args.seedExclusions?.pages ?? []);
  const topicName =
    args.plan.topics.find((topic) => topic.topicKey === slot.topicKey)?.name ??
    slot.topicKey;
  const used = new Set(args.usedPrimaryIds);

  const checkAContext: CheckAContext = {
    topicKeys: new Set(args.plan.topics.map((topic) => topic.topicKey)),
    documents: inputs.documents,
    getPage: (documentId, page) =>
      inputs.pages.get(`${documentId}:${page}`) ?? null,
  };

  const avoidStems: string[] = [];
  const rejected = (stem: string): void => {
    if (avoidStems.length < DRAFT_ATTEMPTS_PER_SLOT) avoidStems.push(stem);
  };

  let seed: SeedSet = initialSeed(
    args.plan,
    slot,
    basePrimary,
    used,
    chunkIds,
    pageByChunkId,
    { chunkIds: excludedChunkIds, pages: excludedPages },
  );
  used.add(seed.primary);
  let replacements = 0;
  let attempts = 0;

  for (;;) {
    for (let attempt = 0; attempt < DRAFT_ATTEMPTS_PER_SLOT; attempt += 1) {
      attempts += 1;
      if (signal.aborted) return { kind: 'STOPPED', cause: stopCauseOf(signal) };

      const seedChunks = toSeedChunks(seed.ids, inputs);
      const draftResult = await deps.draft({
        jobId: args.fence.jobId,
        subjectId: args.subjectId,
        subjectName: args.subjectName,
        topic: { topicKey: slot.topicKey, name: topicName },
        seedChunks,
        acceptedObjectives: [...args.acceptedObjectives],
        ...(args.bankObjectives === undefined
          ? {}
          : { bankObjectives: [...args.bankObjectives] }),
        styleHint: inputs.styleHint,
        avoidStems: [...avoidStems],
        ...(lastRejectionCode === undefined
          ? {}
          : { lastRejectionCode }),
        signal,
      });
      if (!draftResult.ok) {
        logReject('DRAFT', draftResult.reason);
        continue;
      }

      const draft = draftResult.draft;
      args.onProgress?.({
        phase: 'VALIDATING',
        acceptedCount: args.accepted.length,
      });

      const checkA = deps.checkA(draft, checkAContext);
      if (!checkA.ok) {
        logReject('A', checkA.reasons[0]?.code);
        rejected(draft.stem);
        continue;
      }

      if (signal.aborted) return { kind: 'STOPPED', cause: stopCauseOf(signal) };
      const checkB = await deps.checkB(draft, pageTextOf(draft, inputs), {
        jobId: args.fence.jobId,
        subjectId: args.subjectId,
        signal,
        onVerifierRetry: () => {
          logger?.warn('generation.slot.verifier_retry', {
            jobId,
            slot: slot.index,
          });
        },
        logger,
      });
      if (!checkB.ok) {
        logReject('B', checkB.reasons[0]?.code);
        rejected(draft.stem);
        continue;
      }

      if (signal.aborted) return { kind: 'STOPPED', cause: stopCauseOf(signal) };
      const checkC = await deps.checkC(draft, {
        jobId: args.fence.jobId,
        subjectId: args.subjectId,
        accepted: args.accepted,
        bank: deps.bank,
        embed: deps.embed,
        signal,
      });
      if (!checkC.ok) {
        const code = checkC.reasons[0]?.code;
        logReject('C', code, checkC.reasons[0]?.detail);
        rejected(draft.stem);
        if (code !== undefined && ROTATE_CODES.has(code)) {
          // The same chunk will keep producing the same duplicate or same-page
          // fact. Record it and leave the inner loop so the seed rotates.
          args.rejectedChunkIds?.add(seed.primary);
          used.add(seed.primary);
          excludedChunkIds.add(seed.primary);
          const page = pageByChunkId.get(seed.primary);
          if (page !== undefined) excludedPages.add(page);
          break;
        }
        continue;
      }

      if (signal.aborted) return { kind: 'STOPPED', cause: stopCauseOf(signal) };
      const written = await deps.writeQuestion({
        fence: args.fence,
        subjectId: args.subjectId,
        draft,
        topicId: args.topicId,
        provenance: {
          draftModel: draftResult.model,
          verifierModel: deps.models.verifier,
          promptVersion: draftResult.promptVersion,
          validatorVersion: VALIDATOR_VERSION,
        },
        embedding: checkC.embedding,
      });

      const ref: AcceptedQuestionRef = {
        key: written.questionId,
        embedding: checkC.embedding,
        topicKey: slot.topicKey,
        objective: draft.objective,
        documentId: draft.citation.documentId,
        page: draft.citation.page,
        quote: draft.citation.quote,
        keyChoiceText: draft.choices[draft.keyIndex]?.text ?? '',
      };

      return {
        kind: 'ACCEPTED',
        ref,
        primaryChunkId: seed.primary,
        replacementBudgetUsed: replacements,
      };
    }

    if (replacements >= args.replacementBudgetRemaining) {
      return exhausted(attempts, replacements);
    }

    const next = alternativeSeed(
      args.plan,
      slot.topicKey,
      used,
      chunkIds,
      pageByChunkId,
      { chunkIds: excludedChunkIds, pages: excludedPages },
    );
    if (next === null) {
      return exhausted(attempts, replacements);
    }

    used.add(next.primary);
    replacements += 1;
    seed = next;
  }
}

import {
  QUESTIONS_PER_TEST,
  REPLACEMENT_BUDGET,
} from '../generation.constants.js';
import { GenerationError } from '../generation.errors.js';
import type { GenerationPlan } from '../plan/planner.js';
import { PlanInsufficientContentError } from '../plan/planner.js';
import { defaultCheckDContext, type SetQuestionRef } from '../validate/check-d.js';
import { REASON_CODES } from '../validate/types.js';
import type { AcceptedQuestionRef } from '../validate/check-c.js';
import type {
  JobInputs,
  RunnerDeps,
  RunnerFence,
  RunOutcome,
  WrittenQuestion,
} from './ports.js';
import { runSlot, stopCauseOf, type SlotRunnerDeps } from './slot-runner.js';

export interface RunJobArgs {
  job: { id: string; subjectId: string; requestedCount: number };
  fence: RunnerFence;
  signal: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorCode(err: unknown): string | undefined {
  if (err instanceof GenerationError) return err.code;
  if (isRecord(err) && typeof err.code === 'string') return err.code;
  return undefined;
}

function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  if (isRecord(err) && typeof err.name === 'string') return err.name;
  return 'UnknownError';
}

function countsDetail(details: Record<string, number>): string {
  return Object.entries(details)
    .map(([key, value]) => `${key} ${value}`)
    .join(', ');
}

export function stoppedOutcome(signal: AbortSignal): RunOutcome {
  return { kind: 'STOPPED', cause: stopCauseOf(signal) };
}

/**
 * One mapper for every thrown dependency error. Error messages are never
 * copied: they can carry source text or model output.
 */
export function mapRunnerError(err: unknown, signal: AbortSignal): RunOutcome {
  const name = errorName(err);
  if (signal.aborted && name === 'AbortError') return stoppedOutcome(signal);

  const code = errorCode(err);

  if (err instanceof PlanInsufficientContentError) {
    return {
      kind: 'FAILED',
      reason: 'INSUFFICIENT_CONTENT',
      code: code ?? 'INSUFFICIENT_CONTENT',
      detail: countsDetail(err.details),
    };
  }

  switch (code) {
    case 'GENERATION_STALE_WORKER':
      return { kind: 'STOPPED', cause: 'STALE_WORKER' };
    case 'GENERATION_BUDGET_EXHAUSTED':
      return { kind: 'FAILED', reason: 'BUDGET_EXHAUSTED', code };
    case 'GENERATION_PROVIDER_UNAVAILABLE':
    case 'GENERATION_AI_TIMEOUT':
      return { kind: 'FAILED', reason: 'PROVIDER_UNAVAILABLE', code };
    case 'GENERATION_NOT_FOUND':
      return { kind: 'FAILED', reason: 'SOURCE_CHANGED', code };
    case 'GENERATION_VERIFIER_NOT_CONFIGURED':
      return { kind: 'FAILED', reason: 'INTERNAL', code, detail: name };
    default:
      break;
  }

  return {
    kind: 'FAILED',
    reason: 'INTERNAL',
    ...(code === undefined ? {} : { code }),
    detail: name,
  };
}

function objectivesByTopic(
  accepted: readonly AcceptedQuestionRef[],
): Map<string, string[]> {
  const objectives = new Map<string, string[]>();
  for (const ref of accepted) {
    const key = ref.topicKey.trim();
    const list = objectives.get(key);
    if (list === undefined) objectives.set(key, [ref.objective]);
    else list.push(ref.objective);
  }
  return objectives;
}

function refFromWritten(
  question: WrittenQuestion,
  embedding: number[],
): AcceptedQuestionRef {
  const citation = question.citations[0];
  return {
    key: question.questionId,
    embedding,
    topicKey: question.topicKey.trim(),
    objective: question.objective,
    documentId: citation?.documentId ?? '',
    page: citation?.page ?? 0,
    quote: citation?.quote ?? '',
    keyChoiceText: question.keyChoiceText,
  };
}

function setQuestionsOf(
  written: readonly WrittenQuestion[],
  embeddings: ReadonlyMap<string, number[]>,
): SetQuestionRef[] {
  return written.map((question) => ({
    questionId: question.questionId,
    status: question.status,
    topicKey: question.topicKey,
    objective: question.objective,
    embedding: embeddings.get(question.questionId) ?? null,
    citations: question.citations.map((citation) => ({
      documentId: citation.documentId,
      page: citation.page,
    })),
  }));
}

async function execute(
  args: RunJobArgs,
  deps: RunnerDeps,
): Promise<RunOutcome> {
  const { job, fence, signal } = args;
  const { source, planStore, writtenStore } = deps;

  deps.onProgress?.({ phase: 'PLANNING', acceptedCount: 0 });
  const inputs: JobInputs = await source.load(job.id);

  if (signal.aborted) return stoppedOutcome(signal);

  let plan: GenerationPlan | null = await planStore.load(job.id);
  if (plan === null) {
    if (signal.aborted) return stoppedOutcome(signal);
    plan = await deps.planner.plan({
      jobId: job.id,
      subjectId: job.subjectId,
      chunks: inputs.chunks,
    });
    await planStore.save(fence, plan);
  }

  if (signal.aborted) return stoppedOutcome(signal);

  const topicIds = await deps.ensureTopics(
    job.subjectId,
    plan.topics.map((topic) => ({ topicKey: topic.topicKey, name: topic.name })),
  );

  if (signal.aborted) return stoppedOutcome(signal);

  const written = await writtenStore.listWritten(job.id);
  const embeddings = new Map<string, number[]>();
  const accepted: AcceptedQuestionRef[] = [];

  for (const question of written) {
    if (signal.aborted) return stoppedOutcome(signal);
    const embedding = await deps.embed({
      jobId: job.id,
      text: `${question.stem}\n${question.leadIn ?? ''}`,
    });
    embeddings.set(question.questionId, embedding);
    accepted.push(refFromWritten(question, embedding));
  }

  const writtenByTopic = new Map<string, number>();
  for (const question of written) {
    const key = question.topicKey.trim();
    writtenByTopic.set(key, (writtenByTopic.get(key) ?? 0) + 1);
  }

  const usedPrimaryIdsByTopic = new Map<string, Set<string>>();
  const ordinalByTopic = new Map<string, number>();
  const remainingSlots = [];
  for (const slot of plan.slots) {
    const key = slot.topicKey.trim();
    const ordinal = ordinalByTopic.get(key) ?? 0;
    ordinalByTopic.set(key, ordinal + 1);

    if (ordinal < (writtenByTopic.get(key) ?? 0)) {
      const primary = slot.seedChunkIds[0];
      if (primary !== undefined) {
        const used = usedPrimaryIdsByTopic.get(key) ?? new Set<string>();
        used.add(primary);
        usedPrimaryIdsByTopic.set(key, used);
      }
      continue;
    }
    remainingSlots.push(slot);
  }

  const slotDeps: SlotRunnerDeps = {
    draft: deps.draft,
    checkA: deps.checkA,
    checkB: deps.checkB,
    checkC: deps.checkC,
    writeQuestion: deps.writeQuestion,
    embed: deps.embed,
    bank: deps.bank,
    models: deps.models,
  };
  let budgetRemaining = REPLACEMENT_BUDGET;
  let acceptedCount = accepted.length;

  for (const slot of remainingSlots) {
    const key = slot.topicKey.trim();
    const objectives = objectivesByTopic(accepted).get(key) ?? [];
    const outcome = await runSlot({
      slot,
      plan,
      inputs,
      fence,
      subjectId: job.subjectId,
      subjectName: inputs.subjectName,
      topicId: topicIds.get(key) ?? topicIds.get(slot.topicKey) ?? '',
      signal,
      accepted,
      acceptedObjectives: objectives,
      usedPrimaryIds: usedPrimaryIdsByTopic.get(key) ?? new Set(),
      replacementBudgetRemaining: budgetRemaining,
      deps: slotDeps,
      onProgress: deps.onProgress,
    });

    if (outcome.kind === 'STOPPED') return outcome;
    if (outcome.kind === 'FAILED') {
      return {
        kind: 'FAILED',
        reason: outcome.reason,
        detail: outcome.detail,
      };
    }

    budgetRemaining -= outcome.replacementBudgetUsed;
    accepted.push(outcome.ref);
    embeddings.set(outcome.ref.key, outcome.ref.embedding);

    const used = usedPrimaryIdsByTopic.get(key) ?? new Set<string>();
    used.add(outcome.primaryChunkId);
    usedPrimaryIdsByTopic.set(key, used);

    acceptedCount += 1;
    deps.onProgress?.({ phase: 'DRAFTING', acceptedCount });
    if (acceptedCount >= QUESTIONS_PER_TEST) break;
  }

  if (acceptedCount !== QUESTIONS_PER_TEST) {
    return {
      kind: 'FAILED',
      reason: 'VALIDATION_EXHAUSTED',
      detail: `accepted ${acceptedCount}, slots ${remainingSlots.length}`,
    };
  }

  deps.onProgress?.({ phase: 'FINALIZING', acceptedCount });

  const finalWritten = await writtenStore.listWritten(job.id);
  const pageCounts = new Map<string, number>();
  for (const [documentId, document] of inputs.documents) {
    pageCounts.set(documentId, document.pageCount);
  }
  const checked = deps.checkD(
    setQuestionsOf(finalWritten, embeddings),
    defaultCheckDContext(inputs.snapshotDocumentIds, pageCounts),
  );

  if (checked.ok) {
    return { kind: 'COMPLETED', acceptedCount: finalWritten.length };
  }

  const documentGone = checked.reasons.some(
    (reason) => reason.code === REASON_CODES.SET_CITATION_DOCUMENT_GONE,
  );
  return {
    kind: 'FAILED',
    reason: documentGone ? 'SOURCE_CHANGED' : 'VALIDATION_EXHAUSTED',
    ...(checked.reasons[0] === undefined
      ? {}
      : { code: checked.reasons[0].code }),
    detail: `reasons ${checked.reasons.length}`,
  };
}

/**
 * Runs one already-claimed job. No state transitions, no timers, no DB: every
 * effect comes through the injected ports.
 */
export async function runJob(
  args: RunJobArgs,
  deps: RunnerDeps,
): Promise<RunOutcome> {
  if (args.job.requestedCount !== QUESTIONS_PER_TEST) {
    return {
      kind: 'FAILED',
      reason: 'INTERNAL',
      detail: `requestedCount ${args.job.requestedCount}`,
    };
  }
  if (args.signal.aborted) return stoppedOutcome(args.signal);

  try {
    return await execute(args, deps);
  } catch (err) {
    return mapRunnerError(err, args.signal);
  }
}

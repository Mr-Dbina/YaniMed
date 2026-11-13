import type { GenerationAiService } from '../ai/generation-ai.service.js';
import { extractJsonObject } from '../text/json.js';
import type { DraftChoice, DraftCitation, DraftQuestion } from '../validate/types.js';
import { PROMPT_VERSION } from './prompt-version.js';
import {
  buildDraftMessages,
  type DraftStyleHint,
  type SeedChunk,
} from './prompts.js';

export const DRAFT_REASON_CODES = {
  DRAFT_INVALID_JSON: 'DRAFT_INVALID_JSON',
  DRAFT_SHAPE_INVALID: 'DRAFT_SHAPE_INVALID',
  DRAFT_CITATION_NOT_IN_SEEDS: 'DRAFT_CITATION_NOT_IN_SEEDS',
  DRAFT_TOPIC_MISMATCH: 'DRAFT_TOPIC_MISMATCH',
} as const;

export type DraftReason =
  (typeof DRAFT_REASON_CODES)[keyof typeof DRAFT_REASON_CODES];

export interface DraftQuestionArgs {
  jobId: string;
  subjectId?: string;
  subjectName: string;
  topic: { topicKey: string; name: string };
  seedChunks: SeedChunk[];
  acceptedObjectives: string[];
  styleHint?: DraftStyleHint;
  avoidStems?: string[];
  signal?: AbortSignal;
}

export type DraftResult =
  | {
      ok: true;
      draft: DraftQuestion;
      model: string;
      promptVersion: string;
    }
  | {
      ok: false;
      reason: DraftReason;
      model: string | null;
      promptVersion: string;
    };

type ShapeReason =
  | typeof DRAFT_REASON_CODES.DRAFT_INVALID_JSON
  | typeof DRAFT_REASON_CODES.DRAFT_SHAPE_INVALID;

type ParsedDraft = {
  draft: Omit<DraftQuestion, 'topicKey'>;
  /** Model-supplied topic, when present. Never copied into the draft. */
  topicKey: string | null;
};

type ParseOutcome =
  | { ok: true; parsed: ParsedDraft }
  | { ok: false; reason: ShapeReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCitation(value: unknown): DraftCitation | null {
  if (!isRecord(value)) return null;
  if (typeof value.documentId !== 'string') return null;
  if (typeof value.page !== 'number' || !Number.isInteger(value.page)) {
    return null;
  }
  if (typeof value.quote !== 'string') return null;

  let printedPage: number | null = null;
  if (value.printedPage !== undefined && value.printedPage !== null) {
    if (
      typeof value.printedPage !== 'number' ||
      !Number.isFinite(value.printedPage)
    ) {
      return null;
    }
    printedPage = value.printedPage;
  }

  return {
    documentId: value.documentId,
    page: value.page,
    printedPage,
    quote: value.quote,
  };
}

function parseChoices(value: unknown): DraftChoice[] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;

  const choices: DraftChoice[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (typeof entry.text !== 'string') return null;
    if (typeof entry.explanation !== 'string') return null;
    choices.push({ text: entry.text, explanation: entry.explanation });
  }
  return choices;
}

function parseLeadIn(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  return value.trim() === '' ? null : value;
}

/** Shape only. Check A owns sentence counts, banned choices and quotes. */
function parseDraft(text: string): ParseOutcome {
  let body: unknown;
  try {
    body = JSON.parse(extractJsonObject(text));
  } catch {
    return { ok: false, reason: DRAFT_REASON_CODES.DRAFT_INVALID_JSON };
  }

  if (!isRecord(body)) {
    return { ok: false, reason: DRAFT_REASON_CODES.DRAFT_SHAPE_INVALID };
  }

  const leadIn = parseLeadIn(body.leadIn);
  const choices = parseChoices(body.choices);
  const citation = parseCitation(body.citation);
  if (
    typeof body.stem !== 'string' ||
    leadIn === undefined ||
    choices === null ||
    typeof body.keyIndex !== 'number' ||
    !Number.isInteger(body.keyIndex) ||
    body.keyIndex < 0 ||
    body.keyIndex >= choices.length ||
    typeof body.objective !== 'string' ||
    typeof body.keyExplanation !== 'string' ||
    citation === null
  ) {
    return { ok: false, reason: DRAFT_REASON_CODES.DRAFT_SHAPE_INVALID };
  }

  let topicKey: string | null = null;
  if (body.topicKey !== undefined && body.topicKey !== null) {
    if (typeof body.topicKey !== 'string') {
      return { ok: false, reason: DRAFT_REASON_CODES.DRAFT_SHAPE_INVALID };
    }
    const trimmed = body.topicKey.trim();
    topicKey = trimmed === '' ? null : trimmed;
  }

  return {
    ok: true,
    parsed: {
      draft: {
        stem: body.stem,
        leadIn,
        choices,
        keyIndex: body.keyIndex,
        objective: body.objective,
        keyExplanation: body.keyExplanation,
        citation,
      },
      topicKey,
    },
  };
}

function citationInSeeds(
  citation: DraftCitation,
  seeds: readonly SeedChunk[],
): boolean {
  return seeds.some(
    (chunk) =>
      chunk.documentId === citation.documentId &&
      citation.page >= chunk.pageStart &&
      citation.page <= chunk.pageEnd,
  );
}

/**
 * One slot, up to two model calls. JSON and shape failures retry once; a
 * citation or topic problem is returned immediately so the caller can redraft
 * the slot. Budget, breaker, timeout and config errors propagate untouched.
 */
export async function draftQuestion(
  args: DraftQuestionArgs,
  ai: Pick<GenerationAiService, 'complete'>,
): Promise<DraftResult> {
  const messages = buildDraftMessages({
    subjectName: args.subjectName,
    topic: args.topic,
    seedChunks: args.seedChunks,
    acceptedObjectives: args.acceptedObjectives,
    avoidStems: args.avoidStems,
    styleHint: args.styleHint,
  });

  let model: string | null = null;
  let lastShapeReason: ShapeReason = DRAFT_REASON_CODES.DRAFT_INVALID_JSON;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await ai.complete({
      purpose: 'DRAFT',
      jobId: args.jobId,
      ...(args.subjectId === undefined ? {} : { subjectId: args.subjectId }),
      messages,
      temperature: 0.4,
      jsonMode: true,
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
    model = result.model;

    const parsed = parseDraft(result.text);
    if (!parsed.ok) {
      lastShapeReason = parsed.reason;
      continue;
    }

    if (
      parsed.parsed.topicKey !== null &&
      parsed.parsed.topicKey !== args.topic.topicKey
    ) {
      return {
        ok: false,
        reason: DRAFT_REASON_CODES.DRAFT_TOPIC_MISMATCH,
        model,
        promptVersion: PROMPT_VERSION,
      };
    }

    if (!citationInSeeds(parsed.parsed.draft.citation, args.seedChunks)) {
      return {
        ok: false,
        reason: DRAFT_REASON_CODES.DRAFT_CITATION_NOT_IN_SEEDS,
        model,
        promptVersion: PROMPT_VERSION,
      };
    }

    return {
      ok: true,
      draft: {
        ...parsed.parsed.draft,
        topicKey: args.topic.topicKey,
      },
      model,
      promptVersion: PROMPT_VERSION,
    };
  }

  return {
    ok: false,
    reason: lastShapeReason,
    model,
    promptVersion: PROMPT_VERSION,
  };
}

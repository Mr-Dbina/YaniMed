import { PrismaService } from '../../../prisma/prisma.service.js';
import { GenerationError } from '../generation.errors.js';
import type { DraftQuestion } from '../validate/types.js';

/** Generous because the free Supabase test database can be slow. */
const TX_OPTIONS = { maxWait: 30_000, timeout: 60_000 } as const;

/** Held questions are not eligible for attempts until the job publishes. */
export const HELD_QUESTION_STATUS = 'QUARANTINED' as const;

/**
 * shortcut: DraftQuestion carries no model or prompt provenance, so the writer
 * uses one stable label until the worker passes real values in a later step.
 */
const PROVENANCE = {
  draftModel: 'generation-worker',
  verifierModel: null,
  promptVersion: 'm5',
  validatorVersion: 'm5',
} as const;

export interface WriteProvenance {
  draftModel: string;
  verifierModel: string | null;
  promptVersion: string;
  validatorVersion: string;
}

export interface WriteQuestionArgs {
  fence: { jobId: string; recoveryCount: number };
  subjectId: string;
  draft: DraftQuestion;
  topicId: string;
  /** No question-position column exists; accepted for API stability. */
  position?: number;
  /** Overrides the placeholder provenance when the runner supplies real values. */
  provenance?: WriteProvenance;
}

export interface WriteQuestionResult {
  questionId: string;
  acceptedCount: number;
}

let defaultClient: PrismaService | null = null;

/** Lazy singleton so importing this module never opens a database connection. */
export function getGenerationPrisma(): PrismaService {
  if (defaultClient === null) defaultClient = new PrismaService();
  return defaultClient;
}

function sharedClient(): PrismaService {
  return getGenerationPrisma();
}

function invalidArgument(message: string): RangeError {
  return new RangeError(message);
}

function assertValid(args: WriteQuestionArgs): void {
  const { draft } = args;
  if (draft.choices.length !== 4) {
    throw invalidArgument('draft.choices must contain exactly 4 choices.');
  }
  if (
    !Number.isInteger(draft.keyIndex) ||
    draft.keyIndex < 0 ||
    draft.keyIndex >= draft.choices.length
  ) {
    throw invalidArgument('draft.keyIndex is out of range.');
  }
  if (!Number.isInteger(draft.citation.page) || draft.citation.page < 1) {
    throw invalidArgument('draft.citation.page must be a positive integer.');
  }
  if (args.subjectId.trim() === '') {
    throw invalidArgument('subjectId must not be empty.');
  }
  if (args.topicId.trim() === '') {
    throw invalidArgument('topicId must not be empty.');
  }
  if (!Number.isInteger(args.fence.recoveryCount) || args.fence.recoveryCount < 0) {
    throw invalidArgument('fence.recoveryCount must be a non-negative integer.');
  }
}

function explanationWithKey(choice: string, keyExplanation: string): string {
  const key = keyExplanation.trim();
  if (key === '' || choice.includes(key)) return choice;
  return `${choice}\n\n${key}`;
}

/**
 * Persists one validated draft in a single fenced transaction. The counter is
 * claimed first with `acceptedCount < requestedCount`; any later failure rolls
 * back the counter, so a partial question can never exist.
 */
export async function writeQuestion(
  args: WriteQuestionArgs,
  client: PrismaService = sharedClient(),
): Promise<WriteQuestionResult> {
  assertValid(args);
  const { fence, draft } = args;

  return client.$transaction(async (tx) => {
    const provenance = args.provenance ?? PROVENANCE;
    const rows = await tx.$queryRaw<{ acceptedCount: number }[]>`
      UPDATE "GenerationJob"
      SET "acceptedCount" = "acceptedCount" + 1
      WHERE "id" = ${fence.jobId}
        AND "state" = 'RUNNING'
        AND "recoveryCount" = ${fence.recoveryCount}
        AND "acceptedCount" < "requestedCount"
      RETURNING "acceptedCount"
    `;

    const row = rows[0];
    if (!row) {
      const job = await tx.generationJob.findUnique({
        where: { id: fence.jobId },
        select: { acceptedCount: true, requestedCount: true },
      });
      if (!job) {
        throw new GenerationError('GENERATION_NOT_FOUND', { jobId: fence.jobId });
      }
      if (job.acceptedCount >= job.requestedCount) {
        throw new GenerationError('GENERATION_ACCEPTED_CAP', {
          jobId: fence.jobId,
        });
      }
      throw new GenerationError('GENERATION_STALE_WORKER', {
        jobId: fence.jobId,
      });
    }

    const topic = await tx.subjectTopic.findUnique({
      where: { id: args.topicId },
      select: { subjectId: true },
    });
    if (!topic || topic.subjectId !== args.subjectId) {
      throw new GenerationError('GENERATION_NOT_FOUND', { jobId: fence.jobId });
    }

    const snapshot = await tx.generationJobDocument.findUnique({
      where: {
        jobId_documentId: {
          jobId: fence.jobId,
          documentId: draft.citation.documentId,
        },
      },
      select: { document: { select: { title: true } } },
    });
    if (!snapshot) {
      throw new GenerationError('GENERATION_NOT_FOUND', { jobId: fence.jobId });
    }

    const question = await tx.mockQuestion.create({
      data: {
        subjectId: args.subjectId,
        topicId: args.topicId,
        jobId: fence.jobId,
        status: HELD_QUESTION_STATUS,
        stem: draft.stem,
        leadIn: draft.leadIn,
        educationalObjective: draft.objective,
        draftModel: provenance.draftModel,
        verifierModel: provenance.verifierModel,
        promptVersion: provenance.promptVersion,
        validatorVersion: provenance.validatorVersion,
      },
      select: { id: true },
    });

    await tx.mockChoice.createMany({
      data: draft.choices.map((choice, index) => ({
        questionId: question.id,
        position: index + 1,
        text: choice.text,
        isCorrect: index === draft.keyIndex,
        explanation:
          index === draft.keyIndex
            ? explanationWithKey(choice.explanation, draft.keyExplanation)
            : choice.explanation,
      })),
    });

    await tx.questionCitation.create({
      data: {
        questionId: question.id,
        documentId: draft.citation.documentId,
        documentTitleSnapshot: snapshot.document.title,
        pageNumber: draft.citation.page,
        printedPage:
          draft.citation.printedPage === null ||
          draft.citation.printedPage === undefined
            ? null
            : String(draft.citation.printedPage),
        quote: draft.citation.quote,
      },
    });

    return { questionId: question.id, acceptedCount: row.acceptedCount };
  }, TX_OPTIONS);
}

/** Only a COMPLETED job may release its held questions to attempts. */
export async function publishJobQuestions(
  jobId: string,
  client: PrismaService = sharedClient(),
): Promise<number> {
  return client.$transaction(async (tx) => {
    const job = await tx.generationJob.findUnique({
      where: { id: jobId },
      select: { state: true },
    });
    if (!job) {
      throw new GenerationError('GENERATION_NOT_FOUND', { jobId });
    }
    if (job.state !== 'COMPLETED') {
      throw new GenerationError('GENERATION_INVALID_TRANSITION', { jobId });
    }

    const result = await tx.mockQuestion.updateMany({
      where: { jobId, status: HELD_QUESTION_STATUS },
      data: { status: 'ACTIVE' },
    });
    return result.count;
  }, TX_OPTIONS);
}

/** Safeguard for failed or cancelled jobs. Safe to call more than once. */
export async function quarantineJobQuestions(
  jobId: string,
  client: PrismaService = sharedClient(),
): Promise<number> {
  return client.$transaction(async (tx) => {
    const result = await tx.mockQuestion.updateMany({
      where: { jobId, status: { not: 'RETIRED' } },
      data: { status: HELD_QUESTION_STATUS },
    });
    return result.count;
  }, TX_OPTIONS);
}

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomInt, randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  QUESTIONS_PER_TEST,
  buildAttemptChoiceOrders,
  canSkip,
  canTransition,
  createRng,
  decideAnswer,
  gradeAttempt,
  isUnfinished,
  nextPosition,
  type AttemptStatus,
  type EngineQuestion,
  type QuestionStatus,
} from './engine/index.js';
import {
  choiceLetterAt,
  toExamQuestionDto,
  toResultDto,
  toReviewDto,
  type ExamQuestionDto,
  type ResultDto,
  type ResultSnapshot,
  type ReviewChoiceDto,
  type ReviewDto,
  type ReviewQuestionDto,
} from './exam.dto.js';
import { MockTestError } from './exam.errors.js';

export interface CreateAttemptResponse {
  attemptId: string;
  status: 'READY';
}

export interface StartAttemptResponse {
  attemptId: string;
  sessionVersion: number;
  question: ExamQuestionDto;
}

export interface AnswerQuestionInput {
  sessionVersion: number;
  position: number;
  choiceId: string;
  idempotencyKey: string;
}

export interface QuestionProgressResponse {
  nextQuestion: ExamQuestionDto | null;
  status: AttemptStatus;
  answeredCount: number;
}

export interface SkipQuestionInput {
  sessionVersion: number;
  position: number;
}

export interface NavigatorItem {
  position: number;
  answered: boolean;
  selectedChoiceId: string | null;
}

export interface ReviewNavigatorResponse {
  attemptId: string;
  status: 'AWAITING_SUBMISSION';
  items: NavigatorItem[];
}

export interface DiscardAttemptResponse {
  attemptId: string;
  status: 'ABANDONED';
}

export interface SubjectOverviewResponse {
  unfinishedAttempt: {
    id: string;
    status: AttemptStatus;
    createdAt: Date;
  } | null;
  eligibleQuestionCount: number;
  questionsPerTest: 25;
}

interface LockedAttempt {
  id: string;
  status: AttemptStatus;
  sessionVersion: number;
  cursorPosition: number;
}

interface AttemptQuestionView {
  id: string;
  position: number;
  status: QuestionStatus;
  choiceOrder: number[];
  questionId: string;
  stem: string;
  leadIn: string | null;
  existingChoiceId: string | null;
  choices: { id: string; position: number; text: string }[];
}

interface GradingRow {
  position: number;
  selectedChoiceId: string | null;
  correctChoiceId: string;
  topicKey: string;
}

const UNFINISHED_STATUSES: AttemptStatus[] = [
  'GENERATING',
  'READY',
  'IN_PROGRESS',
  'AWAITING_SUBMISSION',
];

/**
 * Interactive transactions lock one attempt row and then do a handful of
 * statements. The test pooler adds high per-statement latency, so wait and
 * execution budgets are raised well above the Prisma defaults (maxWait 2000,
 * timeout 5000).
 */
const TX_OPTIONS = { maxWait: 30000, timeout: 30000 };

function parseChoices(value: unknown): AttemptQuestionView['choices'] {
  if (Array.isArray(value)) {
    return value as AttemptQuestionView['choices'];
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as AttemptQuestionView['choices'];
  }
  return [];
}

function toExamQuestion(
  attemptId: string,
  row: AttemptQuestionView,
): ExamQuestionDto {
  return toExamQuestionDto(attemptId, {
    position: row.position,
    status: row.status,
    choiceOrder: row.choiceOrder,
    question: {
      stem: row.stem,
      leadIn: row.leadIn,
      choices: row.choices,
    },
  });
}

function withStatus(
  row: AttemptQuestionView,
  status: QuestionStatus,
): AttemptQuestionView {
  return { ...row, status };
}

/**
 * A question is unusable only when every citation is unavailable (its
 * Document row is gone, so documentId is NULL). No citations means eligible.
 */
function isCitationEligible(question: {
  citations: { documentId: string | null }[];
}): boolean {
  return (
    question.citations.length === 0 ||
    question.citations.some((citation) => citation.documentId !== null)
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

function toEngineQuestions(
  rows: { position: number; status: QuestionStatus }[],
): EngineQuestion[] {
  return rows.map((row) => ({
    position: row.position,
    status: row.status,
  }));
}

/**
 * Take at most two questions per topic first, then fill any remaining slots.
 * This makes the spread as even as the available content allows.
 */
function selectQuestions<T extends { topicId: string }>(questions: T[]): T[] {
  const selected: T[] = [];
  const perTopic = new Map<string, number>();

  for (const question of questions) {
    if (selected.length === QUESTIONS_PER_TEST) break;
    const used = perTopic.get(question.topicId) ?? 0;
    if (used < 2) {
      selected.push(question);
      perTopic.set(question.topicId, used + 1);
    }
  }

  if (selected.length < QUESTIONS_PER_TEST) {
    const chosen = new Set(selected);
    for (const question of questions) {
      if (selected.length === QUESTIONS_PER_TEST) break;
      if (!chosen.has(question)) selected.push(question);
    }
  }

  return selected;
}

@Injectable()
export class ExamService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  /**
   * Creates a READY attempt in one transaction. The DB partial unique index
   * enforces one unfinished attempt per subject; a P2002 is mapped to
   * ATTEMPT_EXISTS with the existing attempt id.
   */
  async createAttempt(
    subjectId: string,
    rng: () => number = createRng(randomInt(0, 2 ** 32)),
  ): Promise<CreateAttemptResponse> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          // R4 requires every attempt to be inserted as GENERATING.
          const attempt = await tx.mockAttempt.create({
            data: { subjectId, status: 'GENERATING' },
          });

          const questions = await tx.mockQuestion.findMany({
            where: { subjectId, status: 'ACTIVE' },
            orderBy: [{ topicId: 'asc' }, { id: 'asc' }],
            include: {
              choices: { orderBy: { position: 'asc' } },
              citations: { select: { documentId: true } },
            },
          });

          // A citation whose Document row is gone has documentId = NULL.
          // A question is unusable only when every citation is unavailable.
          const eligible = questions.filter(isCitationEligible);

          if (eligible.length < QUESTIONS_PER_TEST) {
            throw new MockTestError('INSUFFICIENT_CONTENT', {
              details: {
                available: eligible.length,
                required: QUESTIONS_PER_TEST,
              },
            });
          }

          const selected = selectQuestions(eligible);
          const correctPositions = selected.map((question) => {
            const correct = question.choices.find((choice) => choice.isCorrect);
            if (!correct) throw new MockTestError('INSUFFICIENT_CONTENT');
            return correct.position;
          });

          const { choiceOrders } = buildAttemptChoiceOrders(
            correctPositions,
            rng,
          );

          await tx.attemptQuestion.createMany({
            data: selected.map((question, index) => ({
              attemptId: attempt.id,
              questionId: question.id,
              position: index + 1,
              choiceOrder: choiceOrders[index],
              status: 'UNSEEN',
            })),
          });

          await tx.mockAttempt.update({
            where: { id: attempt.id },
            data: { status: 'READY' },
          });

          return { attemptId: attempt.id, status: 'READY' as const };
        },
        TX_OPTIONS,
      );
    } catch (error) {
      if (error instanceof MockTestError) throw error;

      if (isUniqueViolation(error)) {
        const existing = await this.prisma.mockAttempt.findFirst({
          where: { subjectId, status: { in: UNFINISHED_STATUSES } },
          select: { id: true },
        });
        throw new MockTestError('ATTEMPT_EXISTS', {
          attemptId: existing?.id,
        });
      }

      throw error;
    }
  }

  /**
   * Read-only overview for the exam entry screen. At most one unfinished
   * attempt exists per subject (DB partial unique rule). The eligible count
   * uses the same citation rule as createAttempt.
   */
  async getSubjectOverview(
    subjectId: string,
  ): Promise<SubjectOverviewResponse> {
    const subject = await this.prisma.subject.findUnique({
      where: { id: subjectId },
      select: { id: true },
    });
    if (!subject) throw new MockTestError('SUBJECT_NOT_FOUND');

    const [unfinishedAttempt, questions] = await Promise.all([
      this.prisma.mockAttempt.findFirst({
        where: { subjectId, status: { in: UNFINISHED_STATUSES } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, status: true, createdAt: true },
      }),
      this.prisma.mockQuestion.findMany({
        where: { subjectId, status: 'ACTIVE' },
        select: { citations: { select: { documentId: true } } },
      }),
    ]);

    return {
      unfinishedAttempt: unfinishedAttempt ?? null,
      eligibleQuestionCount: questions.filter(isCitationEligible).length,
      questionsPerTest: QUESTIONS_PER_TEST,
    };
  }

  /**
   * READY -> IN_PROGRESS. Reopening IN_PROGRESS or AWAITING_SUBMISSION is a
   * resume: sessionVersion increments so older sessions become stale.
   */
  async startAttempt(attemptId: string): Promise<StartAttemptResponse> {
    return this.prisma.$transaction(
      async (tx) => {
        const attempt = await tx.mockAttempt.findUnique({
          where: { id: attemptId },
        });
        if (!attempt) throw new MockTestError('ATTEMPT_NOT_FOUND');

        const isResume =
          attempt.status === 'IN_PROGRESS' ||
          attempt.status === 'AWAITING_SUBMISSION';
        if (!isResume && !canTransition(attempt.status, 'IN_PROGRESS')) {
          throw new MockTestError('NOT_IN_PROGRESS');
        }

        const updated = await tx.mockAttempt.update({
          where: { id: attemptId },
          data: {
            status: isResume ? attempt.status : 'IN_PROGRESS',
            sessionVersion: { increment: 1 },
            cursorPosition: 1,
            lastActivityAt: new Date(),
          },
        });

        const rows = await this.readAttemptQuestions(tx, attemptId);
        const first = rows.find((row) => row.position === 1);
        if (!first) throw new MockTestError('QUESTION_NOT_FOUND');

        return {
          attemptId,
          sessionVersion: updated.sessionVersion,
          question: toExamQuestion(attemptId, first),
        };
      },
      TX_OPTIONS,
    );
  }

  /** 
   * Reads without writing. Two statements: attempt row, then all attempt
   * questions with choices in one aggregate query.
   */
  async getCurrentQuestion(
    attemptId: string,
    sessionVersion: number,
  ): Promise<ExamQuestionDto | null> {
    const attempt = await this.prisma.mockAttempt.findUnique({
      where: { id: attemptId },
      select: { sessionVersion: true, cursorPosition: true },
    });
    if (!attempt) throw new MockTestError('ATTEMPT_NOT_FOUND');
    if (attempt.sessionVersion !== sessionVersion) {
      throw new MockTestError('SESSION_SUPERSEDED');
    }
    if (attempt.cursorPosition > QUESTIONS_PER_TEST) return null;

    const rows = await this.readAttemptQuestions(this.prisma, attemptId);
    const row = rows.find(
      (candidate) => candidate.position === attempt.cursorPosition,
    );
    return row ? toExamQuestion(attemptId, row) : null;
  }

  /**
   * Applies CREATE / NOOP_REPLAY / EDIT under a row lock.
   * Statements inside one transaction: (1) lock attempt, (2) read all 25
   * attempt questions with choices and answers, (3) one write statement for
   * the answer, question status and attempt cursor. The engine computes the
   * next position in memory; a client-provided next position is never trusted.
   */
  async answerQuestion(
    attemptId: string,
    input: AnswerQuestionInput,
  ): Promise<QuestionProgressResponse> {
    return this.prisma.$transaction(
      async (tx) => {
        const attempt = await this.lockAttempt(tx, attemptId);
        this.assertSession(attempt, input.sessionVersion);
        if (
          attempt.status !== 'IN_PROGRESS' &&
          attempt.status !== 'AWAITING_SUBMISSION'
        ) {
          throw new MockTestError('NOT_IN_PROGRESS');
        }

        const rows = await this.readAttemptQuestions(tx, attemptId);
        const row = rows.find(
          (candidate) => candidate.position === input.position,
        );
        if (!row) throw new MockTestError('QUESTION_NOT_FOUND');

        if (!row.choices.some((choice) => choice.id === input.choiceId)) {
          throw new MockTestError('INVALID_CHOICE');
        }

        const decision = decideAnswer({
          attemptStatus: attempt.status,
          questionStatus: row.status,
          existingChoiceId: row.existingChoiceId,
          incomingChoiceId: input.choiceId,
        });

        if (decision.kind === 'REJECT') {
          throw new MockTestError(decision.code);
        }

        let cursorPosition = attempt.cursorPosition;
        let status: AttemptStatus = attempt.status;
        let updatedRows = rows;

        if (decision.kind === 'CREATE') {
          updatedRows = rows.map((candidate) =>
            candidate.position === row.position
              ? withStatus(candidate, 'ANSWERED')
              : candidate,
          );
          const next = nextPosition(
            toEngineQuestions(updatedRows),
            input.position,
          );
          cursorPosition = next ?? QUESTIONS_PER_TEST + 1;
          status = next === null ? 'AWAITING_SUBMISSION' : 'IN_PROGRESS';

          await tx.$executeRaw(Prisma.sql`
            WITH "inserted" AS (
              INSERT INTO "AttemptAnswer"
                ("id", "attemptQuestionId", "choiceId", "revision", "idempotencyKey")
              VALUES
                (${randomUUID()}, ${row.id}, ${input.choiceId}, 1, ${input.idempotencyKey})
            ), "marked" AS (
              UPDATE "AttemptQuestion"
                 SET "status" = 'ANSWERED'
               WHERE "id" = ${row.id}
            )
            UPDATE "MockAttempt"
               SET "cursorPosition" = ${cursorPosition},
                   "status" = ${status}::"MockAttemptStatus",
                   "lastActivityAt" = NOW()
             WHERE "id" = ${attemptId}
          `);
        } else if (decision.kind === 'EDIT') {
          await tx.$executeRaw(Prisma.sql`
            WITH "revised" AS (
              UPDATE "AttemptAnswer"
                 SET "choiceId" = ${input.choiceId},
                     "revision" = "revision" + 1
               WHERE "attemptQuestionId" = ${row.id}
            )
            UPDATE "MockAttempt"
               SET "cursorPosition" = ${cursorPosition},
                   "status" = ${status}::"MockAttemptStatus",
                   "lastActivityAt" = NOW()
             WHERE "id" = ${attemptId}
          `);
        } else {
          // NOOP_REPLAY still refreshes lastActivityAt, as before.
          await tx.$executeRaw(Prisma.sql`
            UPDATE "MockAttempt"
               SET "cursorPosition" = ${cursorPosition},
                   "status" = ${status}::"MockAttemptStatus",
                   "lastActivityAt" = NOW()
             WHERE "id" = ${attemptId}
          `);
        }

        const nextRow = updatedRows.find(
          (candidate) => candidate.position === cursorPosition,
        );

        return {
          nextQuestion: nextRow ? toExamQuestion(attemptId, nextRow) : null,
          status,
          answeredCount: updatedRows.filter(
            (candidate) => candidate.status === 'ANSWERED',
          ).length,
        };
      },
      TX_OPTIONS,
    );
  }

  /**
   * Skip is allowed only while another UNSEEN question remains (engine rule).
   * Statements: (1) lock attempt, (2) read all rows with choices, (3) one
   * write statement for the vetoed question and the attempt cursor.
   */
  async skipQuestion(
    attemptId: string,
    input: SkipQuestionInput,
  ): Promise<QuestionProgressResponse> {
    return this.prisma.$transaction(
      async (tx) => {
        const attempt = await this.lockAttempt(tx, attemptId);
        this.assertSession(attempt, input.sessionVersion);
        if (attempt.status !== 'IN_PROGRESS') {
          throw new MockTestError('NOT_IN_PROGRESS');
        }

        const rows = await this.readAttemptQuestions(tx, attemptId);
        const row = rows.find(
          (candidate) => candidate.position === input.position,
        );
        if (!row) throw new MockTestError('QUESTION_NOT_FOUND');
        if (row.status === 'ANSWERED') {
          throw new MockTestError('SKIP_NOT_ALLOWED');
        }

        if (!canSkip(toEngineQuestions(rows), input.position)) {
          throw new MockTestError('SKIP_NOT_ALLOWED');
        }

        const updatedRows = rows.map((candidate) =>
          candidate.position === input.position
            ? withStatus(candidate, 'SKIPPED')
            : candidate,
        );
        const next = nextPosition(
          toEngineQuestions(updatedRows),
          input.position,
        );
        const cursorPosition = next ?? QUESTIONS_PER_TEST + 1;
        const status: AttemptStatus =
          next === null ? 'AWAITING_SUBMISSION' : 'IN_PROGRESS';

        await tx.$executeRaw(Prisma.sql`
          WITH "marked" AS (
            UPDATE "AttemptQuestion"
               SET "status" = 'SKIPPED'
             WHERE "id" = ${row.id}
          )
          UPDATE "MockAttempt"
             SET "cursorPosition" = ${cursorPosition},
                 "status" = ${status}::"MockAttemptStatus",
                 "lastActivityAt" = NOW()
           WHERE "id" = ${attemptId}
        `);

        const nextRow = updatedRows.find(
          (candidate) => candidate.position === cursorPosition,
        );

        return {
          nextQuestion: nextRow ? toExamQuestion(attemptId, nextRow) : null,
          status,
          answeredCount: rows.filter(
            (candidate) => candidate.status === 'ANSWERED',
          ).length,
        };
      },
      TX_OPTIONS,
    );
  }

  /** Neutral navigator: answered flag and selected id only, no correctness. */
  async getReviewNavigator(
    attemptId: string,
    sessionVersion: number,
  ): Promise<ReviewNavigatorResponse> {
    const attempt = await this.prisma.mockAttempt.findUnique({
      where: { id: attemptId },
      select: { status: true, sessionVersion: true },
    });
    if (!attempt) throw new MockTestError('ATTEMPT_NOT_FOUND');
    if (attempt.sessionVersion !== sessionVersion) {
      throw new MockTestError('SESSION_SUPERSEDED');
    }
    if (attempt.status !== 'AWAITING_SUBMISSION') {
      throw new MockTestError('NOT_IN_PROGRESS');
    }

    const rows = await this.prisma.attemptQuestion.findMany({
      where: { attemptId },
      orderBy: { position: 'asc' },
      include: { answer: { select: { choiceId: true } } },
    });

    return {
      attemptId,
      status: 'AWAITING_SUBMISSION',
      items: rows.map((row) => ({
        position: row.position,
        answered: row.status === 'ANSWERED',
        selectedChoiceId: row.answer?.choiceId ?? null,
      })),
    };
  }

  /**
   * One transaction and row lock. A second submit on a COMPLETED attempt
   * returns the existing result, so concurrent submits create one row.
   * Statements: (1) lock attempt, (2) grading rows in one aggregate query,
   * (3) insert result and mark COMPLETED in one statement.
   */
  async submitAttempt(
    attemptId: string,
    sessionVersion: number,
    idempotencyKey: string,
  ): Promise<ResultDto> {
    void idempotencyKey;

    return this.prisma.$transaction(
      async (tx) => {
        const attempt = await this.lockAttempt(tx, attemptId);
        this.assertSession(attempt, sessionVersion);

        if (attempt.status === 'COMPLETED') {
          const existing = await tx.attemptResult.findUnique({
            where: { attemptId },
          });
          if (!existing) throw new MockTestError('NOT_IN_PROGRESS');
          return toResultDto(attemptId, existing);
        }

        if (attempt.status !== 'AWAITING_SUBMISSION') {
          throw new MockTestError('NOT_IN_PROGRESS');
        }

        const items = await tx.$queryRaw<GradingRow[]>(Prisma.sql`
          SELECT aq."position" AS "position",
                 a."choiceId" AS "selectedChoiceId",
                 c."id" AS "correctChoiceId",
                 t."key" AS "topicKey"
            FROM "AttemptQuestion" aq
            JOIN "MockQuestion" q ON q."id" = aq."questionId"
            JOIN "SubjectTopic" t ON t."id" = q."topicId"
            JOIN "MockChoice" c
              ON c."questionId" = q."id" AND c."isCorrect"
       LEFT JOIN "AttemptAnswer" a ON a."attemptQuestionId" = aq."id"
           WHERE aq."attemptId" = ${attemptId}
        ORDER BY aq."position"
        `);

        if (items.length !== QUESTIONS_PER_TEST) {
          throw new MockTestError('NOT_ALL_ANSWERED');
        }
        if (items.some((item) => item.selectedChoiceId === null)) {
          throw new MockTestError('NOT_ALL_ANSWERED');
        }

        const grade = gradeAttempt(items);
        const topicByPosition = new Map(
          items.map((item) => [item.position, item.topicKey]),
        );
        const snapshot: ResultSnapshot = {
          perQuestion: grade.perQuestion.map((question) => ({
            ...question,
            topicKey: topicByPosition.get(question.position) ?? '',
          })),
          perTopic: grade.perTopic,
        };

        await tx.$executeRaw(Prisma.sql`
          WITH "inserted" AS (
            INSERT INTO "AttemptResult"
              ("id", "attemptId", "score", "total", "snapshot")
            VALUES
              (${randomUUID()}, ${attemptId}, ${grade.score}, ${grade.total},
               ${JSON.stringify(snapshot)}::jsonb)
          )
          UPDATE "MockAttempt"
             SET "status" = 'COMPLETED',
                 "lastActivityAt" = NOW()
           WHERE "id" = ${attemptId}
        `);

        return toResultDto(attemptId, {
          score: grade.score,
          total: grade.total,
          snapshot,
        });
      },
      TX_OPTIONS,
    );
  }

  async getResult(attemptId: string): Promise<ResultDto> {
    const attempt = await this.prisma.mockAttempt.findUnique({
      where: { id: attemptId },
      include: { result: true },
    });
    if (!attempt) throw new MockTestError('ATTEMPT_NOT_FOUND');
    if (attempt.status !== 'COMPLETED' || !attempt.result) {
      throw new MockTestError('NOT_IN_PROGRESS');
    }
    return toResultDto(attemptId, attempt.result);
  }

  /**
   * Full review from the stored snapshot plus live rows. QUARANTINED or
   * RETIRED questions are marked under review; the stored score never changes.
   */
  async getReview(attemptId: string): Promise<ReviewDto> {
    const attempt = await this.prisma.mockAttempt.findUnique({
      where: { id: attemptId },
      include: { result: true },
    });
    if (!attempt) throw new MockTestError('ATTEMPT_NOT_FOUND');
    if (attempt.status !== 'COMPLETED' || !attempt.result) {
      throw new MockTestError('NOT_IN_PROGRESS');
    }

    const rows = await this.prisma.attemptQuestion.findMany({
      where: { attemptId },
      orderBy: { position: 'asc' },
      include: {
        answer: true,
        question: {
          include: {
            choices: { orderBy: { position: 'asc' } },
            topic: true,
            citations: {
              select: {
                documentTitleSnapshot: true,
                pageNumber: true,
                quote: true,
              },
            },
          },
        },
      },
    });

    const snapshot = attempt.result.snapshot as unknown as ResultSnapshot;
    const snapshotByPosition = new Map(
      snapshot.perQuestion.map((question) => [question.position, question]),
    );

    const questions: ReviewQuestionDto[] = rows.map((row) => {
      const byStoredPosition = new Map(
        row.question.choices.map((choice) => [choice.position, choice]),
      );
      const choices: ReviewChoiceDto[] = row.choiceOrder.map(
        (storedPosition, index) => {
          const choice = byStoredPosition.get(storedPosition);
          if (!choice) throw new MockTestError('QUESTION_NOT_FOUND');
          return {
            id: choice.id,
            letter: choiceLetterAt(index),
            text: choice.text,
            isCorrect: choice.isCorrect,
            explanation: choice.explanation,
          };
        },
      );

      const stored = snapshotByPosition.get(row.position);
      const liveCorrect = row.question.choices.find(
        (choice) => choice.isCorrect,
      );
      const correctChoiceId = stored?.correctChoiceId ?? liveCorrect?.id ?? '';
      const selectedChoiceId =
        stored?.selectedChoiceId ?? row.answer?.choiceId ?? null;
      const isCorrect =
        stored?.isCorrect ??
        (selectedChoiceId !== null && selectedChoiceId === correctChoiceId);

      return {
        position: row.position,
        status: row.status,
        stem: row.question.stem,
        leadIn: row.question.leadIn,
        choices,
        selectedChoiceId,
        correctChoiceId,
        isCorrect,
        underReview:
          row.question.status === 'QUARANTINED' ||
          row.question.status === 'RETIRED',
        topicName: row.question.topic.name,
        citations: row.question.citations.map((citation) => ({
          documentTitleSnapshot: citation.documentTitleSnapshot,
          pageNumber: citation.pageNumber,
          quote: citation.quote,
        })),
      };
    });

    return toReviewDto(attemptId, attempt.result, questions);
  }

  /** Any unfinished attempt becomes ABANDONED, freeing the subject slot. */
  async discardAttempt(attemptId: string): Promise<DiscardAttemptResponse> {
    return this.prisma.$transaction(
      async (tx) => {
        const attempt = await this.lockAttempt(tx, attemptId);
        if (
          !isUnfinished(attempt.status) ||
          !canTransition(attempt.status, 'ABANDONED')
        ) {
          throw new MockTestError('NOT_IN_PROGRESS');
        }

        await tx.mockAttempt.update({
          where: { id: attemptId },
          data: { status: 'ABANDONED', lastActivityAt: new Date() },
        });

        return { attemptId, status: 'ABANDONED' as const };
      },
      TX_OPTIONS,
    );
  }

  private async lockAttempt(
    tx: Prisma.TransactionClient,
    attemptId: string,
  ): Promise<LockedAttempt> {
    // FOR UPDATE serializes every state change for this attempt.
    const rows = await tx.$queryRaw<LockedAttempt[]>(Prisma.sql`
      SELECT "id", "status", "sessionVersion", "cursorPosition"
        FROM "MockAttempt"
       WHERE "id" = ${attemptId}
       FOR UPDATE
    `);
    const row = rows[0];
    if (!row) throw new MockTestError('ATTEMPT_NOT_FOUND');
    return row;
  }

  private assertSession(
    attempt: LockedAttempt,
    sessionVersion: number,
  ): void {
    if (attempt.sessionVersion !== sessionVersion) {
      throw new MockTestError('SESSION_SUPERSEDED');
    }
  }

  /**
   * One statement for all 25 attempt questions plus their four choices and
   * selected choice id. The caller computes next positions in memory.
   */
  private async readAttemptQuestions(
    client: Prisma.TransactionClient | PrismaService,
    attemptId: string,
  ): Promise<AttemptQuestionView[]> {
    const rows = await client.$queryRaw<AttemptQuestionView[]>(Prisma.sql`
      SELECT aq."id" AS "id",
             aq."position" AS "position",
             aq."status"::text AS "status",
             aq."choiceOrder" AS "choiceOrder",
             q."id" AS "questionId",
             q."stem" AS "stem",
             q."leadIn" AS "leadIn",
             a."choiceId" AS "existingChoiceId",
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', c."id",
                   'position', c."position",
                   'text', c."text"
                 ) ORDER BY c."position"
               ) FILTER (WHERE c."id" IS NOT NULL),
               '[]'::json
             ) AS "choices"
        FROM "AttemptQuestion" aq
        JOIN "MockQuestion" q ON q."id" = aq."questionId"
   LEFT JOIN "AttemptAnswer" a ON a."attemptQuestionId" = aq."id"
   LEFT JOIN "MockChoice" c ON c."questionId" = q."id"
       WHERE aq."attemptId" = ${attemptId}
    GROUP BY aq."id", aq."position", aq."status", aq."choiceOrder",
             q."id", q."stem", q."leadIn", a."choiceId"
    ORDER BY aq."position"
    `);

    return rows.map((row) => ({ ...row, choices: parseChoices(row.choices) }));
  }
}

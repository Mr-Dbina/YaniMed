import { afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRng } from '../../src/mock-test/engine/index.js';
import {
  ExamService,
  type QuestionProgressResponse,
} from '../../src/mock-test/exam.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { assertTestDb } from '../m3/helpers.js';

export { assertTestDb };

// Same shared-client pattern as test/m3. Prisma queues requests above the pool
// size, so 20 parallel calls wait instead of failing with a pool timeout.
export const prisma = new PrismaService();
export const service = new ExamService(prisma);

export const TEST_SEED = 20261109;

export function seededRng(seed: number = TEST_SEED): () => number {
  return createRng(seed);
}

export function examKey(): string {
  return `ZZ-m4-key-${randomUUID()}`;
}

// Cleanup is subject-id scoped; the Subject cascade removes attempts,
// questions, answers, results, citations and reports.
const createdSubjectIds: string[] = [];

afterAll(async () => {
  try {
    if (createdSubjectIds.length > 0) {
      await prisma.subject.deleteMany({
        where: { id: { in: createdSubjectIds } },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
});

/**
 * One subject with `count` ACTIVE questions. Every question has four choices
 * and exactly one correct choice, created in one transaction so the deferred
 * R3 trigger sees the complete set at COMMIT. Topics are spread two per topic.
 */
export async function createSubjectWithQuestions(count = 25) {
  assertTestDb();

  const subject = await prisma.subject.create({
    data: { name: `ZZ-m4-${randomUUID()}` },
  });
  createdSubjectIds.push(subject.id);

  const topicCount = Math.max(1, Math.ceil(count / 2));
  const topics: { id: string; name: string }[] = [];
  for (let index = 0; index < topicCount; index += 1) {
    topics.push(
      await prisma.subjectTopic.create({
        data: {
          subjectId: subject.id,
          key: `ZZ-m4-topic-${randomUUID()}`,
          name: `ZZ-m4 topic ${index + 1}`,
        },
      }),
    );
  }

  await prisma.$transaction(
    async (tx) => {
      for (let index = 0; index < count; index += 1) {
        const topic = topics[index % topics.length];
        const question = await tx.mockQuestion.create({
          data: {
            subjectId: subject.id,
            topicId: topic.id,
            status: 'ACTIVE',
            stem: `ZZ-m4 stem ${index + 1}`,
            leadIn: index % 2 === 0 ? null : `ZZ-m4 lead ${index + 1}`,
            educationalObjective: 'ZZ-m4 objective',
            draftModel: 'zz-m4-draft',
            verifierModel: null,
            promptVersion: 'zz-m4-v1',
            validatorVersion: 'zz-m4-v1',
          },
        });

        const correctPosition = (index % 4) + 1;
        await tx.mockChoice.createMany({
          data: [1, 2, 3, 4].map((position) => ({
            questionId: question.id,
            position,
            text: `ZZ-m4 choice ${position}`,
            isCorrect: position === correctPosition,
            explanation: `ZZ-m4 explanation ${position}`,
          })),
        });
      }
    },
    { timeout: 30000 },
  );

  return { subject, topics };
}

export function getAttemptQuestions(attemptId: string) {
  return prisma.attemptQuestion.findMany({
    where: { attemptId },
    orderBy: { position: 'asc' },
    include: {
      answer: true,
      question: {
        include: {
          choices: { orderBy: { position: 'asc' } },
          citations: true,
          topic: true,
        },
      },
    },
  });
}

export type AttemptQuestionRow = Awaited<
  ReturnType<typeof getAttemptQuestions>
>[number];

export function correctChoiceId(row: AttemptQuestionRow): string {
  const choice = row.question.choices.find((item) => item.isCorrect);
  if (!choice) throw new Error('ZZ-m4 fixture has no correct choice.');
  return choice.id;
}

export function wrongChoiceId(row: AttemptQuestionRow): string {
  const choice = row.question.choices.find((item) => !item.isCorrect);
  if (!choice) throw new Error('ZZ-m4 fixture has no wrong choice.');
  return choice.id;
}

export async function createReadyAttempt(seed: number = TEST_SEED) {
  const { subject, topics } = await createSubjectWithQuestions();
  const created = await service.createAttempt(subject.id, seededRng(seed));
  return { subject, topics, attemptId: created.attemptId };
}

/** Answers positions in ascending order with the chosen choice for each row. */
export async function answerAll(
  attemptId: string,
  sessionVersion: number,
  pick: (row: AttemptQuestionRow) => string,
): Promise<QuestionProgressResponse> {
  const rows = await getAttemptQuestions(attemptId);
  let last: QuestionProgressResponse | undefined;

  for (const row of rows) {
    last = await service.answerQuestion(attemptId, {
      sessionVersion,
      position: row.position,
      choiceId: pick(row),
      idempotencyKey: examKey(),
    });
  }

  if (!last) throw new Error('ZZ-m4 attempt has no questions.');
  return last;
}

export interface SeededQuestion {
  position: number;
  attemptQuestionId: string;
  questionId: string;
  correctChoiceId: string;
  wrongChoiceId: string;
}

/** null leaves the question unanswered. */
export type SeedAnswerPicker = (question: SeededQuestion) => string | null;

/**
 * Builds an AWAITING_SUBMISSION attempt straight through the DB, for tests
 * that are not about the 25-step answer flow. The attempt still follows the
 * legal status path GENERATING -> READY -> IN_PROGRESS -> AWAITING_SUBMISSION,
 * and the 25 ACTIVE AttemptQuestion rows exist before leaving GENERATING (R4).
 *
 * shortcut: question rows are seeded straight as ANSWERED/UNSEEN; only the
 * attempt status path is replayed. Upgrade if a test must prove the per-answer
 * AttemptQuestion transition.
 */
export async function seedAttemptAtAwaitingSubmission(
  subjectId: string,
  answers: SeedAnswerPicker = (question) => question.correctChoiceId,
): Promise<{
  attemptId: string;
  sessionVersion: number;
  questions: SeededQuestion[];
}> {
  assertTestDb();

  const questions = await prisma.mockQuestion.findMany({
    where: { subjectId, status: 'ACTIVE' },
    orderBy: { id: 'asc' },
    include: { choices: { orderBy: { position: 'asc' } } },
  });
  if (questions.length < 25) {
    throw new Error('ZZ-m4 seed needs 25 ACTIVE questions.');
  }

  const seeded: SeededQuestion[] = questions
    .slice(0, 25)
    .map((question, index) => {
      const correct = question.choices.find((choice) => choice.isCorrect);
      const wrong = question.choices.find((choice) => !choice.isCorrect);
      if (!correct || !wrong) {
        throw new Error('ZZ-m4 seed question has invalid choices.');
      }
      return {
        position: index + 1,
        attemptQuestionId: randomUUID(),
        questionId: question.id,
        correctChoiceId: correct.id,
        wrongChoiceId: wrong.id,
      };
    });

  const chosen = seeded.map((question) => answers(question));

  const attempt = await prisma.mockAttempt.create({
    data: { subjectId, status: 'GENERATING' },
  });

  await prisma.attemptQuestion.createMany({
    data: seeded.map((question, index) => ({
      id: question.attemptQuestionId,
      attemptId: attempt.id,
      questionId: question.questionId,
      position: question.position,
      choiceOrder: [1, 2, 3, 4],
      status: chosen[index] === null ? 'UNSEEN' : 'ANSWERED',
    })),
  });

  await prisma.mockAttempt.update({
    where: { id: attempt.id },
    data: { status: 'READY' },
  });
  await prisma.mockAttempt.update({
    where: { id: attempt.id },
    data: { status: 'IN_PROGRESS' },
  });

  const answerRows = seeded.flatMap((question, index) => {
    const choiceId = chosen[index];
    if (choiceId === null) return [];
    return [
      {
        attemptQuestionId: question.attemptQuestionId,
        choiceId,
        revision: 1,
        idempotencyKey: `ZZ-m4-seed-${randomUUID()}`,
      },
    ];
  });
  if (answerRows.length > 0) {
    await prisma.attemptAnswer.createMany({ data: answerRows });
  }

  const awaiting = await prisma.mockAttempt.update({
    where: { id: attempt.id },
    data: { status: 'AWAITING_SUBMISSION', cursorPosition: 26 },
  });

  return {
    attemptId: attempt.id,
    sessionVersion: awaiting.sessionVersion,
    questions: seeded,
  };
}

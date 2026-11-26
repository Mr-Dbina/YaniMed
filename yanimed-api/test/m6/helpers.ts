import { afterAll } from 'vitest';
import { Prisma, type MockQuestion } from '@prisma/client';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

// Shared client for one spec file. Prisma queues requests above the pool size,
// so 20 parallel calls wait their turn instead of being rejected by the pooler.
const prisma = new PrismaClient();

// Every row created by the tests hangs off a Subject, and cleanup deletes only
// the subject ids recorded here. No pattern-based deletes.
const createdSubjectIds: string[] = [];

export function assertTestDb(): void {
  if (process.env.YANIMED_TEST_DB !== '1') {
    throw new Error(
      'Refusing to run M6 database tests: YANIMED_TEST_DB is not 1. Load src/config/load-test-env.ts first.',
    );
  }
}

export function redact(text: string): string {
  return text
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, 'postgresql://[REDACTED]')
    .replace(/[A-Za-z0-9.-]+\.supabase\.(com|co)(:\d+)?/gi, '[REDACTED_HOST]');
}

export function dbErrorText(error: unknown): string {
  if (!(error instanceof Error)) return redact(String(error));

  const maybe = error as Error & {
    code?: unknown;
    meta?: unknown;
    cause?: unknown;
  };

  let meta = '';
  try {
    meta = maybe.meta === undefined ? '' : JSON.stringify(maybe.meta);
  } catch {
    meta = '';
  }

  const cause = maybe.cause instanceof Error ? maybe.cause.message : '';

  return redact([error.message, String(maybe.code ?? ''), meta, cause].join(' '));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Prisma wraps Postgres errors, so a matcher may hit the message, the Prisma
// code, or the meta payload (which holds constraint/field details).
export function assertDbError(error: unknown, matcher: RegExp | string): void {
  const text = dbErrorText(error);
  const pattern =
    typeof matcher === 'string' ? new RegExp(escapeRegExp(matcher), 'i') : matcher;

  if (!pattern.test(text)) {
    throw new Error(
      `Expected a database error matching ${String(matcher)}; got: ${text}`,
    );
  }
}

export async function expectDbError(
  promise: Promise<unknown>,
  matcher: RegExp | string,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    assertDbError(error, matcher);
    return;
  }

  throw new Error(
    `Expected the database to reject the operation (${String(matcher)}), but it succeeded.`,
  );
}

export async function cleanupSubjects(): Promise<void> {
  if (createdSubjectIds.length === 0) return;

  await prisma.subject.deleteMany({ where: { id: { in: createdSubjectIds } } });
  createdSubjectIds.length = 0;
}

afterAll(async () => {
  try {
    await cleanupSubjects();
  } finally {
    await prisma.$disconnect();
  }
});

export { prisma };

export async function createSubject() {
  assertTestDb();
  const subject = await prisma.subject.create({
    data: { name: `ZZ-m6-${randomUUID()}` },
  });
  createdSubjectIds.push(subject.id);
  return subject;
}

export async function createTopic(subjectId: string) {
  return prisma.subjectTopic.create({
    data: { subjectId, key: `ZZ-m6-key-${randomUUID()}`, name: 'ZZ-m6 topic' },
  });
}

export async function createPdfObject() {
  return prisma.pdfObject.create({
    data: {
      sha256: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      r2Key: `ZZ-m6/r2-${randomUUID()}`,
      sizeBytes: 1,
    },
  });
}

// Minimal Document for citations. It needs a PdfObject because the composite
// unique (subjectId, pdfObjectId) is part of the schema contract.
export async function createDocument(subjectId: string) {
  const pdfObject = await createPdfObject();
  return prisma.document.create({
    data: {
      subjectId,
      pdfObjectId: pdfObject.id,
      title: 'ZZ-m6.pdf',
      fileUrl: `ZZ-m6/file-${randomUUID()}`,
      fileSize: 1,
    },
  });
}

export function questionData(
  subjectId: string,
  topicId: string,
  status: MockQuestion['status'] = 'ACTIVE',
): Prisma.MockQuestionUncheckedCreateInput {
  return {
    subjectId,
    topicId,
    status,
    stem: `ZZ-m6 stem ${randomUUID()}`,
    leadIn: null,
    educationalObjective: 'ZZ-m6 objective',
    draftModel: 'zz-m6-draft-model',
    verifierModel: null,
    promptVersion: 'zz-m6-v1',
    validatorVersion: 'zz-m6-v1',
  };
}

export function choiceData(
  questionId: string,
  position: number,
  isCorrect = position === 1,
): Prisma.MockChoiceUncheckedCreateInput {
  return {
    questionId,
    position,
    text: `ZZ-m6 choice ${position}`,
    isCorrect,
    explanation: `ZZ-m6 explanation ${position}`,
  };
}

export type QuestionWithChoices = Prisma.MockQuestionGetPayload<{
  include: { choices: true };
}>;

// All four choices must be inserted in one transaction; the R3 constraint
// trigger is deferred and checks the final state at commit.
export async function createQuestion(input: {
  subjectId: string;
  topicId?: string;
  jobId?: string | null;
  status?: MockQuestion['status'];
}): Promise<QuestionWithChoices> {
  assertTestDb();
  const topicId = input.topicId ?? (await createTopic(input.subjectId)).id;

  return prisma.$transaction(
    async tx => {
      const question = await tx.mockQuestion.create({
        data: {
          ...questionData(input.subjectId, topicId, input.status ?? 'ACTIVE'),
          jobId: input.jobId ?? null,
        },
      });
      await tx.mockChoice.createMany({
        data: [1, 2, 3, 4].map(position => choiceData(question.id, position)),
      });
      return tx.mockQuestion.findUniqueOrThrow({
        where: { id: question.id },
        include: { choices: true },
      });
    },
    { timeout: 20000 },
  );
}

export async function createQuestions(
  subjectId: string,
  count: number,
): Promise<QuestionWithChoices[]> {
  assertTestDb();
  const topic = await createTopic(subjectId);

  return prisma.$transaction(
    async tx => {
      const questions: QuestionWithChoices[] = [];
      for (let index = 0; index < count; index += 1) {
        const question = await tx.mockQuestion.create({
          data: questionData(subjectId, topic.id),
        });
        await tx.mockChoice.createMany({
          data: [1, 2, 3, 4].map(position => choiceData(question.id, position)),
        });
        const fullQuestion = await tx.mockQuestion.findUniqueOrThrow({
          where: { id: question.id },
          include: { choices: true },
        });
        questions.push(fullQuestion);
      }
      return questions;
    },
    { timeout: 25000 },
  );
}

export async function createGenerationJob(
  subjectId: string,
  state: 'QUEUED' | 'RUNNING' | 'STALLED' | 'CANCELLING' | 'CANCELLED' | 'COMPLETED' | 'FAILED' = 'QUEUED',
) {
  return prisma.generationJob.create({
    data: {
      subjectId,
      state,
      idempotencyKey: `ZZ-m6-job-${randomUUID()}`,
    },
  });
}

export async function createAttempt(subjectId: string, jobId?: string) {
  return prisma.mockAttempt.create({
    data: { subjectId, status: 'GENERATING', jobId: jobId ?? null },
  });
}

export async function addAttemptQuestions(
  attemptId: string,
  questionIds: string[],
): Promise<void> {
  if (questionIds.length > 25) {
    throw new Error('ZZ-m6 fixtures never add more than 25 attempt questions.');
  }

  await prisma.attemptQuestion.createMany({
    data: questionIds.map((questionId, index) => ({
      attemptId,
      questionId,
      position: index + 1,
      choiceOrder: [1, 2, 3, 4],
    })),
  });
}

export async function createFullAttempt(subjectId: string, count = 25) {
  const questions = await createQuestions(subjectId, count);
  const attempt = await createAttempt(subjectId);
  await addAttemptQuestions(
    attempt.id,
    questions.map(question => question.id),
  );
  return { attempt, questions };
}

// Legal playable attempt: 25 rows whose questions are all ACTIVE.
export async function createPlayableAttempt(subjectId: string) {
  const { attempt, questions } = await createFullAttempt(subjectId);
  const playable = await prisma.mockAttempt.update({
    where: { id: attempt.id },
    data: { status: 'READY' },
  });
  return { attempt: playable, questions };
}

export async function createAnswerableAttempt(subjectId: string) {
  const question = await createQuestion({ subjectId });
  const attempt = await createAttempt(subjectId);
  const attemptQuestion = await prisma.attemptQuestion.create({
    data: {
      attemptId: attempt.id,
      questionId: question.id,
      position: 1,
      choiceOrder: [1, 2, 3, 4],
    },
  });
  const choice = question.choices.find(item => item.position === 1) ?? question.choices[0];
  if (!choice) throw new Error('ZZ-m6 question fixture has no choices.');

  return { question, attempt, attemptQuestion, choice };
}

export async function createCitation(questionId: string, documentId: string | null) {
  return prisma.questionCitation.create({
    data: {
      questionId,
      documentId,
      documentTitleSnapshot: 'ZZ-m6 document',
      pageNumber: 1,
      printedPage: null,
      quote: 'ZZ-m6 quote',
    },
  });
}

// M6-specific helpers

// Create an IN_PROGRESS attempt with some answers
export async function createInProgressAttempt(subjectId: string) {
  const { attempt, questions } = await createPlayableAttempt(subjectId);
  const started = await prisma.mockAttempt.update({
    where: { id: attempt.id },
    data: { status: 'IN_PROGRESS', sessionVersion: 2, cursorPosition: 1 },
  });
  // Add an answer to question at position 1
  const answerChoice = questions[0].choices.find(c => c.position === 1)!;
  await prisma.attemptAnswer.create({
    data: {
      attemptQuestionId: (await prisma.attemptQuestion.findFirstOrThrow({
        where: { attemptId: attempt.id, position: 1 }
      })).id,
      choiceId: answerChoice.id,
      revision: 1,
      idempotencyKey: `ZZ-m6-answer-${randomUUID()}`,
    }
  });
  return { attempt: started, questions };
}

// Create a COMPLETED attempt with result
export async function createCompletedAttempt(subjectId: string) {
  const { attempt, questions } = await createPlayableAttempt(subjectId);
  
  // Add answers for all 25 questions
  const attemptQuestions = await prisma.attemptQuestion.findMany({
    where: { attemptId: attempt.id },
    orderBy: { position: 'asc' },
  });
  
  for (const aq of attemptQuestions) {
    const question = questions.find(q => q.id === aq.questionId)!;
    const correctChoice = question.choices.find(c => c.isCorrect)!;
    await prisma.attemptAnswer.create({
      data: {
        attemptQuestionId: aq.id,
        choiceId: correctChoice.id,
        revision: 1,
        idempotencyKey: `ZZ-m6-answer-${randomUUID()}`,
      }
    });
  }
  
  // Submit the attempt
  const completed = await prisma.mockAttempt.update({
    where: { id: attempt.id },
    data: { status: 'COMPLETED', cursorPosition: 26 },
  });
  
  // Create attempt result - fetch answers first to avoid async in map
  const answers = await Promise.all(
    attemptQuestions.map(aq => 
      prisma.attemptAnswer.findFirstOrThrow({ where: { attemptQuestionId: aq.id } })
    )
  );
  
  const snapshot = {
    perQuestion: attemptQuestions.map((aq, index) => ({
      position: index + 1,
      selectedChoiceId: answers[index].choiceId,
      correctChoiceId: questions[index].choices.find(c => c.isCorrect)!.id,
      topicKey: questions[index].topicId,
      isCorrect: true,
    })),
    perTopic: [{
      topicKey: questions[0].topicId,
      correct: 25,
      total: 25,
    }]
  };
  
  await prisma.attemptResult.create({
    data: {
      attemptId: attempt.id,
      score: 25,
      total: 25,
      snapshot,
    }
  });
  
  return { attempt: completed, questions };
}

// Create an AWAITING_SUBMISSION attempt
export async function createAwaitingSubmissionAttempt(subjectId: string) {
  const { attempt, questions } = await createPlayableAttempt(subjectId);
  
  // Add answers for all 25 questions
  const attemptQuestions = await prisma.attemptQuestion.findMany({
    where: { attemptId: attempt.id },
    orderBy: { position: 'asc' },
  });
  
  for (const aq of attemptQuestions) {
    const question = questions.find(q => q.id === aq.questionId)!;
    const correctChoice = question.choices.find(c => c.isCorrect)!;
    await prisma.attemptAnswer.create({
      data: {
        attemptQuestionId: aq.id,
        choiceId: correctChoice.id,
        revision: 1,
        idempotencyKey: `ZZ-m6-answer-${randomUUID()}`,
      }
    });
  }
  
  const awaiting = await prisma.mockAttempt.update({
    where: { id: attempt.id },
    data: { status: 'AWAITING_SUBMISSION', cursorPosition: 26 },
  });
  
  return { attempt: awaiting, questions };
}
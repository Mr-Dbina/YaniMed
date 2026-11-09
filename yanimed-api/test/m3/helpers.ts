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
      'Refusing to run M3 database tests: YANIMED_TEST_DB is not 1. Load src/config/load-test-env.ts first.',
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
    data: { name: `ZZ-m3-${randomUUID()}` },
  });
  createdSubjectIds.push(subject.id);
  return subject;
}

export async function createTopic(subjectId: string) {
  return prisma.subjectTopic.create({
    data: { subjectId, key: `ZZ-m3-key-${randomUUID()}`, name: 'ZZ-m3 topic' },
  });
}

export async function createPdfObject() {
  return prisma.pdfObject.create({
    data: {
      sha256: randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, ''),
      r2Key: `ZZ-m3/r2-${randomUUID()}`,
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
      title: 'ZZ-m3.pdf',
      fileUrl: `ZZ-m3/file-${randomUUID()}`,
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
    stem: `ZZ-m3 stem ${randomUUID()}`,
    leadIn: null,
    educationalObjective: 'ZZ-m3 objective',
    draftModel: 'zz-m3-draft-model',
    verifierModel: null,
    promptVersion: 'zz-m3-v1',
    validatorVersion: 'zz-m3-v1',
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
    text: `ZZ-m3 choice ${position}`,
    isCorrect,
    explanation: `ZZ-m3 explanation ${position}`,
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
): Promise<MockQuestion[]> {
  assertTestDb();
  const topic = await createTopic(subjectId);

  return prisma.$transaction(
    async tx => {
      const questions: MockQuestion[] = [];
      for (let index = 0; index < count; index += 1) {
        const question = await tx.mockQuestion.create({
          data: questionData(subjectId, topic.id),
        });
        await tx.mockChoice.createMany({
          data: [1, 2, 3, 4].map(position => choiceData(question.id, position)),
        });
        questions.push(question);
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
      idempotencyKey: `ZZ-m3-job-${randomUUID()}`,
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
    throw new Error('ZZ-m3 fixtures never add more than 25 attempt questions.');
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
  if (!choice) throw new Error('ZZ-m3 question fixture has no choices.');

  return { question, attempt, attemptQuestion, choice };
}

export async function createCitation(questionId: string, documentId: string | null) {
  return prisma.questionCitation.create({
    data: {
      questionId,
      documentId,
      documentTitleSnapshot: 'ZZ-m3 document',
      pageNumber: 1,
      printedPage: null,
      quote: 'ZZ-m3 quote',
    },
  });
}

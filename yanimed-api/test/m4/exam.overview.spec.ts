import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  assertTestDb,
  createSubjectWithQuestions,
  prisma,
  seededRng,
  service,
} from './helpers.js';

describe('M4 subject overview', () => {
  it('runs only against the throwaway test DB', () => {
    assertTestDb();
    expect(process.env.YANIMED_TEST_DB).toBe('1');
  });

  it('reports no unfinished attempt and counts eligible questions', async () => {
    const { subject } = await createSubjectWithQuestions();

    const overview = await service.getSubjectOverview(subject.id);

    expect(overview).toEqual({
      unfinishedAttempt: null,
      eligibleQuestionCount: 25,
      questionsPerTest: 25,
      generationJob: null,
    });
  });

  it('returns the unfinished attempt and clears it after discard', async () => {
    const { subject } = await createSubjectWithQuestions();
    const created = await service.createAttempt(subject.id, seededRng());

    const overview = await service.getSubjectOverview(subject.id);
    expect(overview.unfinishedAttempt).toMatchObject({
      id: created.attemptId,
      status: 'READY',
    });
    expect(overview.unfinishedAttempt?.createdAt).toBeInstanceOf(Date);
    expect(overview.eligibleQuestionCount).toBe(25);
    expect(overview.questionsPerTest).toBe(25);

    await service.discardAttempt(created.attemptId);

    const after = await service.getSubjectOverview(subject.id);
    expect(after.unfinishedAttempt).toBeNull();
    expect(after.eligibleQuestionCount).toBe(25);
  });

  it('does not count a question whose citations all lost their document', async () => {
    const { subject } = await createSubjectWithQuestions();
    const question = await prisma.mockQuestion.findFirstOrThrow({
      where: { subjectId: subject.id },
    });
    await prisma.questionCitation.deleteMany({
      where: { questionId: question.id },
    });
    await prisma.questionCitation.create({
      data: {
        questionId: question.id,
        documentId: null,
        documentTitleSnapshot: 'ZZ-m4 unavailable document',
        pageNumber: 1,
        quote: 'ZZ-m4 quote',
      },
    });

    const overview = await service.getSubjectOverview(subject.id);

    expect(overview.eligibleQuestionCount).toBe(24);
  });

  it('does not count a question with no citation at all', async () => {
    const { subject } = await createSubjectWithQuestions();
    const question = await prisma.mockQuestion.findFirstOrThrow({
      where: { subjectId: subject.id },
    });
    await prisma.questionCitation.deleteMany({
      where: { questionId: question.id },
    });

    const overview = await service.getSubjectOverview(subject.id);

    expect(overview.eligibleQuestionCount).toBe(24);
  });

  it('counts a question that keeps one live citation next to an unavailable one', async () => {
    const { subject } = await createSubjectWithQuestions();
    const question = await prisma.mockQuestion.findFirstOrThrow({
      where: { subjectId: subject.id },
    });
    await prisma.questionCitation.create({
      data: {
        questionId: question.id,
        documentId: null,
        documentTitleSnapshot: 'ZZ-m4 unavailable document',
        pageNumber: 1,
        quote: 'ZZ-m4 quote',
      },
    });

    const overview = await service.getSubjectOverview(subject.id);

    expect(overview.eligibleQuestionCount).toBe(25);
  });

  it('counts and selects by the same citation rule', async () => {
    const { subject } = await createSubjectWithQuestions();
    const questions = await prisma.mockQuestion.findMany({
      where: { subjectId: subject.id },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    const uncited = questions[0];
    const unavailable = questions[1];
    if (!uncited || !unavailable) {
      throw new Error('ZZ-m4 fixture has no questions.');
    }
    await prisma.questionCitation.deleteMany({
      where: { questionId: uncited.id },
    });
    await prisma.questionCitation.updateMany({
      where: { questionId: unavailable.id },
      data: { documentId: null },
    });

    const overview = await service.getSubjectOverview(subject.id);
    expect(overview.eligibleQuestionCount).toBe(23);

    await expect(
      service.createAttempt(subject.id, seededRng()),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_CONTENT',
      details: { available: 23, required: 25 },
    });
  });

  it('returns SUBJECT_NOT_FOUND for an unknown subject', async () => {
    await expect(
      service.getSubjectOverview(randomUUID()),
    ).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' });
  });
});

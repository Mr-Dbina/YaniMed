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

  it('returns SUBJECT_NOT_FOUND for an unknown subject', async () => {
    await expect(
      service.getSubjectOverview(randomUUID()),
    ).rejects.toMatchObject({ code: 'SUBJECT_NOT_FOUND' });
  });
});

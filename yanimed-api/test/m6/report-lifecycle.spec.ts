import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { QuestionsService } from '../../src/mock-test/questions.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { MockTestError } from '../../src/mock-test/exam.errors.js';
import {
  assertTestDb,
  cleanupSubjects,
  createSubject,
  createTopic,
  createQuestion,
  createAttempt,
  addAttemptQuestions,
  createQuestions,
  prisma,
} from './helpers.js';

describe('M6 Report Lifecycle', () => {
  let questionsService: QuestionsService;
  let testSubjectId: string;
  let testQuestionId: string;
  let testAttemptId: string;

  beforeAll(async () => {
    assertTestDb();
    const prismaService = new PrismaService();
    questionsService = new QuestionsService(prismaService);

    const subject = await createSubject();
    testSubjectId = subject.id;

    const topic = await createTopic(subject.id);
    const question = await createQuestion({
      subjectId: subject.id,
      topicId: topic.id,
    });
    testQuestionId = question.id;

    const attempt = await createAttempt(subject.id);
    testAttemptId = attempt.id;

    await addAttemptQuestions(attempt.id, [question.id]);
  });

  afterAll(async () => {
    await cleanupSubjects();
  });

  describe('POST /mock-test/questions/:id/report', () => {
    it('creates a report and immediately quarantines the question', async () => {
      const report = await questionsService.reportQuestion(
        testQuestionId,
        'ANSWER_KEY',
        'The answer key appears to be incorrect.',
      );

      expect(report).toMatchObject({
        questionId: testQuestionId,
        attemptId: testAttemptId,
        reason: 'ANSWER_KEY',
        details: 'The answer key appears to be incorrect.',
        status: 'OPEN',
      });
      expect(report.id).toBeDefined();
      expect(report.createdAt).toBeInstanceOf(Date);

      // Verify question is quarantined
      const question = await prisma.mockQuestion.findUniqueOrThrow({
        where: { id: testQuestionId },
        select: { status: true },
      });
      expect(question.status).toBe('QUARANTINED');
    });

    it('rejects reporting an already-quarantined question', async () => {
      await expect(
        questionsService.reportQuestion(
          testQuestionId,
          'AMBIGUITY',
          'Question is ambiguous.',
        ),
      ).rejects.toThrow(MockTestError);
    });

    it('links report to most recent attempt containing the question', async () => {
      // Create a second subject and question
      const subject2 = await createSubject();
      const topic2 = await createTopic(subject2.id);
      const question2 = await createQuestion({
        subjectId: subject2.id,
        topicId: topic2.id,
      });
      
      const attempt2 = await createAttempt(subject2.id);
      await addAttemptQuestions(attempt2.id, [question2.id]);

      // Report the question - should link to attempt2
      const report = await questionsService.reportQuestion(
        question2.id,
        'CITATION',
        'Citation is wrong.',
      );

      expect(report.attemptId).toBe(attempt2.id);
    });

    it('falls back to latest subject attempt when no attempt question exists', async () => {
      const subject3 = await createSubject();
      const topic3 = await createTopic(subject3.id);
      const question3 = await createQuestion({
        subjectId: subject3.id,
        topicId: topic3.id,
      });
      // Question exists but not in any attempt

      const attempt3 = await createAttempt(subject3.id);

      const report = await questionsService.reportQuestion(
        question3.id,
        'EXPLANATION',
        'Explanation is confusing.',
      );

      expect(report.attemptId).toBe(attempt3.id);
    });

    it('resolves attemptId + position to the real questionId (not attemptId)', async () => {
      const subject4 = await createSubject();
      const topic4 = await createTopic(subject4.id);
      const question4a = await createQuestion({
        subjectId: subject4.id,
        topicId: topic4.id,
      });
      const question4b = await createQuestion({
        subjectId: subject4.id,
        topicId: topic4.id,
      });
      const attempt4 = await createAttempt(subject4.id);
      await addAttemptQuestions(attempt4.id, [question4a.id, question4b.id]);

      const report = await questionsService.reportAttemptQuestion(
        attempt4.id,
        2,
        'ANSWER_KEY',
        'Second question key wrong',
      );

      expect(report.attemptId).toBe(attempt4.id);
      expect(report.questionId).toBe(question4b.id);
      expect(report.questionId).not.toBe(attempt4.id);

      const q4b = await prisma.mockQuestion.findUniqueOrThrow({
        where: { id: question4b.id },
        select: { status: true },
      });
      expect(q4b.status).toBe('QUARANTINED');

      const q4a = await prisma.mockQuestion.findUniqueOrThrow({
        where: { id: question4a.id },
        select: { status: true },
      });
      expect(q4a.status).toBe('ACTIVE');
    });
  });

  describe('GET /mock-test/questions/quarantined', () => {
    it('returns quarantined questions with their reports, choices, and citations', async () => {
      const quarantined = await questionsService.getQuarantinedQuestions();
      
      const ourQuestion = quarantined.find(q => q.questionId === testQuestionId);
      expect(ourQuestion).toBeDefined();
      expect(ourQuestion!.status).toBe('QUARANTINED');
      expect(ourQuestion!.reports).toHaveLength(1);
      expect(ourQuestion!.reports[0].reason).toBe('ANSWER_KEY');
      expect(ourQuestion!.choices).toHaveLength(4);
      expect(ourQuestion!.choices[0]).toHaveProperty('isCorrect');
      expect(ourQuestion!.choices[0]).toHaveProperty('explanation');
      expect(Array.isArray(ourQuestion!.citations)).toBe(true);
    });
  });

  describe('PATCH /mock-test/questions/:id/resolve-report', () => {
    let restoreQuestionId: string;
    let restoreAttemptId: string;

    beforeAll(async () => {
      // Create a fresh question to test RESTORE
      const subject = await createSubject();
      const topic = await createTopic(subject.id);
      const question = await createQuestion({
        subjectId: subject.id,
        topicId: topic.id,
      });
      restoreQuestionId = question.id;

      const attempt = await createAttempt(subject.id);
      restoreAttemptId = attempt.id;
      await addAttemptQuestions(attempt.id, [question.id]);

      await questionsService.reportQuestion(restoreQuestionId, 'OTHER', 'Test restore');
    });

    it('RESTORE returns question to ACTIVE and marks reports DISMISSED', async () => {
      const result = await questionsService.resolveReport(restoreQuestionId, {
        action: 'RESTORE',
        resolutionNote: 'Verified correct',
      });

      expect(result).toEqual({
        questionId: restoreQuestionId,
        status: 'ACTIVE',
      });

      // Verify question status
      const question = await prisma.mockQuestion.findUniqueOrThrow({
        where: { id: restoreQuestionId },
        select: { status: true },
      });
      expect(question.status).toBe('ACTIVE');

      // Verify reports are DISMISSED
      const reports = await prisma.questionReport.findMany({
        where: { questionId: restoreQuestionId },
      });
      expect(reports[0].status).toBe('DISMISSED');
      expect(reports[0].resolutionNote).toBe('Verified correct');
    });

    it('RESTORE changes status to ACTIVE and marks reports DISMISSED', async () => {
      const subject = await createSubject();
      const topic = await createTopic(subject.id);
      const question = await createQuestion({
        subjectId: subject.id,
        topicId: topic.id,
      });
      const attempt = await createAttempt(subject.id);
      await addAttemptQuestions(attempt.id, [question.id]);
      await questionsService.reportQuestion(question.id, 'AMBIGUITY', 'Test');

      await questionsService.resolveReport(question.id, {
        action: 'RESTORE',
        resolutionNote: 'Verified correct',
      });

      const updated = await prisma.mockQuestion.findUniqueOrThrow({
        where: { id: question.id },
        include: { choices: { orderBy: { position: 'asc' } } },
      });
      // Only status should change
      expect(updated.status).toBe('ACTIVE');
      expect(updated.stem).not.toBe('Updated stem');

      const reports = await prisma.questionReport.findMany({
        where: { questionId: question.id },
      });
      expect(reports[0].status).toBe('DISMISSED');
      expect(reports[0].resolutionNote).toBe('Verified correct');
    });

    it('RETIRE marks question RETIRED and reports ACCEPTED', async () => {
      const subject = await createSubject();
      const topic = await createTopic(subject.id);
      const question = await createQuestion({
        subjectId: subject.id,
        topicId: topic.id,
      });
      const attempt = await createAttempt(subject.id);
      await addAttemptQuestions(attempt.id, [question.id]);
      await questionsService.reportQuestion(question.id, 'ANSWER_KEY', 'Test retire');

      const result = await questionsService.resolveReport(question.id, {
        action: 'RETIRE',
        resolutionNote: 'Answer key was wrong',
      });

      expect(result).toEqual({
        questionId: question.id,
        status: 'RETIRED',
      });

      const q = await prisma.mockQuestion.findUniqueOrThrow({
        where: { id: question.id },
        select: { status: true },
      });
      expect(q.status).toBe('RETIRED');

      const reports = await prisma.questionReport.findMany({
        where: { questionId: question.id },
      });
      expect(reports[0].status).toBe('ACCEPTED');
      expect(reports[0].resolutionNote).toBe('Answer key was wrong');
    });

    it('rejects resolving an already-resolved report (not quarantined)', async () => {
      await expect(
        questionsService.resolveReport(restoreQuestionId, {
          action: 'RETIRE',
        }),
      ).rejects.toThrow(MockTestError);
    });

    it('rejects resolving a non-existent question', async () => {
      await expect(
        questionsService.resolveReport(randomUUID(), {
          action: 'RETIRE',
        }),
      ).rejects.toThrow(MockTestError);
    });
  });

  describe('Rule D10: AttemptResult scores are immutable after report resolution', () => {
    it('RESTORE does not change existing AttemptResult scores', async () => {
      const subject = await createSubject();
      const topic = await createTopic(subject.id);
      
      // Create 25 questions using helper
      const questions = await createQuestions(subject.id, 25);

      const attempt = await createAttempt(subject.id);
      await addAttemptQuestions(attempt.id, questions.map(q => q.id));

      // Answer all correctly
      for (let i = 0; i < 25; i++) {
        const aq = await prisma.attemptQuestion.findFirstOrThrow({
          where: { attemptId: attempt.id, position: i + 1 },
        });
        const correctChoice = questions[i].choices.find(c => c.isCorrect)!;
        await prisma.attemptAnswer.create({
          data: {
            attemptQuestionId: aq.id,
            choiceId: correctChoice.id,
            revision: 1,
            idempotencyKey: `ZZ-m6-d10-${randomUUID()}`,
          },
        });
      }

      // Submit and create result
      await prisma.mockAttempt.update({
        where: { id: attempt.id },
        data: { status: 'COMPLETED', cursorPosition: 26 },
      });

      const snapshot = {
        perQuestion: questions.map((q, i) => ({
          position: i + 1,
          selectedChoiceId: q.choices.find(c => c.isCorrect)!.id,
          correctChoiceId: q.choices.find(c => c.isCorrect)!.id,
          topicKey: q.topicId,
          isCorrect: true,
        })),
        perTopic: [{ topicKey: topic.id, correct: 25, total: 25 }],
      };

      const result = await prisma.attemptResult.create({
        data: {
          attemptId: attempt.id,
          score: 25,
          total: 25,
          snapshot,
        },
      });

      const originalScore = result.score;
      const originalSnapshot = result.snapshot;

      // Report and RESTORE one question
      const questionToReport = questions[0].id;
      await questionsService.reportQuestion(questionToReport, 'ANSWER_KEY', 'Test D10');
      await questionsService.resolveReport(questionToReport, {
        action: 'RESTORE',
        resolutionNote: 'Verified',
      });

      // Verify AttemptResult unchanged
      const afterResult = await prisma.attemptResult.findUniqueOrThrow({
        where: { id: result.id },
      });
      expect(afterResult.score).toBe(originalScore);
      expect(afterResult.snapshot).toEqual(originalSnapshot);
    });

    it('RETIRE does not change existing AttemptResult scores', async () => {
      const subject = await createSubject();
      const topic = await createTopic(subject.id);
      
      // Create 25 questions using helper
      const questions = await createQuestions(subject.id, 25);

      const attempt = await createAttempt(subject.id);
      await addAttemptQuestions(attempt.id, questions.map(q => q.id));

      for (let i = 0; i < 25; i++) {
        const aq = await prisma.attemptQuestion.findFirstOrThrow({
          where: { attemptId: attempt.id, position: i + 1 },
        });
        const correctChoice = questions[i].choices.find(c => c.isCorrect)!;
        await prisma.attemptAnswer.create({
          data: {
            attemptQuestionId: aq.id,
            choiceId: correctChoice.id,
            revision: 1,
            idempotencyKey: `ZZ-m6-d10r-${randomUUID()}`,
          },
        });
      }

      await prisma.mockAttempt.update({
        where: { id: attempt.id },
        data: { status: 'COMPLETED', cursorPosition: 26 },
      });

      const snapshot = {
        perQuestion: questions.map((q, i) => ({
          position: i + 1,
          selectedChoiceId: q.choices.find(c => c.isCorrect)!.id,
          correctChoiceId: q.choices.find(c => c.isCorrect)!.id,
          topicKey: q.topicId,
          isCorrect: true,
        })),
        perTopic: [{ topicKey: topic.id, correct: 25, total: 25 }],
      };

      const result = await prisma.attemptResult.create({
        data: {
          attemptId: attempt.id,
          score: 25,
          total: 25,
          snapshot,
        },
      });

      const originalScore = result.score;
      const originalSnapshot = result.snapshot;

      const questionToReport = questions[0].id;
      await questionsService.reportQuestion(questionToReport, 'ANSWER_KEY', 'Test D10 retire');
      await questionsService.resolveReport(questionToReport, {
        action: 'RETIRE',
        resolutionNote: 'Retired',
      });

      const afterResult = await prisma.attemptResult.findUniqueOrThrow({
        where: { id: result.id },
      });
      expect(afterResult.score).toBe(originalScore);
      expect(afterResult.snapshot).toEqual(originalSnapshot);
    });
  });
});
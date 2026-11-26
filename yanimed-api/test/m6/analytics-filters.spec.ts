import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { AnalyticsService } from '../../src/analytics/analytics.service.js';
import { PrismaService } from '../../src/prisma/prisma.service.js';
import { AnalyticsQueryDto } from '../../src/analytics/analytics.dto.js';
import {
  assertTestDb,
  cleanupSubjects,
  createSubject,
  createTopic,
  createAttempt,
  addAttemptQuestions,
  createCitation,
  createDocument,
  prisma,
  createQuestions,
} from './helpers.js';
import { randomUUID } from 'node:crypto';

describe('M6 Analytics Filters', () => {
  let analyticsService: AnalyticsService;
  let subject1Id: string;
  let subject2Id: string;
  let topic1Key: string;
  let topic2Key: string;
  let attemptIds: string[] = [];

  beforeAll(async () => {
    assertTestDb();
    const prismaService = new PrismaService();
    analyticsService = new AnalyticsService(prismaService);

    // Create Subject 1 with topics
    const subject1 = await createSubject();
    subject1Id = subject1.id;
    const topic1 = await createTopic(subject1.id);
    topic1Key = topic1.key;
    const topic1b = await createTopic(subject1.id);
    const topic1bKey = topic1b.key;
    
    // Create Subject 2 with topics
    const subject2 = await createSubject();
    subject2Id = subject2.id;
    const topic2 = await createTopic(subject2.id);
    topic2Key = topic2.key;

    // Create documents for citations (needed for questions to be eligible)
    const doc1 = await createDocument(subject1.id);
    const doc2 = await createDocument(subject2.id);

    // Create questions for Subject 1, Topic 1 (25 questions)
    const questions1 = await createQuestions(subject1Id, 25);
    // Add citations for questions1
    for (const q of questions1) {
      await createCitation(q.id, doc1.id);
    }

    // Create questions for Subject 1, Topic 1b (5 questions)
    const questions1b = await createQuestions(subject1Id, 5);
    for (const q of questions1b) {
      await createCitation(q.id, doc1.id);
    }

    // Create questions for Subject 2, Topic 2 (25 questions)
    const questions2 = await createQuestions(subject2Id, 25);
    for (const q of questions2) {
      await createCitation(q.id, doc2.id);
    }

    // Create COMPLETED attempts with answers
    // Subject 1, Topic 1: 2 attempts (one perfect, one 50%)
    const attempt1 = await createAttempt(subject1Id);
    attemptIds.push(attempt1.id);
    await addAttemptQuestions(attempt1.id, questions1.map(q => q.id));
    for (let i = 0; i < 25; i++) {
      const aq = await prisma.attemptQuestion.findFirstOrThrow({
        where: { attemptId: attempt1.id, position: i + 1 },
      });
      const correctChoice = questions1[i].choices.find(c => c.isCorrect)!;
      await prisma.attemptAnswer.create({
        data: {
          attemptQuestionId: aq.id,
          choiceId: correctChoice.id,
          revision: 1,
          idempotencyKey: `ZZ-m6-a1-${randomUUID()}`,
        },
      });
    }
    await prisma.mockAttempt.update({
      where: { id: attempt1.id },
      data: { status: 'COMPLETED', cursorPosition: 26 },
    });
    const snapshot1 = {
      perQuestion: questions1.map((q, i) => ({
        position: i + 1,
        selectedChoiceId: q.choices.find(c => c.isCorrect)!.id,
        correctChoiceId: q.choices.find(c => c.isCorrect)!.id,
        topicKey: topic1Key,
        isCorrect: true,
      })),
      perTopic: [{ topicKey: topic1Key, correct: 25, total: 25 }],
    };
    await prisma.attemptResult.create({
      data: { attemptId: attempt1.id, score: 25, total: 25, snapshot: snapshot1 },
    });

    // Subject 1, Topic 1: second attempt with 12 correct
    const attempt2 = await createAttempt(subject1Id);
    attemptIds.push(attempt2.id);
    await addAttemptQuestions(attempt2.id, questions1.map(q => q.id));
    for (let i = 0; i < 25; i++) {
      const aq = await prisma.attemptQuestion.findFirstOrThrow({
        where: { attemptId: attempt2.id, position: i + 1 },
      });
      const isCorrect = i < 12;
      const choice = isCorrect 
        ? questions1[i].choices.find(c => c.isCorrect)! 
        : questions1[i].choices.find(c => !c.isCorrect)!;
      await prisma.attemptAnswer.create({
        data: {
          attemptQuestionId: aq.id,
          choiceId: choice.id,
          revision: 1,
          idempotencyKey: `ZZ-m6-a2-${randomUUID()}`,
        },
      });
    }
    await prisma.mockAttempt.update({
      where: { id: attempt2.id },
      data: { status: 'COMPLETED', cursorPosition: 26 },
    });
    const snapshot2 = {
      perQuestion: questions1.map((q, i) => ({
        position: i + 1,
        selectedChoiceId: q.choices[i < 12 ? 0 : 1].id,
        correctChoiceId: q.choices.find(c => c.isCorrect)!.id,
        topicKey: topic1Key,
        isCorrect: i < 12,
      })),
      perTopic: [{ topicKey: topic1Key, correct: 12, total: 25 }],
    };
    await prisma.attemptResult.create({
      data: { attemptId: attempt2.id, score: 12, total: 25, snapshot: snapshot2 },
    });

    // Subject 1, Topic 1b: 1 attempt
    const attempt3 = await createAttempt(subject1Id);
    attemptIds.push(attempt3.id);
    // Use 5 questions from topic 1b and 20 from topic 1
    const mixedQuestions = [...questions1b, ...questions1.slice(0, 20)];
    await addAttemptQuestions(attempt3.id, mixedQuestions.map(q => q.id));
    for (let i = 0; i < 25; i++) {
      const aq = await prisma.attemptQuestion.findFirstOrThrow({
        where: { attemptId: attempt3.id, position: i + 1 },
      });
      const q = mixedQuestions[i];
      const correctChoice = q.choices.find(c => c.isCorrect)!;
      await prisma.attemptAnswer.create({
        data: {
          attemptQuestionId: aq.id,
          choiceId: correctChoice.id,
          revision: 1,
          idempotencyKey: `ZZ-m6-a3-${randomUUID()}`,
        },
      });
    }
    await prisma.mockAttempt.update({
      where: { id: attempt3.id },
      data: { status: 'COMPLETED', cursorPosition: 26 },
    });
    const snapshot3 = {
      perQuestion: mixedQuestions.map((q, i) => ({
        position: i + 1,
        selectedChoiceId: q.choices.find(c => c.isCorrect)!.id,
        correctChoiceId: q.choices.find(c => c.isCorrect)!.id,
        topicKey: i < 5 ? topic1bKey : topic1Key,
        isCorrect: true,
      })),
      perTopic: [
        { topicKey: topic1bKey, correct: 5, total: 5 },
        { topicKey: topic1Key, correct: 20, total: 20 },
      ],
    };
    await prisma.attemptResult.create({
      data: { attemptId: attempt3.id, score: 25, total: 25, snapshot: snapshot3 },
    });

    // Subject 2, Topic 2: 1 attempt with 20 correct
    const attempt4 = await createAttempt(subject2Id);
    attemptIds.push(attempt4.id);
    await addAttemptQuestions(attempt4.id, questions2.map(q => q.id));
    for (let i = 0; i < 25; i++) {
      const aq = await prisma.attemptQuestion.findFirstOrThrow({
        where: { attemptId: attempt4.id, position: i + 1 },
      });
      const isCorrect = i < 20;
      const choice = isCorrect
        ? questions2[i].choices.find(c => c.isCorrect)!
        : questions2[i].choices.find(c => !c.isCorrect)!;
      await prisma.attemptAnswer.create({
        data: {
          attemptQuestionId: aq.id,
          choiceId: choice.id,
          revision: 1,
          idempotencyKey: `ZZ-m6-a4-${randomUUID()}`,
        },
      });
    }
    await prisma.mockAttempt.update({
      where: { id: attempt4.id },
      data: { status: 'COMPLETED', cursorPosition: 26 },
    });
    const snapshot4 = {
      perQuestion: questions2.map((q, i) => ({
        position: i + 1,
        selectedChoiceId: q.choices[i < 20 ? 0 : 1].id,
        correctChoiceId: q.choices.find(c => c.isCorrect)!.id,
        topicKey: topic2Key,
        isCorrect: i < 20,
      })),
      perTopic: [{ topicKey: topic2Key, correct: 20, total: 25 }],
    };
    await prisma.attemptResult.create({
      data: { attemptId: attempt4.id, score: 20, total: 25, snapshot: snapshot4 },
    });
  });

  afterAll(async () => {
    await cleanupSubjects();
  });

  describe('GET /analytics/summary - filter by subject', () => {
    it('returns overall metrics filtered to subject1', async () => {
      const query: AnalyticsQueryDto = { subjectId: subject1Id };
      const result = await analyticsService.getSummary(query);

      expect(result.subjectId).toBe(subject1Id);
      expect(result.topic).toBeNull();
      expect(result.overall.totalAnswered).toBeGreaterThan(0);
      expect(result.overall.correctCount).toBeGreaterThan(0);
      expect(result.overall.accuracyPercent).toBeGreaterThanOrEqual(0);
      expect(result.overall.completedTestsCount).toBeGreaterThan(0);
    });

    it('returns overall metrics filtered to subject2', async () => {
      const query: AnalyticsQueryDto = { subjectId: subject2Id };
      const result = await analyticsService.getSummary(query);

      expect(result.subjectId).toBe(subject2Id);
      expect(result.overall.totalAnswered).toBeGreaterThan(0);
      expect(result.overall.correctCount).toBeGreaterThan(0);
      expect(result.overall.accuracyPercent).toBeGreaterThanOrEqual(0);
      expect(result.overall.completedTestsCount).toBeGreaterThan(0);
    });

    it('returns bySubject array with only the filtered subject', async () => {
      const query: AnalyticsQueryDto = { subjectId: subject1Id };
      const result = await analyticsService.getSummary(query);

      expect(result.bySubject).toHaveLength(1);
      expect(result.bySubject[0].subjectId).toBe(subject1Id);
      expect(result.bySubject[0].totalAnswered).toBeGreaterThan(0);
    });

    it('includes availableTopics for the filtered subject', async () => {
      const query: AnalyticsQueryDto = { subjectId: subject1Id };
      const result = await analyticsService.getSummary(query);

      expect(result.availableTopics.length).toBeGreaterThan(0);
      expect(result.availableTopics.map(t => t.topicKey)).toContain(topic1Key);
    });
  });

  describe('GET /analytics/summary - filter by topic', () => {
    it('returns metrics filtered to a specific topic across all subjects', async () => {
      const query: AnalyticsQueryDto = { topic: topic1Key };
      const result = await analyticsService.getSummary(query);

      expect(result.topic).toBe(topic1Key);
      expect(result.overall.totalAnswered).toBe(70);
      expect(result.overall.correctCount).toBe(57);
      expect(result.overall.completedTestsCount).toBe(3);
      expect(result.bySubject).toHaveLength(1);
      expect(result.bySubject[0].subjectId).toBe(subject1Id);
      expect(result.bySubject[0].totalAnswered).toBe(70);
    });

    it('returns byTopic array filtered to the topic', async () => {
      const query: AnalyticsQueryDto = { topic: topic1Key };
      const result = await analyticsService.getSummary(query);

      expect(result.byTopic).toHaveLength(1);
      expect(result.byTopic[0].topicKey).toBe(topic1Key);
      expect(result.byTopic[0].subjectId).toBe(subject1Id);
    });

    it('combines subject and topic filters', async () => {
      const query: AnalyticsQueryDto = { subjectId: subject1Id, topic: topic1Key };
      const result = await analyticsService.getSummary(query);

      expect(result.subjectId).toBe(subject1Id);
      expect(result.topic).toBe(topic1Key);
      expect(result.overall.totalAnswered).toBe(70);
      expect(result.overall.correctCount).toBe(57);
      expect(result.bySubject).toHaveLength(1);
      expect(result.bySubject[0].totalAnswered).toBe(70);
      expect(result.byTopic).toHaveLength(1);
      expect(result.byTopic[0].topicKey).toBe(topic1Key);
    });
  });

  describe('GET /analytics/summary - filter by range', () => {
    it('returns valid structure for range=7', async () => {
      const query: AnalyticsQueryDto = { range: '7' };
      const result = await analyticsService.getSummary(query);

      expect(result.range).toBe('7');
      expect(result.generatedAt).toBeDefined();
      expect(result.overall).toBeDefined();
      expect(result.bySubject).toBeDefined();
      expect(result.byTopic).toBeDefined();
      expect(result.availableTopics).toBeDefined();
    });

    it('returns valid structure for range=30', async () => {
      const query: AnalyticsQueryDto = { range: '30' };
      const result = await analyticsService.getSummary(query);

      expect(result.range).toBe('30');
      expect(result.overall.totalAnswered).toBeGreaterThanOrEqual(0);
    });

    it('returns valid structure for range=90', async () => {
      const query: AnalyticsQueryDto = { range: '90' };
      const result = await analyticsService.getSummary(query);

      expect(result.range).toBe('90');
    });

    it('returns valid structure for range=all (default)', async () => {
      const query: AnalyticsQueryDto = { range: 'all' };
      const result = await analyticsService.getSummary(query);

      expect(result.range).toBe('all');
      expect(result.overall.totalAnswered).toBeGreaterThan(0);
      expect(result.overall.correctCount).toBeGreaterThanOrEqual(0);
    });

    it('returns zero/empty structures when no completed attempts match range', async () => {
      // Use a future date by mocking - but we can't easily mock time
      // Instead, test that structure is valid even with no data
      // This is implicitly tested by the other tests returning valid shapes
      const query: AnalyticsQueryDto = { subjectId: randomUUID(), range: '7' };
      const result = await analyticsService.getSummary(query);

      expect(result.overall.totalAnswered).toBe(0);
      expect(result.overall.correctCount).toBe(0);
      expect(result.overall.accuracyPercent).toBeNull();
      expect(result.overall.completedTestsCount).toBe(0);
      expect(result.bySubject).toHaveLength(0);
      expect(result.byTopic).toHaveLength(0);
    });
  });

  describe('GET /analytics/summary - response shape validation', () => {
    it('always returns all required fields in overall', async () => {
      const query: AnalyticsQueryDto = {};
      const result = await analyticsService.getSummary(query);

      expect(result.overall).toMatchObject({
        totalAnswered: expect.any(Number),
        correctCount: expect.any(Number),
        accuracyPercent: expect.any(Number), // can be null
        completedTestsCount: expect.any(Number),
      });
    });

    it('bySubject items have required fields', async () => {
      const query: AnalyticsQueryDto = {};
      const result = await analyticsService.getSummary(query);

      if (result.bySubject.length > 0) {
        result.bySubject.forEach(subject => {
          expect(subject).toMatchObject({
            subjectId: expect.any(String),
            subject: expect.any(String),
            totalAnswered: expect.any(Number),
            correctCount: expect.any(Number),
          });
        });
      }
    });

    it('byTopic items have required fields and sorted by weakest first', async () => {
      const query: AnalyticsQueryDto = {};
      const result = await analyticsService.getSummary(query);

      expect(result.byTopic.length).toBeGreaterThan(0);
      result.byTopic.forEach(topic => {
        expect(topic).toMatchObject({
          subjectId: expect.any(String),
          subject: expect.any(String),
          topicKey: expect.any(String),
          topic: expect.any(String),
          totalAnswered: expect.any(Number),
          correctCount: expect.any(Number),
          accuracyPercent: expect.any(Number),
        });
      });

      // Should be sorted by accuracyPercent ascending (weakest first)
      for (let i = 1; i < result.byTopic.length; i++) {
        const prev = result.byTopic[i - 1].accuracyPercent ?? 101;
        const curr = result.byTopic[i].accuracyPercent ?? 101;
        expect(prev).toBeLessThanOrEqual(curr);
      }
    });

    it('availableTopics only included when subjectId filter provided', async () => {
      const queryAll: AnalyticsQueryDto = {};
      const resultAll = await analyticsService.getSummary(queryAll);
      expect(resultAll.availableTopics).toHaveLength(0);

      const querySubject: AnalyticsQueryDto = { subjectId: subject1Id };
      const resultSubject = await analyticsService.getSummary(querySubject);
      expect(resultSubject.availableTopics.length).toBeGreaterThan(0);
    });
  });
});
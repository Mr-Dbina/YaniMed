import { Test } from '@nestjs/testing';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnalyticsService } from './analytics.service.js';
import type { AnalyticsSummaryResponse } from './analytics.dto.js';

const SUBJECT_1 = '11111111-1111-4111-8111-111111111111';
const SUBJECT_2 = '22222222-2222-4222-8222-222222222222';

const prisma = {
  $queryRaw: vi.fn(),
};

describe('AnalyticsService', () => {
  let service: AnalyticsService;

  beforeEach(async () => {
    vi.resetAllMocks();

    const moduleRef = await Test.createTestingModule({
      providers: [
        AnalyticsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = moduleRef.get(AnalyticsService);
  });

  const baseOverall = {
    totalAnswered: 50,
    correctCount: 40,
    completedTestsCount: 2,
  };

  const baseBySubject = [
    { subjectId: SUBJECT_1, subject: 'Cardiology', totalAnswered: 30, correctCount: 25, accuracyPercent: 83 },
    { subjectId: SUBJECT_2, subject: 'Neurology', totalAnswered: 20, correctCount: 15, accuracyPercent: 75 },
  ];

  const baseByTopic = [
    { subjectId: SUBJECT_1, subject: 'Cardiology', topicKey: 'cardiology-basics', topic: 'Cardiology Basics', totalAnswered: 20, correctCount: 18, accuracyPercent: 90 },
    { subjectId: SUBJECT_1, subject: 'Cardiology', topicKey: 'cardiology-advanced', topic: 'Advanced Cardiology', totalAnswered: 10, correctCount: 7, accuracyPercent: 70 },
    { subjectId: SUBJECT_2, subject: 'Neurology', topicKey: 'neurology-basics', topic: 'Neurology Basics', totalAnswered: 15, correctCount: 10, accuracyPercent: 67 },
    { subjectId: SUBJECT_2, subject: 'Neurology', topicKey: 'neurology-advanced', topic: 'Advanced Neurology', totalAnswered: 5, correctCount: 5, accuracyPercent: 100 },
  ];

  const baseAvailableTopics = [
    { topicKey: 'cardiology-basics', topic: 'Cardiology Basics' },
    { topicKey: 'cardiology-advanced', topic: 'Advanced Cardiology' },
  ];

  function mockDefault() {
    prisma.$queryRaw
      .mockResolvedValueOnce([baseOverall])           // loadOverall
      .mockResolvedValueOnce(baseBySubject)           // loadBySubject
      .mockResolvedValueOnce(baseByTopic)             // loadByTopic
      .mockResolvedValueOnce(baseAvailableTopics);    // loadAvailableTopics
  }

  it('returns overall metrics with computed accuracy', async () => {
    mockDefault();

    const result = await service.getSummary({});

    expect(result.overall).toEqual({
      totalAnswered: 50,
      correctCount: 40,
      accuracyPercent: 80,
      completedTestsCount: 2,
    });
  });

  it('returns bySubject with accuracy per subject', async () => {
    mockDefault();

    const result = await service.getSummary({});

    expect(result.bySubject).toEqual([
      { subjectId: SUBJECT_1, subject: 'Cardiology', totalAnswered: 30, correctCount: 25, accuracyPercent: 83 },
      { subjectId: SUBJECT_2, subject: 'Neurology', totalAnswered: 20, correctCount: 15, accuracyPercent: 75 },
    ]);
  });

  it('returns byTopic sorted by lowest accuracy first', async () => {
    mockDefault();

    const result = await service.getSummary({});

    expect(result.byTopic.map((t) => t.topicKey)).toEqual([
      'neurology-basics',    // 67%
      'cardiology-advanced', // 70%
      'cardiology-basics',   // 90%
      'neurology-advanced',  // 100%
    ]);
  });

  it('excludes topics with zero answered from byTopic', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([baseOverall])
      .mockResolvedValueOnce(baseBySubject)
      .mockResolvedValueOnce([
        ...baseByTopic,
        { subjectId: SUBJECT_1, subject: 'Cardiology', topicKey: 'empty', topic: 'Empty Topic', totalAnswered: 0, correctCount: 0, accuracyPercent: null },
      ])
      .mockResolvedValueOnce(baseAvailableTopics);

    const result = await service.getSummary({});

    expect(result.byTopic.find((t) => t.topicKey === 'empty')).toBeUndefined();
  });

  it('filters by subjectId in query', async () => {
    mockDefault();

    await service.getSummary({ subjectId: SUBJECT_1 });

    // Check that the query was called with the subjectId filter
    const calls = prisma.$queryRaw.mock.calls;
    expect(calls.length).toBe(4);
    // The filter should be included as a parameter
    calls.forEach((call) => {
      const params = call[1] ?? call[0]?.values ?? [];
      expect(params).toContain(SUBJECT_1);
    });
  });

  it('filters by topic in query', async () => {
    mockDefault();

    await service.getSummary({ topic: 'cardiology-basics' });

    const calls = prisma.$queryRaw.mock.calls;
    calls.forEach((call) => {
      const params = call[1] ?? call[0]?.values ?? [];
      expect(params).toContain('cardiology-basics');
    });
  });

  it('filters by range (days) in query', async () => {
    mockDefault();

    await service.getSummary({ range: '30' });

    const calls = prisma.$queryRaw.mock.calls;
    calls.forEach((call) => {
      const params = call[1] ?? call[0]?.values ?? [];
      expect(params).toContain(30);
    });
  });

  it('handles all range (no date filter parameter)', async () => {
    mockDefault();

    await service.getSummary({ range: 'all' });

    const calls = prisma.$queryRaw.mock.calls;
    calls.forEach((call) => {
      const params = call[1] ?? call[0]?.values ?? [];
      // Should not have interval day parameter
      expect(params).not.toContain(7);
      expect(params).not.toContain(30);
      expect(params).not.toContain(90);
    });
  });

  it('returns null accuracy when no questions answered', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ totalAnswered: 0, correctCount: 0, completedTestsCount: 0 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await service.getSummary({});

    expect(result.overall.accuracyPercent).toBeNull();
  });

  it('returns availableTopics for selected subject', async () => {
    mockDefault();

    const result = await service.getSummary({ subjectId: SUBJECT_1 });

    expect(result.availableTopics).toEqual([
      { topicKey: 'cardiology-basics', topic: 'Cardiology Basics' },
      { topicKey: 'cardiology-advanced', topic: 'Advanced Cardiology' },
    ]);
  });

  it('returns empty availableTopics when no subject filter', async () => {
    mockDefault();

    const result = await service.getSummary({});

    expect(result.availableTopics).toEqual([]);
  });

  it('includes range, subjectId, topic, and generatedAt in response', async () => {
    mockDefault();

    const result = await service.getSummary({
      range: '90',
      subjectId: SUBJECT_1,
      topic: 'cardiology-basics',
    });

    expect(result.range).toBe('90');
    expect(result.subjectId).toBe(SUBJECT_1);
    expect(result.topic).toBe('cardiology-basics');
    expect(result.generatedAt).toBeDefined();
    expect(new Date(result.generatedAt).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('handles zero correct answers', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([{ totalAnswered: 10, correctCount: 0, completedTestsCount: 1 }])
      .mockResolvedValueOnce([{ subjectId: SUBJECT_1, subject: 'Cardiology', totalAnswered: 10, correctCount: 0, accuracyPercent: 0 }])
      .mockResolvedValueOnce([{ subjectId: SUBJECT_1, subject: 'Cardiology', topicKey: 'basics', topic: 'Basics', totalAnswered: 10, correctCount: 0, accuracyPercent: 0 }])
      .mockResolvedValueOnce(baseAvailableTopics);

    const result = await service.getSummary({});

    expect(result.overall.accuracyPercent).toBe(0);
    expect(result.bySubject[0].accuracyPercent).toBe(0);
    expect(result.byTopic[0].accuracyPercent).toBe(0);
  });

  it('defaults range to all when not provided', async () => {
    mockDefault();

    await service.getSummary({});

    const calls = prisma.$queryRaw.mock.calls;
    calls.forEach((call) => {
      const params = call[1] ?? call[0]?.values ?? [];
      expect(params).not.toContain(7);
      expect(params).not.toContain(30);
      expect(params).not.toContain(90);
    });
  });
});
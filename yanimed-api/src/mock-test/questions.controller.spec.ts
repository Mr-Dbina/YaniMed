import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionsController } from './questions.controller.js';
import { QuestionsService } from './questions.service.js';
import { MockTestErrorFilter } from './mock-test-error.filter.js';
import { MockTestGuard } from './mock-test.guard.js';

const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const QUESTION_ID = '77777777-7777-4777-8777-777777777777';
const REPORT_ID = '88888888-8888-4888-8888-888888888888';

const questionsService = {
  reportQuestion: vi.fn(),
  reportAttemptQuestion: vi.fn(),
  getQuarantinedQuestions: vi.fn(),
  resolveReport: vi.fn(),
};

describe('QuestionsController', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [QuestionsController],
      providers: [
        { provide: QuestionsService, useValue: questionsService },
      ],
    })
      .overrideGuard(MockTestGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalFilters(new MockTestErrorFilter());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports by attemptId and position without requiring questionId on the client', async () => {
    questionsService.reportAttemptQuestion.mockResolvedValueOnce({
      id: REPORT_ID,
      attemptId: ATTEMPT_ID,
      questionId: QUESTION_ID,
      reason: 'ANSWER_KEY',
      details: 'Option B is right',
      status: 'OPEN',
      resolutionNote: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    const res = await request(app.getHttpServer())
      .post(`/mock-test/attempts/${ATTEMPT_ID}/questions/3/report`)
      .set('Host', 'localhost:3000')
      .send({ reason: 'ANSWER_KEY', details: 'Option B is right' })
      .expect(201);

    expect(questionsService.reportAttemptQuestion).toHaveBeenCalledWith(
      ATTEMPT_ID,
      3,
      'ANSWER_KEY',
      'Option B is right',
    );
    expect(res.body.questionId).toBe(QUESTION_ID);
    expect(res.body.attemptId).toBe(ATTEMPT_ID);
  });

  it('allows omitting optional details when reporting', async () => {
    questionsService.reportAttemptQuestion.mockResolvedValueOnce({
      id: REPORT_ID,
      attemptId: ATTEMPT_ID,
      questionId: QUESTION_ID,
      reason: 'OTHER',
      details: null,
      status: 'OPEN',
      resolutionNote: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await request(app.getHttpServer())
      .post(`/mock-test/attempts/${ATTEMPT_ID}/questions/1/report`)
      .set('Host', 'localhost:3000')
      .send({ reason: 'OTHER' })
      .expect(201);

    expect(questionsService.reportAttemptQuestion).toHaveBeenCalledWith(
      ATTEMPT_ID,
      1,
      'OTHER',
      undefined,
    );
  });

  it('rejects out-of-range question positions', async () => {
    await request(app.getHttpServer())
      .post(`/mock-test/attempts/${ATTEMPT_ID}/questions/26/report`)
      .set('Host', 'localhost:3000')
      .send({ reason: 'ANSWER_KEY' })
      .expect(400);

    expect(questionsService.reportAttemptQuestion).not.toHaveBeenCalled();
  });
});

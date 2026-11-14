import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConflictException, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ExamController } from './exam.controller.js';
import type { ExamQuestionDto, ReviewDto, ResultDto } from './exam.dto.js';
import {
  MockTestError,
  type MockTestErrorCode,
} from './exam.errors.js';
import type {
  QuestionProgressResponse,
  ReviewNavigatorResponse,
  SubjectOverviewResponse,
} from './exam.service.js';
import { ExamService } from './exam.service.js';
import { MockTestErrorFilter } from './mock-test-error.filter.js';
import { MockTestGuard } from './mock-test.guard.js';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222';
const CHOICE_ID = '33333333-3333-4333-8333-333333333333';
const KEY = 'zz-key-123456';
const BROKEN_UUID = 'not-a-uuid';

const exam = {
  getSubjectOverview: vi.fn(),
  createAttempt: vi.fn(),
  startAttempt: vi.fn(),
  getCurrentQuestion: vi.fn(),
  answerQuestion: vi.fn(),
  skipQuestion: vi.fn(),
  getReviewNavigator: vi.fn(),
  submitAttempt: vi.fn(),
  getResult: vi.fn(),
  getReview: vi.fn(),
  discardAttempt: vi.fn(),
};

type ServiceKey = keyof typeof exam;

const QUESTION: ExamQuestionDto = {
  attemptId: ATTEMPT_ID,
  position: 1,
  total: 25,
  status: 'UNSEEN',
  stem: 'ZZ fixture stem',
  leadIn: null,
  choices: [
    { id: CHOICE_ID, letter: 'A', text: 'ZZ choice A' },
    { id: '44444444-4444-4444-8444-444444444444', letter: 'B', text: 'ZZ choice B' },
    { id: '55555555-5555-4555-8555-555555555555', letter: 'C', text: 'ZZ choice C' },
    { id: '66666666-6666-4666-8666-666666666666', letter: 'D', text: 'ZZ choice D' },
  ],
  selectedChoiceId: null,
};

const PROGRESS: QuestionProgressResponse = {
  nextQuestion: QUESTION,
  status: 'IN_PROGRESS',
  answeredCount: 1,
};

const NAVIGATOR: ReviewNavigatorResponse = {
  attemptId: ATTEMPT_ID,
  status: 'AWAITING_SUBMISSION',
  items: [
    {
      position: 1,
      answered: true,
      selectedChoiceId: CHOICE_ID,
      stem: QUESTION.stem,
      leadIn: QUESTION.leadIn,
      choices: QUESTION.choices,
    },
  ],
};

const RESULT: ResultDto = {
  attemptId: ATTEMPT_ID,
  score: 20,
  total: 25,
  percentage: 80,
  correctCount: 20,
  incorrectCount: 5,
  unansweredCount: 0,
  perTopic: [{ topicKey: 'zz-topic', correct: 20, total: 25 }],
};

const REVIEW: ReviewDto = {
  attemptId: ATTEMPT_ID,
  score: 20,
  total: 25,
  percentage: 80,
  perTopic: [{ topicKey: 'zz-topic', correct: 20, total: 25 }],
  questions: [],
};

const OVERVIEW: SubjectOverviewResponse = {
  unfinishedAttempt: {
    id: ATTEMPT_ID,
    status: 'READY',
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
  },
  eligibleQuestionCount: 25,
  questionsPerTest: 25,
  generationJob: null,
};

const ANSWER_BODY = {
  sessionVersion: 1,
  position: 1,
  choiceId: CHOICE_ID,
  idempotencyKey: KEY,
};
const SKIP_BODY = { sessionVersion: 1, position: 1 };
const SUBMIT_BODY = { sessionVersion: 1, idempotencyKey: KEY };

interface RouteCase {
  name: string;
  method: 'get' | 'post';
  url: string;
  body?: unknown;
  service: ServiceKey;
  response: unknown;
  args: unknown[];
  status: number;
}

const ROUTES: RouteCase[] = [
  {
    name: 'GET overview',
    method: 'get',
    url: `/mock-test/subjects/${SUBJECT_ID}/overview`,
    service: 'getSubjectOverview',
    response: OVERVIEW,
    args: [SUBJECT_ID],
    status: 200,
  },
  {
    name: 'POST create attempt',
    method: 'post',
    url: `/mock-test/subjects/${SUBJECT_ID}/attempts`,
    service: 'createAttempt',
    response: { attemptId: ATTEMPT_ID, status: 'READY' },
    args: [SUBJECT_ID],
    status: 201,
  },
  {
    name: 'POST start',
    method: 'post',
    url: `/mock-test/attempts/${ATTEMPT_ID}/start`,
    service: 'startAttempt',
    response: { attemptId: ATTEMPT_ID, sessionVersion: 1, question: QUESTION },
    args: [ATTEMPT_ID],
    status: 200,
  },
  {
    name: 'GET current',
    method: 'get',
    url: `/mock-test/attempts/${ATTEMPT_ID}/current?sessionVersion=1`,
    service: 'getCurrentQuestion',
    response: QUESTION,
    args: [ATTEMPT_ID, 1],
    status: 200,
  },
  {
    name: 'POST answer',
    method: 'post',
    url: `/mock-test/attempts/${ATTEMPT_ID}/answer`,
    body: ANSWER_BODY,
    service: 'answerQuestion',
    response: PROGRESS,
    args: [ATTEMPT_ID, ANSWER_BODY],
    status: 200,
  },
  {
    name: 'POST skip',
    method: 'post',
    url: `/mock-test/attempts/${ATTEMPT_ID}/skip`,
    body: SKIP_BODY,
    service: 'skipQuestion',
    response: PROGRESS,
    args: [ATTEMPT_ID, SKIP_BODY],
    status: 200,
  },
  {
    name: 'GET review navigator',
    method: 'get',
    url: `/mock-test/attempts/${ATTEMPT_ID}/review-navigator?sessionVersion=1`,
    service: 'getReviewNavigator',
    response: NAVIGATOR,
    args: [ATTEMPT_ID, 1],
    status: 200,
  },
  {
    name: 'POST submit',
    method: 'post',
    url: `/mock-test/attempts/${ATTEMPT_ID}/submit`,
    body: SUBMIT_BODY,
    service: 'submitAttempt',
    response: RESULT,
    args: [ATTEMPT_ID, 1, KEY],
    status: 200,
  },
  {
    name: 'GET result',
    method: 'get',
    url: `/mock-test/attempts/${ATTEMPT_ID}/result`,
    service: 'getResult',
    response: RESULT,
    args: [ATTEMPT_ID],
    status: 200,
  },
  {
    name: 'GET review',
    method: 'get',
    url: `/mock-test/attempts/${ATTEMPT_ID}/review`,
    service: 'getReview',
    response: REVIEW,
    args: [ATTEMPT_ID],
    status: 200,
  },
  {
    name: 'POST discard',
    method: 'post',
    url: `/mock-test/attempts/${ATTEMPT_ID}/discard`,
    service: 'discardAttempt',
    response: { attemptId: ATTEMPT_ID, status: 'ABANDONED' },
    args: [ATTEMPT_ID],
    status: 200,
  },
];

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function mockFor(key: ServiceKey) {
  return exam[key] as ReturnType<typeof vi.fn>;
}

function expectNoServiceCalls(): void {
  for (const mock of Object.values(exam)) {
    expect(mock).not.toHaveBeenCalled();
  }
}

let app: INestApplication;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ['NODE_ENV', 'MOCK_TEST_ENABLED']) {
    savedEnv[key] = process.env[key];
  }
  process.env.NODE_ENV = 'test';

  const moduleRef = await Test.createTestingModule({
    controllers: [ExamController],
    providers: [
      MockTestGuard,
      MockTestErrorFilter,
      { provide: ExamService, useValue: exam },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.NODE_ENV = 'test';
  process.env.MOCK_TEST_ENABLED = 'true';
  app.get(MockTestGuard).resetRateLimit();
});

function call(route: RouteCase, url = route.url) {
  const server = request(app.getHttpServer());
  const req = route.method === 'get' ? server.get(url) : server.post(url);
  req.set('Host', 'localhost:3000');
  return route.body === undefined ? req : req.send(route.body as object);
}

describe('ExamController flag-off behaviour', () => {
  it('returns 404 on every route when MOCK_TEST_ENABLED is missing', async () => {
    delete process.env.MOCK_TEST_ENABLED;
    app.get(MockTestGuard).resetRateLimit();

    for (const route of ROUTES) {
      const res = await call(route);
      expect(res.status, route.name).toBe(404);
      expect(JSON.stringify(res.body), route.name).not.toContain('mock-test');
    }

    expectNoServiceCalls();
  });

  it('returns 404 on every route when the flag is not exactly "true"', async () => {
    process.env.MOCK_TEST_ENABLED = 'false';

    for (const route of ROUTES) {
      const res = await call(route);
      expect(res.status, route.name).toBe(404);
    }

    expectNoServiceCalls();
  });
});

describe('ExamController pass-through', () => {
  it.each(ROUTES)(
    '$name returns the service value unchanged',
    async (route) => {
      mockFor(route.service).mockResolvedValue(route.response);

      const res = await call(route);

      expect(res.status).toBe(route.status);
      expect(res.body).toEqual(plain(route.response));
      expect(mockFor(route.service)).toHaveBeenCalledWith(...route.args);
    },
  );

  it('GET current accepts a numeric query string and coerces it', async () => {
    exam.getCurrentQuestion.mockResolvedValue(QUESTION);

    const res = await request(app.getHttpServer())
      .get(`/mock-test/attempts/${ATTEMPT_ID}/current?sessionVersion=3`)
      .set('Host', 'localhost:3000')
      .expect(200);

    expect(res.body).toEqual(plain(QUESTION));
    expect(exam.getCurrentQuestion).toHaveBeenCalledWith(ATTEMPT_ID, 3);
  });
});

describe('ExamController validation', () => {
  it.each(ROUTES)('$name rejects a malformed path id', async (route) => {
    const badUrl = route.url
      .split(SUBJECT_ID)
      .join(BROKEN_UUID)
      .split(ATTEMPT_ID)
      .join(BROKEN_UUID);

    const res = await call(route, badUrl);

    expect(res.status, route.name).toBe(400);
    expectNoServiceCalls();
  });

  it.each([
    ['sessionVersion 0', { ...ANSWER_BODY, sessionVersion: 0 }],
    ['sessionVersion decimal', { ...ANSWER_BODY, sessionVersion: 1.5 }],
    ['position 0', { ...ANSWER_BODY, position: 0 }],
    ['position 26', { ...ANSWER_BODY, position: 26 }],
    ['choiceId not a UUID', { ...ANSWER_BODY, choiceId: BROKEN_UUID }],
    ['short idempotencyKey', { ...ANSWER_BODY, idempotencyKey: 'short' }],
    ['unknown property', { ...ANSWER_BODY, extra: 'nope' }],
    ['missing property', { sessionVersion: 1 }],
  ])('answer rejects %s and never calls the service', async (_name, body) => {
    const res = await request(app.getHttpServer())
      .post(`/mock-test/attempts/${ATTEMPT_ID}/answer`)
      .set('Host', 'localhost:3000')
      .send(body)
      .expect(400);

    expect(JSON.stringify(res.body)).not.toContain(BROKEN_UUID);
    expectNoServiceCalls();
  });

  it('skip validates position and sessionVersion', async () => {
    await request(app.getHttpServer())
      .post(`/mock-test/attempts/${ATTEMPT_ID}/skip`)
      .set('Host', 'localhost:3000')
      .send({ sessionVersion: 0, position: 26 })
      .expect(400);
    expectNoServiceCalls();
  });

  it('submit validates idempotencyKey and sessionVersion', async () => {
    await request(app.getHttpServer())
      .post(`/mock-test/attempts/${ATTEMPT_ID}/submit`)
      .set('Host', 'localhost:3000')
      .send({ sessionVersion: 0, idempotencyKey: 'short' })
      .expect(400);
    expectNoServiceCalls();
  });

  it.each([
    ['GET current', `/mock-test/attempts/${ATTEMPT_ID}/current`],
    ['GET review navigator', `/mock-test/attempts/${ATTEMPT_ID}/review-navigator`],
  ])('%s rejects a missing or invalid sessionVersion query', async (_name, url) => {
    for (const query of ['', '?sessionVersion=0', '?sessionVersion=abc', '?sessionVersion=1.5']) {
      const res = await request(app.getHttpServer())
        .get(`${url}${query}`)
        .set('Host', 'localhost:3000');
      expect(res.status, `${url}${query}`).toBe(400);
    }
    expectNoServiceCalls();
  });
});

describe('MockTestErrorFilter mapping', () => {
  const MESSAGES: Record<MockTestErrorCode, string> = {
    ATTEMPT_EXISTS: 'An unfinished attempt already exists for this subject.',
    INSUFFICIENT_CONTENT: 'This subject does not have enough eligible questions.',
    SESSION_SUPERSEDED: 'This exam was opened in another window.',
    REVISION_CONFLICT: 'This answer was already changed.',
    NOT_ALL_ANSWERED: 'Every question must be answered before submitting.',
    NOT_IN_PROGRESS: 'This exam is not in a state that allows this action.',
    NOT_EDITABLE: 'Answers can no longer be changed.',
    SKIP_NOT_ALLOWED: 'This question cannot be skipped.',
    ATTEMPT_NOT_FOUND: 'Attempt not found.',
    QUESTION_NOT_FOUND: 'Question not found.',
    INVALID_CHOICE: 'The selected choice is not valid for this question.',
    SUBJECT_NOT_FOUND: 'Subject not found.',
  };

  const CONFLICT_CODES: MockTestErrorCode[] = [
    'ATTEMPT_EXISTS',
    'SESSION_SUPERSEDED',
    'REVISION_CONFLICT',
    'NOT_ALL_ANSWERED',
    'NOT_IN_PROGRESS',
    'NOT_EDITABLE',
    'SKIP_NOT_ALLOWED',
  ];

  it.each([
    ...CONFLICT_CODES.map((code) => [code, 409] as const),
    ['ATTEMPT_NOT_FOUND', 404] as const,
    ['QUESTION_NOT_FOUND', 404] as const,
    ['SUBJECT_NOT_FOUND', 404] as const,
    ['INVALID_CHOICE', 400] as const,
  ])('maps %s to status %i', async (code, status) => {
    exam.answerQuestion.mockRejectedValueOnce(new MockTestError(code));

    const res = await request(app.getHttpServer())
      .post(`/mock-test/attempts/${ATTEMPT_ID}/answer`)
      .set('Host', 'localhost:3000')
      .send(ANSWER_BODY);

    expect(res.status).toBe(status);
    expect(res.body).toEqual({ code, message: MESSAGES[code] });
  });

  it('adds attemptId only for ATTEMPT_EXISTS', async () => {
    exam.createAttempt.mockRejectedValueOnce(
      new MockTestError('ATTEMPT_EXISTS', { attemptId: ATTEMPT_ID }),
    );

    const res = await request(app.getHttpServer())
      .post(`/mock-test/subjects/${SUBJECT_ID}/attempts`)
      .set('Host', 'localhost:3000');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'ATTEMPT_EXISTS',
      message: MESSAGES.ATTEMPT_EXISTS,
      attemptId: ATTEMPT_ID,
    });
  });

  it('adds eligible and required counts only for INSUFFICIENT_CONTENT', async () => {
    exam.createAttempt.mockRejectedValueOnce(
      new MockTestError('INSUFFICIENT_CONTENT', {
        details: { available: 10, required: 25 },
      }),
    );

    const res = await request(app.getHttpServer())
      .post(`/mock-test/subjects/${SUBJECT_ID}/attempts`)
      .set('Host', 'localhost:3000');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'INSUFFICIENT_CONTENT',
      message: MESSAGES.INSUFFICIENT_CONTENT,
      eligible: 10,
      required: 25,
    });
  });

  it('leaves HttpExceptions untouched', async () => {
    exam.getResult.mockRejectedValueOnce(new ConflictException('custom conflict'));

    const res = await request(app.getHttpServer())
      .get(`/mock-test/attempts/${ATTEMPT_ID}/result`)
      .set('Host', 'localhost:3000');

    expect(res.status).toBe(409);
    expect(res.body.message).toBe('custom conflict');
    expect(res.body.code).toBeUndefined();
  });

  it('turns unknown errors into a standard 500 without internals', async () => {
    exam.getResult.mockRejectedValueOnce(
      new Error('secret-internal-detail'),
    );

    const res = await request(app.getHttpServer())
      .get(`/mock-test/attempts/${ATTEMPT_ID}/result`)
      .set('Host', 'localhost:3000');

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('secret-internal-detail');
    expect(res.body.code).toBeUndefined();
  });
});

describe('ExamController contract', () => {
  it('applies MockTestGuard at class level', () => {
    const guards = Reflect.getMetadata('__guards__', ExamController) as
      | unknown[]
      | undefined;
    expect(guards).toContain(MockTestGuard);
  });

  it('exam-safe routes never expose correctness, explanations or citations', async () => {
    exam.getCurrentQuestion.mockResolvedValue(QUESTION);
    exam.answerQuestion.mockResolvedValue(PROGRESS);
    exam.skipQuestion.mockResolvedValue(PROGRESS);
    exam.getReviewNavigator.mockResolvedValue(NAVIGATOR);

    const responses = await Promise.all([
      request(app.getHttpServer())
        .get(`/mock-test/attempts/${ATTEMPT_ID}/current?sessionVersion=1`)
        .set('Host', 'localhost:3000')
        .expect(200),
      request(app.getHttpServer())
        .post(`/mock-test/attempts/${ATTEMPT_ID}/answer`)
        .set('Host', 'localhost:3000')
        .send(ANSWER_BODY)
        .expect(200),
      request(app.getHttpServer())
        .post(`/mock-test/attempts/${ATTEMPT_ID}/skip`)
        .set('Host', 'localhost:3000')
        .send(SKIP_BODY)
        .expect(200),
      request(app.getHttpServer())
        .get(`/mock-test/attempts/${ATTEMPT_ID}/review-navigator?sessionVersion=1`)
        .set('Host', 'localhost:3000')
        .expect(200),
    ]);

    for (const res of responses) {
      const json = JSON.stringify(res.body);
      for (const forbidden of [
        'isCorrect',
        'explanation',
        'citation',
        'correctChoiceId',
        'topic',
      ]) {
        expect(json).not.toContain(forbidden);
      }
    }
  });
});

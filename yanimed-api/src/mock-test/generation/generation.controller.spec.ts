import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
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
import type {
  ActiveGenerationJobResponse,
  CreateGenerationJobResponse,
  GenerationProgressDto,
} from './generation.dto.js';
import { GenerationController } from './generation.controller.js';
import { GenerationError } from './generation.errors.js';
import { GenerationService } from './generation.service.js';
import { MockTestErrorFilter } from '../mock-test-error.filter.js';
import { MockTestGuard } from '../mock-test.guard.js';

const SUBJECT_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const BROKEN_UUID = 'not-a-uuid';
const KEY = 'zz-key-123456';

const CREATED: CreateGenerationJobResponse = {
  jobId: JOB_ID,
  state: 'QUEUED',
  requestedCount: 25,
  acceptedCount: 0,
};

const ACTIVE: ActiveGenerationJobResponse = {
  job: {
    jobId: JOB_ID,
    state: 'RUNNING',
    acceptedCount: 3,
    requestedCount: 25,
  },
};

const PROGRESS: GenerationProgressDto = {
  jobId: JOB_ID,
  subjectId: SUBJECT_ID,
  state: 'RUNNING',
  requestedCount: 25,
  acceptedCount: 3,
  aiCallCount: 9,
  recoveryCount: 0,
  failureReason: null,
  phase: 'DRAFTING',
  startedAt: new Date('2026-01-01T00:00:01.000Z'),
  heartbeatAt: new Date('2026-01-01T00:00:02.000Z'),
  finishedAt: null,
  documents: [{ id: '33333333-3333-4333-8333-333333333333', title: 'ZZ one' }],
};

const generation = {
  createJob: vi.fn(),
  getActiveJob: vi.fn(),
  getProgress: vi.fn(),
  cancelJob: vi.fn(),
};

type ServiceKey = keyof typeof generation;

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
    name: 'POST create job',
    method: 'post',
    url: `/mock-test/subjects/${SUBJECT_ID}/generation-jobs`,
    body: { idempotencyKey: KEY },
    service: 'createJob',
    response: CREATED,
    args: [SUBJECT_ID, KEY],
    status: 201,
  },
  {
    name: 'GET active job',
    method: 'get',
    url: `/mock-test/subjects/${SUBJECT_ID}/generation-jobs/active`,
    service: 'getActiveJob',
    response: ACTIVE,
    args: [SUBJECT_ID],
    status: 200,
  },
  {
    name: 'GET progress',
    method: 'get',
    url: `/mock-test/generation-jobs/${JOB_ID}`,
    service: 'getProgress',
    response: PROGRESS,
    args: [JOB_ID],
    status: 200,
  },
  {
    name: 'POST cancel',
    method: 'post',
    url: `/mock-test/generation-jobs/${JOB_ID}/cancel`,
    service: 'cancelJob',
    response: { jobId: JOB_ID, state: 'CANCELLING' },
    args: [JOB_ID],
    status: 200,
  },
];

function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function mockFor(key: ServiceKey) {
  return generation[key] as ReturnType<typeof vi.fn>;
}

function expectNoServiceCalls(): void {
  for (const mock of Object.values(generation)) {
    expect(mock).not.toHaveBeenCalled();
  }
}

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [
    key,
    ...keysOf(child),
  ]);
}

let app: INestApplication;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ['NODE_ENV', 'MOCK_TEST_ENABLED']) {
    savedEnv[key] = process.env[key];
  }
  process.env.NODE_ENV = 'test';

  const moduleRef = await Test.createTestingModule({
    controllers: [GenerationController],
    providers: [
      MockTestGuard,
      MockTestErrorFilter,
      { provide: GenerationService, useValue: generation },
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

describe('GenerationController flag-off behaviour', () => {
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
});

describe('GenerationController pass-through', () => {
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

  it('accepts an empty create body and passes no idempotency key', async () => {
    generation.createJob.mockResolvedValue(CREATED);

    const res = await request(app.getHttpServer())
      .post(`/mock-test/subjects/${SUBJECT_ID}/generation-jobs`)
      .set('Host', 'localhost:3000')
      .send({})
      .expect(201);

    expect(res.body).toEqual(plain(CREATED));
    expect(generation.createJob).toHaveBeenCalledWith(SUBJECT_ID, undefined);
  });

  it.each(ROUTES)('$name rejects a malformed path id', async (route) => {
    const badUrl = route.url
      .split(SUBJECT_ID)
      .join(BROKEN_UUID)
      .split(JOB_ID)
      .join(BROKEN_UUID);

    const res = await call(route, badUrl);

    expect(res.status).toBe(400);
    expect(mockFor(route.service)).not.toHaveBeenCalled();
  });
});

describe('GenerationController progress contract', () => {
  it('returns no question text, key, explanation, citation or source text', async () => {
    generation.getProgress.mockResolvedValue(PROGRESS);

    const res = await request(app.getHttpServer())
      .get(`/mock-test/generation-jobs/${JOB_ID}`)
      .set('Host', 'localhost:3000')
      .expect(200);

    const keys = keysOf(res.body);
    for (const forbidden of [
      'stem',
      'leadIn',
      'keyExplanation',
      'keyIndex',
      'explanation',
      'citation',
      'citations',
      'quote',
      'source',
      'sourceText',
      'text',
      'planJson',
    ]) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('rejects an unknown create body field', async () => {
    const res = await request(app.getHttpServer())
      .post(`/mock-test/subjects/${SUBJECT_ID}/generation-jobs`)
      .set('Host', 'localhost:3000')
      .send({ idempotencyKey: KEY, stem: 'ZZ not allowed' });

    expect(res.status).toBe(400);
    expect(generation.createJob).not.toHaveBeenCalled();
  });
});

describe('GenerationController error mapping', () => {
  it.each([
    ['GENERATION_IN_PROGRESS', 409],
    ['NO_READY_DOCUMENTS', 409],
    ['GENERATION_NOT_FOUND', 404],
    ['GENERATION_NOT_CANCELLABLE', 409],
  ] as const)('maps %s to %i without row data', async (code, status) => {
    generation.createJob.mockRejectedValue(
      new GenerationError(code, { jobId: JOB_ID }),
    );

    const res = await request(app.getHttpServer())
      .post(`/mock-test/subjects/${SUBJECT_ID}/generation-jobs`)
      .set('Host', 'localhost:3000')
      .send({})
      .expect(status);

    expect(res.body).toEqual({
      code,
      message: expect.any(String) as string,
    });
    expect(JSON.stringify(res.body)).not.toContain(JOB_ID);
  });
});

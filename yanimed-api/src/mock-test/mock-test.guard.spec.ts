import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import {
  ForbiddenException, HttpException, NotFoundException,
  type ExecutionContext, type INestApplication,
} from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatGuard } from '../chat/chat.guard.js';
import { MockTestGuard } from './mock-test.guard.js';
import { MockTestModule } from './mock-test.module.js';

function context(overrides: {
  host?: string;
  remoteAddress?: string;
  headers?: Record<string, string>;
} = {}): ExecutionContext {
  const req = {
    headers: { host: overrides.host ?? 'localhost:3000', ...overrides.headers },
    socket: { remoteAddress: overrides.remoteAddress ?? '::1' },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['NODE_ENV', 'MOCK_TEST_ENABLED', 'CORS_ORIGINS']) {
    savedEnv[key] = process.env[key];
  }
  process.env.NODE_ENV = 'test';
  process.env.MOCK_TEST_ENABLED = 'true';
  process.env.CORS_ORIGINS = 'http://localhost:3001';
});

afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.restoreAllMocks();
});

describe('MockTestGuard feature flag', () => {
  it('returns 404 when MOCK_TEST_ENABLED is missing', () => {
    delete process.env.MOCK_TEST_ENABLED;

    expect(() => new MockTestGuard().canActivate(context())).toThrow(NotFoundException);
  });

  it('returns 404 when MOCK_TEST_ENABLED is "false"', () => {
    process.env.MOCK_TEST_ENABLED = 'false';

    expect(() => new MockTestGuard().canActivate(context())).toThrow(NotFoundException);
  });

  it('returns 404 when MOCK_TEST_ENABLED is not exactly "true"', () => {
    process.env.MOCK_TEST_ENABLED = 'TRUE';

    expect(() => new MockTestGuard().canActivate(context())).toThrow(NotFoundException);
  });

  it('returns 404 in production even with the flag true', () => {
    process.env.NODE_ENV = 'production';

    expect(() => new MockTestGuard().canActivate(context())).toThrow(NotFoundException);
  });

  it.each(['::1', '::ffff:127.0.0.1', '127.0.0.1'])(
    'passes a localhost caller from %s when the flag is exactly "true"',
    (remoteAddress) => {
      expect(
        new MockTestGuard().canActivate(context({ remoteAddress })),
      ).toBe(true);
    },
  );

  it('rejects a non-localhost Host header', () => {
    expect(() =>
      new MockTestGuard().canActivate(context({ host: 'remote.example' })),
    ).toThrow(ForbiddenException);
  });

  it('rejects a non-loopback socket even with a local Host', () => {
    expect(() =>
      new MockTestGuard().canActivate(context({ remoteAddress: '192.168.1.2' })),
    ).toThrow(ForbiddenException);
  });
});

describe('MockTestGuard quota window', () => {
  it('throttles the 61st request in one minute and allows a fresh window', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const guard = new MockTestGuard();
    guard.resetRateLimit();

    for (let index = 0; index < 60; index += 1) {
      expect(guard.canActivate(context())).toBe(true);
    }

    let error: unknown;
    try {
      guard.canActivate(context());
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);

    now.mockReturnValue(160_000);
    expect(guard.canActivate(context())).toBe(true);
  });

  it('keeps its own counter separate from ChatGuard', () => {
    const mockTest = new MockTestGuard();
    mockTest.resetRateLimit();
    for (let index = 0; index < 60; index += 1) {
      expect(mockTest.canActivate(context())).toBe(true);
    }

    // ChatGuard allows 10 per minute. If the two guards shared a counter this
    // first chat call would be request 61 and fail with 429.
    expect(new ChatGuard().canActivate(context())).toBe(true);
  });
});

describe('Mock Test health route', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [MockTestModule],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app?.close();
  });

  const get = () => request(app.getHttpServer())
    .get('/mock-test/health')
    .set('Host', 'localhost:3000');

  it('returns 404 when the flag is missing and leaks no module details', async () => {
    delete process.env.MOCK_TEST_ENABLED;

    const res = await get().expect(404);
    expect(res.body.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('mock-test');
  });

  it('returns 404 when the flag is "false"', async () => {
    process.env.MOCK_TEST_ENABLED = 'false';

    await get().expect(404);
  });

  it('returns the health payload when the flag is "true"', async () => {
    const res = await get().expect(200);
    expect(res.body).toEqual({
      ok: true,
      module: 'mock-test',
      questionsPerTest: 25,
    });
  });

  it('returns 404 in production even with the flag true', async () => {
    process.env.NODE_ENV = 'production';

    await get().expect(404);
  });
});

import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { type INestApplication, type ExecutionContext, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatController } from './chat.controller.js';
import { ChatGuard } from './chat.guard.js';
import { OmniRouteService } from '../omniroute/omniroute.service.js';

describe('Chat HTTP contract (mocked gateway, no database)', () => {
  let app: INestApplication;
  const complete = vi.fn();
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('CORS_ORIGINS', 'http://localhost:3001');
    complete.mockReset().mockResolvedValue({ content: 'Development answer', model: 'resolved-model' });
    const module = await Test.createTestingModule({
      controllers: [ChatController],
      providers: [ChatGuard, {
        provide: OmniRouteService,
        useValue: { complete, getRequestedModel: () => 'yanimed' },
      }],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  const post = () => request(app.getHttpServer()).post('/chat/answer')
    .set('Host', 'localhost:3000').set('Origin', 'http://localhost:3001');

  it('trims input and returns the exact ungrounded contract with server instructions', async () => {
    const res = await post().send({ prompt: '  Hello  ' }).expect(200);
    expect(res.body).toEqual({
      answer: 'Development answer', citations: [], grounding: 'ungrounded',
      metadata: { gateway: 'omniroute', requestedModel: 'yanimed', servedModel: 'resolved-model', provider: null, durationMs: expect.any(Number) },
    });
    expect(complete).toHaveBeenCalledWith('Hello', expect.stringContaining('without reference material'));
    expect(complete.mock.calls[0][1]).toContain('Do not invent citations, sources, or page numbers');
  });
  it.each([
    {}, { prompt: '' }, { prompt: '  ' }, { prompt: 42 }, { prompt: null },
    { prompt: 'a'.repeat(2001) },
    ...['model', 'provider', 'systemPrompt', 'sourceId', 'extra'].map((key) => ({ prompt: 'Hi', [key]: 'not allowed' })),
  ])('rejects invalid input %j before gateway use', async (body) => {
    await post().send(body).expect(400);
    expect(complete).not.toHaveBeenCalled();
  });
  it('accepts the 2000-character boundary after trimming', async () => {
    await post().send({ prompt: ` ${'a'.repeat(2000)} ` }).expect(200);
  });
  it('does not derive citations from model text', async () => {
    complete.mockResolvedValue({ content: 'An unverified source, page 10', model: null });
    const res = await post().send({ prompt: 'Hello' }).expect(200);
    expect(res.body.citations).toEqual([]);
    expect(res.body.metadata.provider).toBeNull();
    expect(res.body.metadata.servedModel).toBeNull();
  });
  it.each(['', '   '])('rejects empty completion %j', async (content) => {
    complete.mockResolvedValue({ content, model: null });
    await post().send({ prompt: 'Hello' }).expect(503);
  });
  it('returns a safe HTTP error without upstream details', async () => {
    complete.mockRejectedValue(new Error('private upstream diagnostic'));
    const res = await post().send({ prompt: 'Hello' }).expect(503);
    expect(res.body.message).toBe('AI answer unavailable. Please try again shortly.');
    expect(JSON.stringify(res.body)).not.toContain('private upstream');
    expect(res.body).not.toHaveProperty('stack');
    expect(res.body).not.toHaveProperty('answer');
  });
  it('returns 404 in production without gateway use', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await post().send({ prompt: 'Hello' }).expect(404);
    expect(complete).not.toHaveBeenCalled();
  });
  it.each([
    ['Host', 'remote.example'], ['Origin', 'http://other.example'],
    ['X-Forwarded-For', '127.0.0.1'], ['Forwarded', 'for=127.0.0.1'],
    ['Sec-Fetch-Site', 'cross-site'],
  ])('rejects disallowed request header %s', async (name, value) => {
    await post().set(name, value).send({ prompt: 'Hello' }).expect(403);
    expect(complete).not.toHaveBeenCalled();
  });
  it('throttles after ten requests per minute', async () => {
    for (let index = 0; index < 10; index++) await post().send({ prompt: 'Hello' }).expect(200);
    await post().send({ prompt: 'Hello' }).expect(429);
    expect(complete).toHaveBeenCalledTimes(10);
  });
});

describe('Chat loopback and quota window', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  const context = (remoteAddress: string) => ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { host: 'localhost:3000' }, socket: { remoteAddress } }) }),
  }) as ExecutionContext;
  it('rejects a non-loopback socket even with a local Host', () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(() => new ChatGuard().canActivate(context('192.168.1.2'))).toThrow('local-only');
  });
  it('resets the throttle after one minute', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const guard = new ChatGuard();
    for (let index = 0; index < 10; index++) guard.canActivate(context('::1'));
    expect(() => guard.canActivate(context('::1'))).toThrow('limit exceeded');
    now.mockReturnValue(160_000);
    expect(guard.canActivate(context('::1'))).toBe(true);
  });
});

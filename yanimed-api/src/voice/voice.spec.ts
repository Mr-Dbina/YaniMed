import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import {
  type INestApplication,
  type ExecutionContext,
  HttpException,
} from '@nestjs/common';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceModule } from './voice.module.js';
import { VoiceService } from './voice.service.js';
import { VoiceGuard } from './voice.guard.js';
import { MAX_AUDIO_BYTES } from './audio.validation.js';

const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]);
const providerAudio = () =>
  new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });

describe('Voice HTTP endpoints (mocked provider)', () => {
  let app: INestApplication;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-only-placeholder');
    vi.stubEnv('CORS_ORIGINS', 'http://localhost:3001');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const module = await Test.createTestingModule({
      imports: [VoiceModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app?.close();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
  const host = 'localhost:3000';

  it('returns playable MP3 with verified default model and voice', async () => {
    fetchMock.mockResolvedValue(providerAudio());
    const res = await request(app.getHttpServer())
      .post('/voice/synthesize')
      .set('Host', host)
      .send({ text: ' Hello ' })
      .expect(200);
    expect(res.headers['content-type']).toContain('audio/mpeg');
    expect(res.headers['content-length']).toBe(String(mp3.length));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('text-to-speech/CwhRBWXzGAHq8TQ4Fs17');
    expect(JSON.parse(options.body)).toEqual({
      text: 'Hello',
      model_id: 'eleven_flash_v2_5',
    });
  });

  it.each([
    {},
    { text: '' },
    { text: '   ' },
    { text: 42 },
    { text: 'a'.repeat(2001) },
    { text: 'Hi', voiceId: 'unknown' },
    { text: 'Hi', voiceId: null },
    { text: 'Hi', extra: true },
  ])(
    'rejects invalid synthesis input %j without provider use',
    async (body) => {
      await request(app.getHttpServer())
        .post('/voice/synthesize')
        .set('Host', host)
        .send(body)
        .expect(400);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('transcribes an audio upload with scribe_v1', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ text: 'Hello, this is a test.' })),
    );
    const res = await request(app.getHttpServer())
      .post('/voice/transcribe')
      .set('Host', host)
      .attach('file', mp3, {
        filename: 'sample.mp3',
        contentType: 'audio/mpeg',
      })
      .expect(200);
    expect(res.body).toEqual({ text: 'Hello, this is a test.' });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain('/speech-to-text');
    expect(options.body.get('model_id')).toBe('scribe_v1');
    expect(options.body.get('file').size).toBe(mp3.length);
  });

  it('rejects missing audio', async () => {
    await request(app.getHttpServer())
      .post('/voice/transcribe')
      .set('Host', host)
      .expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each([
    [Buffer.alloc(0), 'audio/mpeg'],
    [Buffer.from('not audio'), 'audio/mpeg'],
    [mp3, 'text/plain'],
  ])('rejects empty, spoofed or unsupported uploads', async (buffer, type) => {
    await request(app.getHttpServer())
      .post('/voice/transcribe')
      .set('Host', host)
      .attach('file', buffer, { filename: 'test.mp3', contentType: type })
      .expect(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('rejects oversized audio before provider access', async () => {
    await request(app.getHttpServer())
      .post('/voice/transcribe')
      .set('Host', host)
      .attach('file', Buffer.alloc(MAX_AUDIO_BYTES + 1), {
        filename: 'test.mp3',
        contentType: 'audio/mpeg',
      })
      .expect(413);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [401, 503],
    [403, 503],
    [429, 429],
    [500, 502],
    [422, 400],
  ])(
    'maps provider status %i to %i without forwarding provider details',
    async (status, expected) => {
      fetchMock.mockResolvedValue(
        new Response('sensitive upstream detail', { status }),
      );
      const res = await request(app.getHttpServer())
        .post('/voice/synthesize')
        .set('Host', host)
        .send({ text: 'Hello' })
        .expect(expected);
      expect(JSON.stringify(res.body)).not.toContain(
        'sensitive upstream detail',
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [401, 503],
    [403, 503],
    [429, 429],
    [500, 502],
    [422, 400],
  ])('maps STT provider status %i to %i', async (status, expected) => {
    fetchMock.mockResolvedValue(
      new Response('sensitive upstream detail', { status }),
    );
    const res = await request(app.getHttpServer())
      .post('/voice/transcribe')
      .set('Host', host)
      .attach('file', mp3, { filename: 'test.mp3', contentType: 'audio/mpeg' })
      .expect(expected);
    expect(JSON.stringify(res.body)).not.toContain('sensitive upstream detail');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('blocks production and unapproved browser origins', async () => {
    await request(app.getHttpServer())
      .post('/voice/synthesize')
      .set('Host', host)
      .set('Origin', 'https://untrusted.example')
      .send({ text: 'Hello' })
      .expect(403);
    vi.stubEnv('NODE_ENV', 'production');
    await request(app.getHttpServer())
      .post('/voice/synthesize')
      .set('Host', host)
      .send({ text: 'Hello' })
      .expect(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('limits incoming requests to ten per minute', async () => {
    for (let i = 0; i < 10; i++)
      await request(app.getHttpServer())
        .post('/voice/synthesize')
        .set('Host', host)
        .send({ text: '' })
        .expect(400);
    await request(app.getHttpServer())
      .post('/voice/synthesize')
      .set('Host', host)
      .send({ text: 'Hello' })
      .expect(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('Voice provider transport', () => {
  let service: VoiceService;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-only-placeholder');
    service = new VoiceService();
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('handles absent configuration without provider access', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', '');
    await expect(service.synthesize('Hello')).rejects.toMatchObject({
      status: 503,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('sanitizes network failures', async () => {
    fetchMock.mockRejectedValue(new Error('sensitive transport details'));
    await expect(service.synthesize('Hello')).rejects.toMatchObject({
      status: 502,
      message: 'Voice provider network or response failure.',
    });
  });
  it('enforces the timeout and releases the concurrency slot', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    );
    const result = expect(service.synthesize('Hello')).rejects.toMatchObject({
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await result;
    fetchMock.mockResolvedValue(providerAudio());
    await expect(service.synthesize('Hello')).resolves.toEqual(mp3);
  });
  it('limits concurrent provider requests', async () => {
    let resolve!: (res: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const first = service.synthesize('One');
    const resolveFirst = resolve;
    const second = service.synthesize('Two');
    await expect(service.synthesize('Three')).rejects.toMatchObject({
      status: 429,
    });
    resolveFirst(providerAudio());
    resolve(providerAudio());
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('rejects malformed audio and transcript responses', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { headers: { 'content-type': 'application/json' } }),
    );
    await expect(service.synthesize('Hello')).rejects.toMatchObject({
      status: 502,
    });
    fetchMock.mockResolvedValue(new Response('{}'));
    await expect(
      service.transcribe({
        buffer: mp3,
        mimetype: 'audio/mpeg',
        size: mp3.length,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('Voice local access guard', () => {
  afterEach(() => vi.unstubAllEnvs());
  it.each([
    ['192.0.2.1', {}],
    ['127.0.0.1', { 'x-forwarded-for': '192.0.2.1' }],
    ['127.0.0.1', { host: 'rebound.example' }],
    ['127.0.0.1', { 'sec-fetch-site': 'cross-site' }],
  ])('rejects nonlocal or proxied access', (remoteAddress, headers) => {
    vi.stubEnv('NODE_ENV', 'test');
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          socket: { remoteAddress },
          headers: { host: 'localhost:3000', ...headers },
        }),
      }),
    } as unknown as ExecutionContext;
    expect(() => new VoiceGuard().canActivate(context)).toThrow(HttpException);
  });
});

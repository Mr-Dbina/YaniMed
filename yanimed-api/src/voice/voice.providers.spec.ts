import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceService } from './voice.service.js';
import { validateEnv } from '../config/env.validation.js';
import { VoiceStudioSttProvider } from './providers/voicestudio.provider.js';

const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100)]);
const audioResponse = () =>
  new Response(mp3, { headers: { 'Content-Type': 'audio/mpeg' } });

describe('Voice provider selection', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('defaults to ElevenLabs so existing behaviour is unchanged', async () => {
    vi.stubEnv('ELEVENLABS_API_KEY', 'test-only-placeholder');
    const fetchMock = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal('fetch', fetchMock);
    const service = new VoiceService();
    expect(service.provider).toBe('elevenlabs');
    await service.synthesize('Hello');
    expect(fetchMock.mock.calls[0][0]).toContain('api.elevenlabs.io');
    vi.unstubAllGlobals();
  });

  it('selects VoiceStudio when VOICE_PROVIDER=local', async () => {
    vi.stubEnv('VOICE_PROVIDER', 'local');
    const fetchMock = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal('fetch', fetchMock);
    const service = new VoiceService();
    expect(service.provider).toBe('local');
    await service.synthesize('Hello');
    expect(fetchMock.mock.calls[0][0]).toBe(
      'http://localhost:3900/v1/audio/speech',
    );
    vi.unstubAllGlobals();
  });

  it('ignores the request voice id and uses LOCAL_TTS_VOICE', async () => {
    vi.stubEnv('VOICE_PROVIDER', 'local');
    vi.stubEnv('LOCAL_TTS_VOICE', 'expr-voice-2-f');
    const fetchMock = vi.fn().mockResolvedValue(audioResponse());
    vi.stubGlobal('fetch', fetchMock);
    await new VoiceService().synthesize('Hello', 'CwhRBWXzGAHq8TQ4Fs17');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({
      model: 'kittentts',
      voice: 'expr-voice-2-f',
      input: 'Hello',
      response_format: 'mp3',
    });
    vi.unstubAllGlobals();
  });

  it('rejects an unknown VOICE_PROVIDER at boot', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    vi.stubEnv('VOICE_PROVIDER', 'elevenlabs-cloud');
    expect(() => validateEnv()).toThrow(/Invalid VOICE_PROVIDER/);
  });

  it('rejects a malformed LOCAL_STT_LANGUAGE at boot', () => {
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    vi.stubEnv('LOCAL_STT_LANGUAGE', 'english');
    expect(() => validateEnv()).toThrow(/Invalid LOCAL_STT_LANGUAGE/);
  });
});

describe('VoiceStudio provider', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.stubEnv('VOICE_PROVIDER', 'local');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('returns the MP3 bytes from the local server', async () => {
    fetchMock.mockResolvedValue(audioResponse());
    await expect(new VoiceService().synthesize('Hello')).resolves.toEqual(mp3);
  });

  it('maps a stopped server to 503 with VOICE_PROVIDER_UNAVAILABLE', async () => {
    fetchMock.mockRejectedValue(
      new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }),
    );
    await expect(new VoiceService().synthesize('Hello')).rejects.toMatchObject({
      status: 503,
      response: { code: 'VOICE_PROVIDER_UNAVAILABLE', statusCode: 503 },
    });
  });

  it('times out at LOCAL_TTS_TIMEOUT_MS and frees the only slot', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options.signal.addEventListener('abort', () =>
            reject(new Error('aborted')),
          ),
        ),
    );
    const service = new VoiceService();
    const result = expect(service.synthesize('Hello')).rejects.toMatchObject({
      status: 504,
    });
    await vi.advanceTimersByTimeAsync(150_000);
    await result;
    fetchMock.mockResolvedValue(audioResponse());
    await expect(service.synthesize('Hello')).resolves.toEqual(mp3);
  });

  it('allows one concurrent local call only', async () => {
    let resolve!: (res: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>((r) => {
          resolve = r;
        }),
    );
    const service = new VoiceService();
    const first = service.synthesize('One');
    await expect(service.synthesize('Two')).rejects.toMatchObject({
      status: 429,
    });
    resolve(audioResponse());
    await first;
  });

  it('rejects a non-MP3 local response', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"detail":"boom"}', {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await expect(new VoiceService().synthesize('Hello')).rejects.toMatchObject({
      status: 502,
    });
  });

  it('rejects malformed local transcripts', async () => {
    fetchMock.mockResolvedValue(
      new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    );
    await expect(
      new VoiceService().transcribe({
        buffer: mp3,
        mimetype: 'audio/mpeg',
        size: mp3.length,
      }),
    ).rejects.toMatchObject({ status: 502 });
  });

  it('omits prompt when LOCAL_STT_PROMPT is empty and sends it when set', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ text: 'ok' }))),
    );
    const upload = {
      buffer: mp3,
      mimetype: 'audio/mpeg',
      size: mp3.length,
    };
    await new VoiceService().transcribe(upload);
    expect(fetchMock.mock.calls[0][1].body.get('prompt')).toBeNull();

    vi.stubEnv('LOCAL_STT_PROMPT', 'Amoxicillin, metformin');
    await new VoiceStudioSttProvider().transcribe(upload);
    const form = fetchMock.mock.calls[1][1].body as FormData;
    expect(form.get('prompt')).toBe('Amoxicillin, metformin');
    expect(form.get('model')).toBe('faster-whisper');
  });

  it('rejects bad audio before any local request', async () => {    await expect(
      new VoiceStudioSttProvider().transcribe({
        buffer: Buffer.from('not audio'),
        mimetype: 'audio/mpeg',
        size: 9,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('omits language when LOCAL_STT_LANGUAGE is empty and sends it when set', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ text: 'ok' }))),
    );
    const upload = { buffer: mp3, mimetype: 'audio/mpeg', size: mp3.length };
    await new VoiceStudioSttProvider().transcribe(upload);
    const plain = fetchMock.mock.calls[0][1].body as FormData;
    expect(plain.get('language')).toBeNull();

    vi.stubEnv('LOCAL_STT_LANGUAGE', 'en');
    await new VoiceStudioSttProvider().transcribe(upload);
    const hinted = fetchMock.mock.calls[1][1].body as FormData;
    expect(hinted.get('language')).toBe('en');
  });
});

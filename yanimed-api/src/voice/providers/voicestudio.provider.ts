import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { validateAudio } from '../audio.validation.js';
import type { AudioUpload } from '../audio.validation.js';
import { ProviderSlots, timeoutSignal } from './transport.js';
import type { SpeechToTextProvider, TextToSpeechProvider } from './provider.js';

/** One slot only: VoiceStudio keeps its models resident, and this laptop has
 * roughly 0.5 GB free while it runs. */
const slots = new ProviderSlots(1);

const DEFAULT_BASE_URL = 'http://localhost:3900/v1';

function setting(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback;
}

function timeoutMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]?.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function baseUrl(): string {
  return setting('LOCAL_VOICE_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function unavailable(err: unknown): never {
  if (err instanceof HttpException) throw err;
  throw new ServiceUnavailableException({
    statusCode: 503,
    code: 'VOICE_PROVIDER_UNAVAILABLE',
    message:
      'Local voice provider is unavailable. Start VoiceStudio or set VOICE_PROVIDER=elevenlabs.',
  });
}

function mapStatus(status: number): never {
  if (status === 404 || status === 502 || status === 503)
    unavailable(new Error(`local provider status ${status}`));
  if ([400, 413, 415, 422].includes(status))
    throw new BadRequestException(
      'Local voice provider rejected the text or audio input.',
    );
  throw new BadGatewayException('Local voice provider request failed.');
}

/** Shared transport for both local calls; no fallback to ElevenLabs. */
async function call<T>(
  path: string,
  init: RequestInit,
  timeout: number,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  slots.enter();
  const limit = timeoutSignal(timeout);
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: limit.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      mapStatus(res.status);
    }
    try {
      return await read(res);
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw new BadGatewayException(
        'Local voice provider returned an invalid response.',
      );
    }
  } catch (err) {
    if (err instanceof HttpException) throw err;
    if (limit.timedOut())
      throw new GatewayTimeoutException('Local voice provider timed out.');
    return unavailable(err);
  } finally {
    limit.clear();
    slots.leave();
  }
}

export class VoiceStudioTtsProvider implements TextToSpeechProvider {
  readonly name = 'local' as const;

  async synthesize(text: string): Promise<Buffer> {
    return call(
      '/audio/speech',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          model: setting('LOCAL_TTS_MODEL', 'kittentts'),
          voice: setting('LOCAL_TTS_VOICE', 'expr-voice-2-f'),
          input: text,
          response_format: 'mp3',
        }),
      },
      timeoutMs('LOCAL_TTS_TIMEOUT_MS', 150_000),
      async (res) => {
        if (!res.headers.get('content-type')?.includes('audio/mpeg'))
          throw new BadGatewayException(
            'Local voice provider returned invalid audio.',
          );
        const audio = Buffer.from(await res.arrayBuffer());
        if (!audio.length)
          throw new BadGatewayException(
            'Local voice provider returned empty audio.',
          );
        return audio;
      },
    );
  }
}

export class VoiceStudioSttProvider implements SpeechToTextProvider {
  readonly name = 'local' as const;

  async transcribe(file: AudioUpload): Promise<{ text: string }> {
    const { type, extension } = validateAudio(file);
    const form = new FormData();
    form.set('model', setting('LOCAL_STT_MODEL', 'faster-whisper'));
    form.set('response_format', 'json');
    const prompt = process.env.LOCAL_STT_PROMPT?.trim();
    if (prompt) form.set('prompt', prompt);
    const language = process.env.LOCAL_STT_LANGUAGE?.trim();
    if (language) form.set('language', language);
    form.set(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type }),
      `recording.${extension}`,
    );
    return call(
      '/audio/transcriptions',
      { method: 'POST', body: form },
      timeoutMs('LOCAL_STT_TIMEOUT_MS', 60_000),
      async (res) => {
        const data = (await res.json()) as { text?: unknown };
        if (typeof data.text !== 'string')
          throw new BadGatewayException(
            'Local voice provider returned an invalid transcript.',
          );
        return { text: data.text };
      },
    );
  }
}

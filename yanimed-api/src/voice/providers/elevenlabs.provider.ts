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

const TIMEOUT_MS = 60_000;
const slots = new ProviderSlots(2);

/** Wraps every ElevenLabs call: key check, concurrency slot, timeout, status
 * mapping. Both providers share this shape; only the mapping differs. */
async function request<T>(
  path: string,
  init: RequestInit,
  read: (res: Response) => Promise<T>,
): Promise<T> {
  const key = process.env.ELEVENLABS_API_KEY?.trim();
  if (!key)
    throw new ServiceUnavailableException('Voice provider is not configured.');
  slots.enter();
  const timeout = timeoutSignal(TIMEOUT_MS);
  try {
    const headers = new Headers(init.headers);
    headers.set('xi-api-key', key);
    const res = await fetch(`https://api.elevenlabs.io/v1/${path}`, {
      ...init,
      headers,
      signal: timeout.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status === 401)
        throw new ServiceUnavailableException(
          'Voice provider authentication or permissions failed.',
        );
      if (res.status === 403)
        throw new ServiceUnavailableException(
          'Voice provider access denied.',
        );
      if (res.status === 429)
        throw new HttpException(
          'Voice provider quota or rate limit reached.',
          429,
        );
      if ([400, 413, 415, 422].includes(res.status))
        throw new BadRequestException(
          'Voice provider rejected the text or audio input.',
        );
      throw new BadGatewayException('Voice provider request failed.');
    }
    return await read(res);
  } catch (err) {
    if (err instanceof HttpException) throw err;
    if (timeout.timedOut())
      throw new GatewayTimeoutException('Voice provider timed out.');
    throw new BadGatewayException(
      'Voice provider network or response failure.',
    );
  } finally {
    timeout.clear();
    slots.leave();
  }
}

export class ElevenLabsTtsProvider implements TextToSpeechProvider {
  readonly name = 'elevenlabs' as const;

  async synthesize(text: string, voiceId: string): Promise<Buffer> {
    return request(
      `text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5' }),
      },
      async (res) => {
        if (!res.headers.get('content-type')?.includes('audio/mpeg'))
          throw new BadGatewayException(
            'Voice provider returned invalid audio.',
          );
        const audio = Buffer.from(await res.arrayBuffer());
        if (!audio.length)
          throw new BadGatewayException('Voice provider returned empty audio.');
        return audio;
      },
    );
  }
}

export class ElevenLabsSttProvider implements SpeechToTextProvider {
  readonly name = 'elevenlabs' as const;

  async transcribe(file: AudioUpload): Promise<{ text: string }> {
    const { type, extension } = validateAudio(file);
    const form = new FormData();
    form.set('model_id', 'scribe_v1');
    form.set(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type }),
      `recording.${extension}`,
    );
    return request('speech-to-text', { method: 'POST', body: form }, async (res) => {
      const data = (await res.json()) as { text?: unknown };
      if (typeof data.text !== 'string')
        throw new BadGatewayException(
          'Voice provider returned an invalid transcript.',
        );
      return { text: data.text };
    });
  }
}

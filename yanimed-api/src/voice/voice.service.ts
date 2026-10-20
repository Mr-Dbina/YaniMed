import {
  BadGatewayException,
  BadRequestException,
  GatewayTimeoutException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ROGER_VOICE_ID } from './synthesize.dto.js';
import { validateAudio } from './audio.validation.js';
import type { AudioUpload } from './audio.validation.js';

@Injectable()
export class VoiceService {
  private active = 0;

  private async request<T>(
    path: string,
    init: RequestInit,
    read: (res: Response) => Promise<T>,
  ): Promise<T> {
    const key = process.env.ELEVENLABS_API_KEY?.trim();
    if (!key)
      throw new ServiceUnavailableException(
        'Voice provider is not configured.',
      );
    if (this.active >= 2)
      throw new HttpException('Voice service is busy. Retry shortly.', 429);
    this.active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const headers = new Headers(init.headers);
      headers.set('xi-api-key', key);
      const res = await fetch(`https://api.elevenlabs.io/v1/${path}`, {
        ...init,
        headers,
        signal: controller.signal,
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
      if (controller.signal.aborted)
        throw new GatewayTimeoutException('Voice provider timed out.');
      throw new BadGatewayException(
        'Voice provider network or response failure.',
      );
    } finally {
      clearTimeout(timer);
      this.active--;
    }
  }

  async synthesize(text: string, voiceId = ROGER_VOICE_ID): Promise<Buffer> {
    return this.request(
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

  async transcribe(file: AudioUpload): Promise<{ text: string }> {
    const { type, extension } = validateAudio(file);
    const form = new FormData();
    form.set('model_id', 'scribe_v1');
    form.set(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type }),
      `recording.${extension}`,
    );
    return this.request(
      'speech-to-text',
      { method: 'POST', body: form },
      async (res) => {
        const data = (await res.json()) as { text?: unknown };
        if (typeof data.text !== 'string')
          throw new BadGatewayException(
            'Voice provider returned an invalid transcript.',
          );
        return { text: data.text };
      },
    );
  }
}

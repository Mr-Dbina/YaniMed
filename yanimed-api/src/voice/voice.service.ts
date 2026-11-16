import { Injectable } from '@nestjs/common';
import { ROGER_VOICE_ID } from './synthesize.dto.js';
import type { AudioUpload } from './audio.validation.js';
import type {
  SpeechToTextProvider,
  TextToSpeechProvider,
} from './providers/provider.js';
import {
  ElevenLabsSttProvider,
  ElevenLabsTtsProvider,
} from './providers/elevenlabs.provider.js';
import {
  VoiceStudioSttProvider,
  VoiceStudioTtsProvider,
} from './providers/voicestudio.provider.js';

/**
 * Provider selection is fixed when the module is created, so a request can
 * never half-switch providers. VOICE_PROVIDER defaults to elevenlabs, which
 * keeps the original behaviour until the flag is flipped.
 */
@Injectable()
export class VoiceService {
  private readonly tts: TextToSpeechProvider;
  private readonly stt: SpeechToTextProvider;

  constructor() {
    const local = process.env.VOICE_PROVIDER?.trim().toLowerCase() === 'local';
    this.tts = local ? new VoiceStudioTtsProvider() : new ElevenLabsTtsProvider();
    this.stt = local ? new VoiceStudioSttProvider() : new ElevenLabsSttProvider();
  }

  get provider(): string {
    return this.tts.name;
  }

  synthesize(text: string, voiceId = ROGER_VOICE_ID): Promise<Buffer> {
    return this.tts.synthesize(text, voiceId);
  }

  transcribe(file: AudioUpload): Promise<{ text: string }> {
    return this.stt.transcribe(file);
  }
}

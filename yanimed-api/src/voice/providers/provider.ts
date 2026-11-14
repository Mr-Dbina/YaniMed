import type { AudioUpload } from '../audio.validation.js';

export type VoiceProviderName = 'elevenlabs' | 'local';

/**
 * Text-to-speech returns the encoded audio bytes only; the controller owns the
 * response content type so it stays `audio/mpeg` for both providers.
 */
export interface TextToSpeechProvider {
  readonly name: VoiceProviderName;
  synthesize(text: string, voiceId: string): Promise<Buffer>;
}

export interface SpeechToTextProvider {
  readonly name: VoiceProviderName;
  transcribe(file: AudioUpload): Promise<{ text: string }>;
}

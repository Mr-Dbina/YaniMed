import { HttpException } from '@nestjs/common';

/**
 * Concurrency gate. The cap is per provider: ElevenLabs tolerates two parallel
 * calls, while the local VoiceStudio process holds its models in RAM on a 7 GB
 * laptop, so it only gets one.
 */
export class ProviderSlots {
  private active = 0;

  constructor(private readonly cap: number) {}

  enter(): void {
    if (this.active >= this.cap)
      throw new HttpException('Voice service is busy. Retry shortly.', 429);
    this.active++;
  }

  leave(): void {
    this.active--;
  }
}

/** Abort controller plus the timer that fires it, so a caller can tell a
 * timeout apart from every other transport failure. */
export function timeoutSignal(ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    timedOut: () => controller.signal.aborted,
    clear: () => clearTimeout(timer),
  };
}

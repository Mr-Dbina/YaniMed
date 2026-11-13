import {
  BREAKER_COOLDOWN_MS,
  BREAKER_FAILURE_THRESHOLD,
} from '../generation.constants.js';

export type CircuitBreakerState = 'closed' | 'open' | 'half-open';

export type CircuitGate =
  | { allowed: true; probe: boolean }
  | { allowed: false; retryInMs: number };

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

/**
 * Per-process breaker. Five consecutive failures open it for a cooldown, then
 * exactly one probe call is let through. The clock is injected so tests can
 * drive the cooldown without sleeping.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private consecutiveFailures = 0;
  private openedUntil = 0;
  private probeInFlight = false;

  constructor(
    private readonly now: () => number = Date.now,
    options: CircuitBreakerOptions = {},
  ) {
    this.failureThreshold =
      options.failureThreshold ?? BREAKER_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? BREAKER_COOLDOWN_MS;
  }

  /** Claims permission to call. A granted half-open gate must be released. */
  gate(): CircuitGate {
    if (this.openedUntil === 0) return { allowed: true, probe: false };

    const retryInMs = this.openedUntil - this.now();
    if (retryInMs > 0) return { allowed: false, retryInMs };
    if (this.probeInFlight) return { allowed: false, retryInMs: 0 };

    this.probeInFlight = true;
    return { allowed: true, probe: true };
  }

  /** Gives a granted probe back without recording an outcome. */
  releaseProbe(): void {
    this.probeInFlight = false;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.openedUntil = 0;
    this.probeInFlight = false;
  }

  recordFailure(): void {
    const wasProbe = this.probeInFlight;
    this.probeInFlight = false;

    // A failed probe (or a failure while open) restarts the cooldown.
    if (this.openedUntil !== 0 || wasProbe) {
      this.consecutiveFailures = 0;
      this.openedUntil = this.now() + this.cooldownMs;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.consecutiveFailures = 0;
      this.openedUntil = this.now() + this.cooldownMs;
    }
  }

  state(): CircuitBreakerState {
    if (this.openedUntil === 0) return 'closed';
    return this.now() < this.openedUntil ? 'open' : 'half-open';
  }
}

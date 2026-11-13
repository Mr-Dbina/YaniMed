import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function openBreaker(breaker: CircuitBreaker): void {
  for (let index = 0; index < 5; index += 1) {
    expect(breaker.gate().allowed).toBe(true);
    breaker.recordFailure();
  }
}

describe('CircuitBreaker', () => {
  it('stays closed below the failure threshold', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker(clock.now);

    for (let index = 0; index < 4; index += 1) {
      expect(breaker.gate()).toEqual({ allowed: true, probe: false });
      breaker.recordFailure();
    }

    expect(breaker.state()).toBe('closed');
    expect(breaker.gate()).toEqual({ allowed: true, probe: false });
  });

  it('opens after five consecutive failures and fails fast', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker(clock.now);

    openBreaker(breaker);

    expect(breaker.state()).toBe('open');
    expect(breaker.gate()).toEqual({ allowed: false, retryInMs: 60_000 });

    clock.advance(59_999);
    expect(breaker.gate().allowed).toBe(false);
  });

  it('resets the consecutive count on success', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker(clock.now);

    for (let index = 0; index < 4; index += 1) breaker.recordFailure();
    breaker.recordSuccess();
    for (let index = 0; index < 4; index += 1) breaker.recordFailure();

    expect(breaker.state()).toBe('closed');
  });

  it('lets exactly one probe through after the cooldown', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker(clock.now);

    openBreaker(breaker);
    clock.advance(60_000);

    expect(breaker.state()).toBe('half-open');
    expect(breaker.gate()).toEqual({ allowed: true, probe: true });
    expect(breaker.gate()).toEqual({ allowed: false, retryInMs: 0 });
  });

  it('closes when the probe succeeds', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker(clock.now);

    openBreaker(breaker);
    clock.advance(60_000);
    expect(breaker.gate()).toEqual({ allowed: true, probe: true });

    breaker.recordSuccess();

    expect(breaker.state()).toBe('closed');
    expect(breaker.gate()).toEqual({ allowed: true, probe: false });
  });

  it('reopens for a full cooldown when the probe fails', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker(clock.now);

    openBreaker(breaker);
    clock.advance(60_000);
    breaker.gate();
    breaker.recordFailure();

    expect(breaker.state()).toBe('open');
    clock.advance(59_999);
    expect(breaker.gate().allowed).toBe(false);
    clock.advance(1);
    expect(breaker.gate()).toEqual({ allowed: true, probe: true });
  });

  it('gives a granted probe back when the attempt never happens', () => {
    const clock = fakeClock();
    const breaker = new CircuitBreaker(clock.now);

    openBreaker(breaker);
    clock.advance(60_000);
    expect(breaker.gate()).toEqual({ allowed: true, probe: true });

    breaker.releaseProbe();

    expect(breaker.gate()).toEqual({ allowed: true, probe: true });
  });
});

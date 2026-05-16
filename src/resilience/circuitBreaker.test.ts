import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError, type CircuitState } from './circuitBreaker.js';

function makeBreaker(nowRef: { t: number }, overrides: Partial<ConstructorParameters<typeof CircuitBreaker>[0]> = {}) {
  const transitions: Array<[CircuitState, CircuitState]> = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    successThreshold: 2,
    openDurationMs: 1_000,
    halfOpenMaxConcurrent: 1,
    now: () => nowRef.t,
    onStateChange: (from, to) => transitions.push([from, to]),
    ...overrides,
  });
  return { breaker, transitions };
}

const ok = () => Promise.resolve('ok');
const boom = () => Promise.reject(new Error('boom'));

describe('CircuitBreaker', () => {
  it('stays closed under the failure threshold and resets on success', async () => {
    const now = { t: 0 };
    const { breaker } = makeBreaker(now);
    await expect(breaker.execute(boom)).rejects.toThrow('boom');
    await expect(breaker.execute(boom)).rejects.toThrow('boom');
    await breaker.execute(ok); // resets the consecutive-failure counter
    await expect(breaker.execute(boom)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('closed');
  });

  it('opens after consecutive failures and sheds calls with retry-after', async () => {
    const now = { t: 0 };
    const { breaker, transitions } = makeBreaker(now);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(boom)).rejects.toThrow('boom');
    }
    expect(breaker.getState()).toBe('open');
    expect(transitions).toContainEqual(['closed', 'open']);

    now.t = 400;
    const err = await breaker.execute(ok).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect((err as CircuitOpenError).retryAfterMs).toBe(600);
  });

  it('half-opens after the cooldown and closes after enough probe successes', async () => {
    const now = { t: 0 };
    const { breaker, transitions } = makeBreaker(now);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(boom)).rejects.toThrow('boom');
    }
    now.t = 1_001;
    expect(breaker.getState()).toBe('half-open');
    await breaker.execute(ok);
    expect(breaker.getState()).toBe('half-open');
    await breaker.execute(ok);
    expect(breaker.getState()).toBe('closed');
    expect(transitions).toContainEqual(['open', 'half-open']);
    expect(transitions).toContainEqual(['half-open', 'closed']);
  });

  it('re-opens immediately on a half-open probe failure', async () => {
    const now = { t: 0 };
    const { breaker } = makeBreaker(now);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(boom)).rejects.toThrow('boom');
    }
    now.t = 1_001;
    await expect(breaker.execute(boom)).rejects.toThrow('boom');
    expect(breaker.getState()).toBe('open');
  });

  it('limits concurrent half-open probes', async () => {
    const now = { t: 0 };
    const { breaker } = makeBreaker(now);
    for (let i = 0; i < 3; i += 1) {
      await expect(breaker.execute(boom)).rejects.toThrow('boom');
    }
    now.t = 1_001;

    let release!: () => void;
    const gate = new Promise<string>((resolve) => {
      release = () => resolve('ok');
    });
    const inFlight = breaker.execute(() => gate); // occupies the single probe slot
    await expect(breaker.execute(ok)).rejects.toBeInstanceOf(CircuitOpenError);
    release();
    await inFlight;
  });
});

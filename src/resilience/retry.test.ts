import { describe, expect, it } from 'vitest';
import { backoffDelay, withRetry, withTimeout, TimeoutError } from './retry.js';

describe('backoffDelay', () => {
  it('doubles per attempt without jitter', () => {
    expect(backoffDelay(1, 100, 10_000, false)).toBe(100);
    expect(backoffDelay(2, 100, 10_000, false)).toBe(200);
    expect(backoffDelay(4, 100, 10_000, false)).toBe(800);
  });

  it('caps at maxDelayMs', () => {
    expect(backoffDelay(10, 100, 1_500, false)).toBe(1_500);
  });

  it('full jitter samples within [0, exp)', () => {
    expect(backoffDelay(3, 100, 10_000, true, () => 0.5)).toBe(200);
    expect(backoffDelay(3, 100, 10_000, true, () => 0)).toBe(0);
  });
});

describe('withRetry', () => {
  const instant = () => Promise.resolve();

  it('returns the first success without retrying', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        return Promise.resolve(42);
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: false, sleep: instant }
    );
    expect(result).toBe(42);
    expect(calls).toBe(1);
  });

  it('retries transient failures up to maxAttempts', async () => {
    let calls = 0;
    const result = await withRetry(
      () => {
        calls += 1;
        return calls < 3 ? Promise.reject(new Error('flaky')) : Promise.resolve('done');
      },
      { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: false, sleep: instant }
    );
    expect(result).toBe('done');
    expect(calls).toBe(3);
  });

  it('throws the last error once attempts are exhausted', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error(`fail ${calls}`));
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 10, jitter: false, sleep: instant }
      )
    ).rejects.toThrow('fail 3');
  });

  it('respects isRetryable to fail fast on permanent errors', async () => {
    let calls = 0;
    await expect(
      withRetry(
        () => {
          calls += 1;
          return Promise.reject(new Error('permanent'));
        },
        {
          maxAttempts: 5,
          baseDelayMs: 1,
          maxDelayMs: 10,
          jitter: false,
          sleep: instant,
          isRetryable: () => false,
        }
      )
    ).rejects.toThrow('permanent');
    expect(calls).toBe(1);
  });

  it('reports each retry through onRetry', async () => {
    const seen: number[] = [];
    await withRetry(
      (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls < 3 ? Promise.reject(new Error('x')) : Promise.resolve(1);
        };
      })(),
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        jitter: false,
        sleep: instant,
        onRetry: (attempt, delayMs) => seen.push(attempt, delayMs),
      }
    );
    expect(seen).toEqual([1, 100, 2, 200]);
  });
});

describe('withTimeout', () => {
  it('resolves when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('fast'), 1_000)).resolves.toBe('fast');
  });

  it('rejects with TimeoutError when the deadline passes', async () => {
    const never = new Promise(() => undefined);
    await expect(withTimeout(never, 10)).rejects.toBeInstanceOf(TimeoutError);
  });
});

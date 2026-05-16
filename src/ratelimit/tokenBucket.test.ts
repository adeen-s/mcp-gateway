import { describe, expect, it } from 'vitest';
import { refill, tryConsume, type BucketSpec } from './tokenBucket.js';

const spec: BucketSpec = { capacity: 10, refillPerSec: 2 };

describe('refill', () => {
  it('adds tokens proportionally to elapsed time', () => {
    const state = refill({ tokens: 0, updatedAtMs: 0 }, spec, 2_500);
    expect(state.tokens).toBe(5); // 2.5s * 2/s
    expect(state.updatedAtMs).toBe(2_500);
  });

  it('never exceeds capacity', () => {
    const state = refill({ tokens: 9, updatedAtMs: 0 }, spec, 60_000);
    expect(state.tokens).toBe(10);
  });

  it('tolerates clock skew (now before updatedAt)', () => {
    const state = refill({ tokens: 3, updatedAtMs: 10_000 }, spec, 5_000);
    expect(state.tokens).toBe(3);
  });
});

describe('tryConsume', () => {
  it('starts a fresh bucket at full capacity', () => {
    const out = tryConsume(undefined, spec, 1, 0);
    expect(out.allowed).toBe(true);
    expect(out.state.tokens).toBe(9);
  });

  it('allows bursts up to capacity then rejects', () => {
    let state;
    for (let i = 0; i < 10; i += 1) {
      const out = tryConsume(state, spec, 1, 0);
      expect(out.allowed).toBe(true);
      state = out.state;
    }
    const rejected = tryConsume(state, spec, 1, 0);
    expect(rejected.allowed).toBe(false);
  });

  it('reports an accurate retry-after for the deficit', () => {
    const drained = tryConsume(undefined, spec, 10, 0); // empty the bucket
    const rejected = tryConsume(drained.state, spec, 4, 0);
    expect(rejected.allowed).toBe(false);
    // 4 tokens at 2/s -> 2000ms
    expect(rejected.retryAfterMs).toBe(2_000);
  });

  it('recovers exactly at the sustained rate', () => {
    const drained = tryConsume(undefined, spec, 10, 0);
    // After 500ms one token has refilled.
    const after = tryConsume(drained.state, spec, 1, 500);
    expect(after.allowed).toBe(true);
    expect(after.state.tokens).toBeCloseTo(0, 5);
  });

  it('does not mutate the previous state (pure function)', () => {
    const prev = { tokens: 5, updatedAtMs: 0 };
    tryConsume(prev, spec, 3, 1_000);
    expect(prev).toEqual({ tokens: 5, updatedAtMs: 0 });
  });
});

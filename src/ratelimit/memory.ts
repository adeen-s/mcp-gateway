import type { BucketSpec, BucketState } from './tokenBucket.js';
import { tryConsume } from './tokenBucket.js';
import type { ConsumeResult, RateLimitStore } from './store.js';

/**
 * In-process token buckets. The default for development and tests, and the
 * automatic fallback when no Redis is configured. Not suitable for
 * multi-replica deployments (each replica gets its own buckets).
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, BucketState>();
  private counters = new Map<string, { value: number; expiresAtMs: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  consume(key: string, spec: BucketSpec, cost = 1): Promise<ConsumeResult> {
    const outcome = tryConsume(this.buckets.get(key), spec, cost, this.now());
    this.buckets.set(key, outcome.state);
    return Promise.resolve({
      allowed: outcome.allowed,
      remaining: Math.floor(outcome.state.tokens),
      retryAfterMs: outcome.retryAfterMs,
    });
  }

  incrementCounter(key: string, ttlSeconds: number): Promise<number> {
    const nowMs = this.now();
    const existing = this.counters.get(key);
    if (!existing || existing.expiresAtMs <= nowMs) {
      this.counters.set(key, { value: 1, expiresAtMs: nowMs + ttlSeconds * 1000 });
      return Promise.resolve(1);
    }
    existing.value += 1;
    return Promise.resolve(existing.value);
  }

  close(): Promise<void> {
    this.buckets.clear();
    this.counters.clear();
    return Promise.resolve();
  }
}

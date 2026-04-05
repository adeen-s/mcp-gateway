import type { BucketSpec } from './tokenBucket.js';

export interface ConsumeResult {
  allowed: boolean;
  /** Tokens left after this call (floored). */
  remaining: number;
  /** When rejected: suggested wait before retrying. */
  retryAfterMs: number;
}

/** Backend-agnostic storage for token buckets and quota counters. */
export interface RateLimitStore {
  /** Atomically refill + consume `cost` tokens from the bucket at `key`. */
  consume(key: string, spec: BucketSpec, cost?: number): Promise<ConsumeResult>;
  /**
   * Atomically increment a counter that expires after `ttlSeconds`; returns
   * the post-increment value. Used for daily quotas.
   */
  incrementCounter(key: string, ttlSeconds: number): Promise<number>;
  close(): Promise<void>;
}

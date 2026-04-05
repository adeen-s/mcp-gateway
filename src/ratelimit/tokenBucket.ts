/** Pure token-bucket math, shared by the memory and Redis backends. */

export interface BucketSpec {
  /** Max tokens the bucket holds (burst size). */
  capacity: number;
  /** Sustained refill rate in tokens per second. */
  refillPerSec: number;
}

export interface BucketState {
  tokens: number;
  updatedAtMs: number;
}

export interface ConsumeOutcome {
  allowed: boolean;
  state: BucketState;
  /** When rejected: how long until `cost` tokens will be available. */
  retryAfterMs: number;
}

export function refill(state: BucketState, spec: BucketSpec, nowMs: number): BucketState {
  const elapsedMs = Math.max(0, nowMs - state.updatedAtMs);
  const tokens = Math.min(spec.capacity, state.tokens + (elapsedMs / 1000) * spec.refillPerSec);
  return { tokens, updatedAtMs: nowMs };
}

export function tryConsume(
  state: BucketState | undefined,
  spec: BucketSpec,
  cost: number,
  nowMs: number
): ConsumeOutcome {
  const current = refill(state ?? { tokens: spec.capacity, updatedAtMs: nowMs }, spec, nowMs);
  if (current.tokens >= cost) {
    return {
      allowed: true,
      state: { tokens: current.tokens - cost, updatedAtMs: nowMs },
      retryAfterMs: 0,
    };
  }
  const deficit = cost - current.tokens;
  return {
    allowed: false,
    state: current,
    retryAfterMs: Math.ceil((deficit / spec.refillPerSec) * 1000),
  };
}

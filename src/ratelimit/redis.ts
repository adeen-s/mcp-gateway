import { Redis } from 'ioredis';
import type { BucketSpec } from './tokenBucket.js';
import type { ConsumeResult, RateLimitStore } from './store.js';

/**
 * Atomic token bucket implemented as a Redis Lua script so refill + consume
 * cannot race across gateway replicas.
 */
const CONSUME_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_per_sec = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now_ms = tonumber(ARGV[4])

local data = redis.call('HMGET', key, 'tokens', 'updated')
local tokens = tonumber(data[1])
local updated = tonumber(data[2])
if tokens == nil or updated == nil then
  tokens = capacity
  updated = now_ms
end

local elapsed_sec = math.max(0, now_ms - updated) / 1000
tokens = math.min(capacity, tokens + elapsed_sec * refill_per_sec)

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / refill_per_sec * 1000)
end

redis.call('HSET', key, 'tokens', tokens, 'updated', now_ms)
-- Expire idle buckets after they would have fully refilled twice over.
redis.call('PEXPIRE', key, math.ceil(capacity / refill_per_sec * 2000))

return {allowed, tostring(tokens), retry_ms}
`;

const INCR_LUA = `
local value = redis.call('INCR', KEYS[1])
if value == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return value
`;

export class RedisRateLimitStore implements RateLimitStore {
  private readonly redis: Redis;

  constructor(url: string, private readonly keyPrefix = 'mcpgw:') {
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async consume(key: string, spec: BucketSpec, cost = 1): Promise<ConsumeResult> {
    const result = (await this.redis.eval(
      CONSUME_LUA,
      1,
      `${this.keyPrefix}rl:${key}`,
      spec.capacity,
      spec.refillPerSec,
      cost,
      Date.now()
    )) as [number, string, number];
    return {
      allowed: result[0] === 1,
      remaining: Math.floor(Number(result[1])),
      retryAfterMs: Number(result[2]),
    };
  }

  async incrementCounter(key: string, ttlSeconds: number): Promise<number> {
    const value = (await this.redis.eval(
      INCR_LUA,
      1,
      `${this.keyPrefix}ctr:${key}`,
      ttlSeconds
    )) as number;
    return Number(value);
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

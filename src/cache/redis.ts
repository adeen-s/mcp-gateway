import { Redis } from 'ioredis';
import type { CacheStore } from './store.js';

export class RedisCacheStore implements CacheStore {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(url: string, keyPrefix = 'mcpgw:') {
    this.prefix = `${keyPrefix}cache:`;
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  async get(key: string): Promise<string | undefined> {
    const value = await this.redis.get(this.prefix + key);
    return value ?? undefined;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(this.prefix + key, value, 'EX', ttlSeconds);
  }

  async delete(key: string): Promise<void> {
    await this.redis.del(this.prefix + key);
  }

  async deleteByPrefix(prefix: string): Promise<number> {
    return this.scanAndDelete(this.prefix + prefix + '*');
  }

  async clear(): Promise<number> {
    return this.scanAndDelete(this.prefix + '*');
  }

  private async scanAndDelete(pattern: string): Promise<number> {
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length > 0) {
        removed += await this.redis.del(...keys);
      }
    } while (cursor !== '0');
    return removed;
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }
}

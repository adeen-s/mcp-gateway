/** Backend-agnostic key/value store with TTL and prefix invalidation. */
export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  /** Delete every key starting with `prefix`; returns how many were removed. */
  deleteByPrefix(prefix: string): Promise<number>;
  clear(): Promise<number>;
  close(): Promise<void>;
}

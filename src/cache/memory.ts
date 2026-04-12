import type { CacheStore } from './store.js';

interface Entry {
  value: string;
  expiresAtMs: number;
}

/**
 * In-process TTL cache with a hard entry cap. Eviction is oldest-insertion
 * first (Map preserves insertion order), which is close enough to LRU for a
 * result cache whose entries are short-lived anyway.
 */
export class MemoryCacheStore implements CacheStore {
  private entries = new Map<string, Entry>();

  constructor(
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): Promise<string | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve(undefined);
    if (entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(entry.value);
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    // Re-insert to refresh ordering.
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAtMs: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  deleteByPrefix(prefix: string): Promise<number> {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return Promise.resolve(removed);
  }

  clear(): Promise<number> {
    const n = this.entries.size;
    this.entries.clear();
    return Promise.resolve(n);
  }

  close(): Promise<void> {
    this.entries.clear();
    return Promise.resolve();
  }
}

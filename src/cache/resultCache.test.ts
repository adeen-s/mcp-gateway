import { describe, expect, it } from 'vitest';
import { cacheSchema } from '../config/schema.js';
import { silentLogger } from '../observability/logger.js';
import { MemoryCacheStore } from './memory.js';
import { buildCacheKey, canonicalJson, ResultCache } from './resultCache.js';

const okResult = (text: string) => ({ content: [{ type: 'text' as const, text }] });

function makeCache(config: Record<string, unknown>, now?: () => number) {
  const store = new MemoryCacheStore(100, now);
  const cache = new ResultCache(store, cacheSchema.parse(config), silentLogger());
  return { store, cache };
}

describe('canonicalJson', () => {
  it('sorts keys so logically equal objects hash equally', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('drops undefined values and handles nesting', () => {
    expect(canonicalJson({ a: { y: 1, x: [1, 2] }, skip: undefined })).toBe(
      '{"a":{"x":[1,2],"y":1}}'
    );
  });
});

describe('buildCacheKey', () => {
  it('is stable across argument key order', () => {
    expect(buildCacheKey('echo__say', { a: 1, b: 2 })).toBe(
      buildCacheKey('echo__say', { b: 2, a: 1 })
    );
  });

  it('differs across tools and across arguments', () => {
    expect(buildCacheKey('a__t', { x: 1 })).not.toBe(buildCacheKey('b__t', { x: 1 }));
    expect(buildCacheKey('a__t', { x: 1 })).not.toBe(buildCacheKey('a__t', { x: 2 }));
  });
});

describe('ResultCache', () => {
  it('only caches tools matching the configured globs', async () => {
    const { cache } = makeCache({ enabled: true, ttlSeconds: 60, tools: ['search__*'] });
    expect(cache.isCacheable('search__web')).toBe(true);
    expect(cache.isCacheable('github__create_issue')).toBe(false);

    await cache.put('github__create_issue', {}, okResult('nope'));
    expect(await cache.get('github__create_issue', {})).toBeUndefined();
  });

  it('round-trips results for cacheable tools', async () => {
    const { cache } = makeCache({ enabled: true, ttlSeconds: 60, tools: ['search__*'] });
    await cache.put('search__web', { q: 'mcp' }, okResult('hit'));
    expect(await cache.get('search__web', { q: 'mcp' })).toEqual(okResult('hit'));
    expect(await cache.get('search__web', { q: 'other' })).toBeUndefined();
  });

  it('never caches error results', async () => {
    const { cache } = makeCache({ enabled: true, ttlSeconds: 60, tools: ['*'] });
    await cache.put('search__web', {}, { ...okResult('bad'), isError: true });
    expect(await cache.get('search__web', {})).toBeUndefined();
  });

  it('expires entries after the TTL', async () => {
    let t = 0;
    const { cache } = makeCache({ enabled: true, ttlSeconds: 30, tools: ['*'] }, () => t);
    await cache.put('search__web', {}, okResult('hit'));
    t = 29_000;
    expect(await cache.get('search__web', {})).toEqual(okResult('hit'));
    t = 31_000;
    expect(await cache.get('search__web', {})).toBeUndefined();
  });

  it('invalidates by exact tool, by prefix glob, and entirely', async () => {
    const { cache } = makeCache({ enabled: true, ttlSeconds: 60, tools: ['*'] });
    await cache.put('search__web', { q: 1 }, okResult('a'));
    await cache.put('search__news', { q: 2 }, okResult('b'));
    await cache.put('echo__say', { q: 3 }, okResult('c'));

    await cache.invalidate('search__web');
    expect(await cache.get('search__web', { q: 1 })).toBeUndefined();
    expect(await cache.get('search__news', { q: 2 })).toEqual(okResult('b'));

    await cache.invalidate('search__*');
    expect(await cache.get('search__news', { q: 2 })).toBeUndefined();
    expect(await cache.get('echo__say', { q: 3 })).toEqual(okResult('c'));

    await cache.invalidate();
    expect(await cache.get('echo__say', { q: 3 })).toBeUndefined();
  });

  it('stays disabled when config says so', async () => {
    const { cache } = makeCache({ enabled: false, tools: ['*'] });
    await cache.put('search__web', {}, okResult('x'));
    expect(await cache.get('search__web', {})).toBeUndefined();
  });
});

import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { CacheConfig } from '../config/schema.js';
import { GlobList } from '../rbac/glob.js';
import type { Logger } from '../observability/logger.js';
import type { CacheStore } from './store.js';

/** Stable JSON stringify (sorted keys) so logically equal args hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Cache keys are namespaced by tool so invalidation hooks can target a tool
 * (or tool glob) without flushing everything. Results are tenant-agnostic:
 * RBAC runs before the cache, and a tool call with identical arguments is
 * the same computation regardless of which tenant asked.
 */
export function buildCacheKey(tool: string, args: Record<string, unknown> | undefined): string {
  const hash = createHash('sha256').update(canonicalJson(args ?? {})).digest('hex').slice(0, 32);
  return `tool:${tool}:${hash}`;
}

export interface CacheEvents {
  onHit?: (tool: string) => void;
  onMiss?: (tool: string) => void;
}

/**
 * Opt-in result cache for idempotent tool calls. Only tools matching the
 * configured glob list are ever cached; everything else passes straight
 * through. Failed tool results (isError) are never cached.
 */
export class ResultCache {
  private cacheableTools: GlobList;

  constructor(
    private readonly store: CacheStore,
    private config: CacheConfig,
    private readonly logger: Logger,
    private readonly events: CacheEvents = {}
  ) {
    this.cacheableTools = new GlobList(config.tools);
  }

  reconfigure(config: CacheConfig): void {
    this.config = config;
    this.cacheableTools = new GlobList(config.tools);
  }

  isCacheable(tool: string): boolean {
    return this.config.enabled && this.cacheableTools.matches(tool);
  }

  async get(tool: string, args: Record<string, unknown> | undefined): Promise<CallToolResult | undefined> {
    if (!this.isCacheable(tool)) return undefined;
    try {
      const raw = await this.store.get(buildCacheKey(tool, args));
      if (raw === undefined) {
        this.events.onMiss?.(tool);
        return undefined;
      }
      this.events.onHit?.(tool);
      return JSON.parse(raw) as CallToolResult;
    } catch (err) {
      // A broken cache must never break the request path.
      this.logger.warn({ tool, err: (err as Error).message }, 'cache read failed');
      return undefined;
    }
  }

  async put(
    tool: string,
    args: Record<string, unknown> | undefined,
    result: CallToolResult
  ): Promise<void> {
    if (!this.isCacheable(tool) || result.isError) return;
    try {
      await this.store.set(buildCacheKey(tool, args), JSON.stringify(result), this.config.ttlSeconds);
    } catch (err) {
      this.logger.warn({ tool, err: (err as Error).message }, 'cache write failed');
    }
  }

  /**
   * Explicit invalidation hook. With no argument the whole result cache is
   * flushed; with a tool name (exact, or prefix ending in `*`) only matching
   * entries go.
   */
  async invalidate(tool?: string): Promise<number> {
    if (!tool || tool === '*') {
      return this.store.clear();
    }
    const prefix = tool.endsWith('*') ? `tool:${tool.slice(0, -1)}` : `tool:${tool}:`;
    return this.store.deleteByPrefix(prefix);
  }
}

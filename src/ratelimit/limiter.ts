import type { TenantConfig, BucketConfig } from '../config/schema.js';
import { GatewayError } from '../types.js';
import { GlobList } from '../rbac/glob.js';
import type { RateLimitStore } from './store.js';

const DAY_SECONDS = 86_400;

interface CompiledLimits {
  requests?: BucketConfig;
  perTool: { pattern: string; glob: GlobList; bucket: BucketConfig }[];
  dailyQuota?: number;
}

export interface RateLimitEvents {
  onRejected?: (tenantId: string, scope: 'tenant' | 'tool' | 'quota', tool?: string) => void;
}

/**
 * Applies per-tenant and per-tool token buckets plus an optional hard daily
 * quota. Per-tool limits are matched by glob against the namespaced tool name
 * (first matching pattern wins, in config order).
 */
export class RateLimitService {
  private limits = new Map<string, CompiledLimits>();

  constructor(
    private readonly store: RateLimitStore,
    tenants: TenantConfig[],
    private readonly events: RateLimitEvents = {}
  ) {
    this.replace(tenants);
  }

  replace(tenants: TenantConfig[]): void {
    this.limits = new Map(
      tenants.map((t) => [
        t.id,
        {
          requests: t.rateLimit.requests,
          perTool: Object.entries(t.rateLimit.perTool).map(([pattern, bucket]) => ({
            pattern,
            glob: new GlobList([pattern]),
            bucket,
          })),
          dailyQuota: t.rateLimit.dailyQuota,
        },
      ])
    );
  }

  /**
   * Throws RATE_LIMITED / QUOTA_EXCEEDED when the call must be rejected.
   * Tenants without configured limits pass through untouched.
   */
  async checkToolCall(tenantId: string, namespacedTool: string): Promise<void> {
    const limits = this.limits.get(tenantId);
    if (!limits) return;

    if (limits.requests) {
      const res = await this.store.consume(`t:${tenantId}`, {
        capacity: limits.requests.burst,
        refillPerSec: limits.requests.ratePerSec,
      });
      if (!res.allowed) {
        this.events.onRejected?.(tenantId, 'tenant');
        throw new GatewayError(`rate limit exceeded for tenant "${tenantId}"`, 'RATE_LIMITED', {
          retryAfterMs: res.retryAfterMs,
          scope: 'tenant',
        });
      }
    }

    const toolLimit = limits.perTool.find((p) => p.glob.matches(namespacedTool));
    if (toolLimit) {
      const res = await this.store.consume(`t:${tenantId}:tool:${toolLimit.pattern}`, {
        capacity: toolLimit.bucket.burst,
        refillPerSec: toolLimit.bucket.ratePerSec,
      });
      if (!res.allowed) {
        this.events.onRejected?.(tenantId, 'tool', namespacedTool);
        throw new GatewayError(
          `rate limit exceeded for tool "${namespacedTool}" (tenant "${tenantId}")`,
          'RATE_LIMITED',
          { retryAfterMs: res.retryAfterMs, scope: 'tool', tool: namespacedTool }
        );
      }
    }

    if (limits.dailyQuota !== undefined) {
      const day = new Date().toISOString().slice(0, 10);
      const used = await this.store.incrementCounter(`q:${tenantId}:${day}`, DAY_SECONDS * 2);
      if (used > limits.dailyQuota) {
        this.events.onRejected?.(tenantId, 'quota');
        throw new GatewayError(
          `daily quota of ${limits.dailyQuota} calls exhausted for tenant "${tenantId}"`,
          'QUOTA_EXCEEDED',
          { quota: limits.dailyQuota, used }
        );
      }
    }
  }
}

import type { RbacConfig, TenantConfig } from '../config/schema.js';
import { GlobList } from './glob.js';

export interface RbacDecision {
  allowed: boolean;
  reason: 'deny-rule' | 'no-allow-match' | 'allow-rule' | 'default-allow' | 'unknown-tenant';
}

interface CompiledPolicy {
  allowTools?: GlobList;
  denyTools: GlobList;
  allowResources?: GlobList;
  denyResources: GlobList;
}

function compile(rbac: RbacConfig): CompiledPolicy {
  return {
    allowTools: rbac.allowTools ? new GlobList(rbac.allowTools) : undefined,
    denyTools: new GlobList(rbac.denyTools),
    allowResources: rbac.allowResources ? new GlobList(rbac.allowResources) : undefined,
    denyResources: new GlobList(rbac.denyResources),
  };
}

function decide(
  value: string,
  allow: GlobList | undefined,
  deny: GlobList
): RbacDecision {
  // Deny always wins, then an allow-list (when present) must match,
  // and with no allow-list the default is allow.
  if (deny.matches(value)) return { allowed: false, reason: 'deny-rule' };
  if (allow) {
    return allow.matches(value)
      ? { allowed: true, reason: 'allow-rule' }
      : { allowed: false, reason: 'no-allow-match' };
  }
  return { allowed: true, reason: 'default-allow' };
}

/**
 * Per-tenant allow/deny policy over namespaced tool names and resource URIs.
 *
 * Tenants that are not declared in config are rejected outright — an
 * authenticated-but-unknown tenant should not get default-allow access.
 */
export class RbacEngine {
  private policies = new Map<string, CompiledPolicy>();

  constructor(tenants: TenantConfig[]) {
    this.replace(tenants);
  }

  replace(tenants: TenantConfig[]): void {
    this.policies = new Map(tenants.map((t) => [t.id, compile(t.rbac)]));
  }

  knowsTenant(tenantId: string): boolean {
    return this.policies.has(tenantId);
  }

  checkTool(tenantId: string, namespacedTool: string): RbacDecision {
    const policy = this.policies.get(tenantId);
    if (!policy) return { allowed: false, reason: 'unknown-tenant' };
    return decide(namespacedTool, policy.allowTools, policy.denyTools);
  }

  checkResource(tenantId: string, uri: string): RbacDecision {
    const policy = this.policies.get(tenantId);
    if (!policy) return { allowed: false, reason: 'unknown-tenant' };
    return decide(uri, policy.allowResources, policy.denyResources);
  }

  /** Filter a tool list down to what a tenant may see. */
  filterTools<T extends { name: string }>(tenantId: string, tools: T[]): T[] {
    return tools.filter((t) => this.checkTool(tenantId, t.name).allowed);
  }

  /** Filter a resource list down to what a tenant may see. */
  filterResources<T extends { uri: string }>(tenantId: string, resources: T[]): T[] {
    return resources.filter((r) => this.checkResource(tenantId, r.uri).allowed);
  }
}

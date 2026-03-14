import type { Resource, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import type { NamespaceConfig } from '../config/schema.js';
import { GatewayError } from '../types.js';
import type { Logger } from '../observability/logger.js';
import { buildNamespacedRegistry, namespacedName, parseNamespacedName } from './namespace.js';
import type { UpstreamConnection } from './upstream.js';

export interface ResolvedTool {
  upstream: UpstreamConnection;
  originalName: string;
}

/**
 * Aggregates many upstream MCP servers behind one tool/resource surface.
 *
 * Tools are namespaced as `<upstream><separator><tool>` (e.g.
 * `github__create_issue`). Resources keep their original URIs; the router
 * maintains a URI -> upstream index built from `resources/list` responses.
 */
export class Router {
  private upstreams = new Map<string, UpstreamConnection>();
  private resourceIndex = new Map<string, string>();

  constructor(
    upstreams: UpstreamConnection[],
    private nsConfig: NamespaceConfig,
    private readonly logger: Logger
  ) {
    for (const u of upstreams) {
      this.upstreams.set(u.name, u);
    }
  }

  get upstreamNames(): string[] {
    return [...this.upstreams.keys()];
  }

  getUpstream(name: string): UpstreamConnection | undefined {
    return this.upstreams.get(name);
  }

  allUpstreams(): UpstreamConnection[] {
    return [...this.upstreams.values()];
  }

  /** Replace routing state on config reload. */
  replace(upstreams: UpstreamConnection[], nsConfig: NamespaceConfig): void {
    this.upstreams = new Map(upstreams.map((u) => [u.name, u]));
    this.nsConfig = nsConfig;
    this.resourceIndex.clear();
  }

  /**
   * Aggregated, namespaced tool list. Upstreams that fail to answer are
   * skipped (and logged) so a single bad upstream cannot take down discovery.
   */
  async listTools(): Promise<Tool[]> {
    const perUpstream = await this.collect('tools/list', (u) => u.listTools());
    const registry = buildNamespacedRegistry(
      perUpstream.map(({ upstream, items }) => ({
        upstream,
        items: items.map((tool) => ({ name: tool.name, value: tool })),
      })),
      this.nsConfig
    );
    for (const d of registry.dropped) {
      this.logger.warn({ name: d.name, upstream: d.upstream }, 'dropped colliding tool');
    }
    return [...registry.entries.entries()].map(([full, { value }]) => ({
      ...value,
      name: full,
    }));
  }

  /** Resolve a namespaced tool name to its upstream + original name. */
  resolveTool(full: string): ResolvedTool {
    const parsed = parseNamespacedName(full, this.nsConfig.separator, this.upstreamNames);
    if (!parsed) {
      throw new GatewayError(
        `unknown tool "${full}": no upstream matches this namespace`,
        'UNKNOWN_TOOL',
        { tool: full }
      );
    }
    const upstream = this.upstreams.get(parsed.upstream);
    if (!upstream) {
      throw new GatewayError(`unknown upstream "${parsed.upstream}"`, 'UNKNOWN_TOOL');
    }
    return { upstream, originalName: parsed.name };
  }

  async callTool(full: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const { upstream, originalName } = this.resolveTool(full);
    return upstream.callTool(originalName, args);
  }

  /** Aggregated resource list; also refreshes the URI routing index. */
  async listResources(): Promise<Resource[]> {
    const perUpstream = await this.collect('resources/list', (u) => u.listResources());
    const merged: Resource[] = [];
    const index = new Map<string, string>();
    for (const { upstream, items } of perUpstream) {
      for (const resource of items) {
        const existing = index.get(resource.uri);
        if (existing) {
          if (this.nsConfig.onCollision === 'error') {
            throw new GatewayError(
              `resource URI collision: "${resource.uri}" provided by both "${existing}" and "${upstream}"`,
              'COLLISION',
              { uri: resource.uri, upstreams: [existing, upstream] }
            );
          }
          this.logger.warn({ uri: resource.uri, upstream }, 'dropped colliding resource');
          continue;
        }
        index.set(resource.uri, upstream);
        merged.push({
          ...resource,
          name: namespacedName(upstream, resource.name, this.nsConfig.separator),
        });
      }
    }
    this.resourceIndex = index;
    return merged;
  }

  /** Which upstream serves this URI? Used by RBAC checks before reading. */
  upstreamForResource(uri: string): string | undefined {
    return this.resourceIndex.get(uri);
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    let owner = this.resourceIndex.get(uri);
    if (!owner) {
      // Index may be stale (or never built); refresh once before giving up.
      await this.listResources();
      owner = this.resourceIndex.get(uri);
    }
    if (!owner) {
      throw new GatewayError(`unknown resource "${uri}"`, 'UNKNOWN_RESOURCE', { uri });
    }
    const upstream = this.upstreams.get(owner);
    if (!upstream) {
      throw new GatewayError(`unknown resource "${uri}"`, 'UNKNOWN_RESOURCE', { uri });
    }
    return upstream.readResource(uri);
  }

  private async collect<T>(
    op: string,
    fn: (u: UpstreamConnection) => Promise<T[]>
  ): Promise<{ upstream: string; items: T[] }[]> {
    const ups = this.allUpstreams();
    const settled = await Promise.allSettled(ups.map((u) => fn(u)));
    const out: { upstream: string; items: T[] }[] = [];
    settled.forEach((result, i) => {
      const name = ups[i].name;
      if (result.status === 'fulfilled') {
        out.push({ upstream: name, items: result.value });
      } else {
        this.logger.warn(
          { upstream: name, op, err: (result.reason as Error).message },
          'upstream failed during aggregation'
        );
      }
    });
    return out;
  }
}

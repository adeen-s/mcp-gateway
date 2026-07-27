import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { SpanStatusCode } from '@opentelemetry/api';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { AuthChain } from './auth/chain.js';
import type { AuthRequestContext } from './auth/provider.js';
import { MemoryCacheStore } from './cache/memory.js';
import { RedisCacheStore } from './cache/redis.js';
import { ResultCache } from './cache/resultCache.js';
import type { CacheStore } from './cache/store.js';
import { loadConfig } from './config/loader.js';
import type { GatewayConfig, UpstreamConfig } from './config/schema.js';
import { AuditLogger, type AuditSink } from './observability/audit.js';
import { createLogger, type Logger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { getTracer } from './observability/tracing.js';
import { MemoryRateLimitStore } from './ratelimit/memory.js';
import { RedisRateLimitStore } from './ratelimit/redis.js';
import { RateLimitService } from './ratelimit/limiter.js';
import type { RateLimitStore } from './ratelimit/store.js';
import { RbacEngine } from './rbac/rbac.js';
import { HealthMonitor } from './resilience/health.js';
import { Router } from './routing/router.js';
import { UpstreamConnection } from './routing/upstream.js';
import { createAdminServer } from './admin/api.js';
import { GatewayError, VERSION, type TenantIdentity } from './types.js';

/** JSON-RPC error codes for gateway-level rejections (vendor range). */
const JSONRPC_FORBIDDEN = -32043;
const JSONRPC_RATE_LIMITED = -32029;

/**
 * JSON-RPC error thrown from request handlers. The SDK serializes any error
 * carrying a numeric `code`; unlike McpError it doesn't bake "MCP error <code>:"
 * into the message, which the client would otherwise prefix a second time.
 */
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

interface Session {
  transport: StreamableHTTPServerTransport;
  server: Server;
  tenant: TenantIdentity;
}

export interface GatewayOptions {
  config: GatewayConfig;
  /** Where the config came from; enables hot reload via admin API / SIGHUP. */
  configPath?: string;
  logger?: Logger;
  /** Test hook: capture audit events instead of writing to stdout/file. */
  auditSink?: AuditSink;
}

export class Gateway {
  private config: GatewayConfig;
  private readonly configPath?: string;
  readonly logger: Logger;
  readonly metrics: Metrics;
  private audit: AuditLogger;
  private authChain: AuthChain;
  private readonly rbac: RbacEngine;
  private readonly rateLimitStore: RateLimitStore;
  private readonly rateLimiter: RateLimitService;
  private readonly cacheStore: CacheStore;
  readonly cache: ResultCache;
  private readonly router: Router;
  private readonly healthMonitor: HealthMonitor;
  private httpServer?: http.Server | https.Server;
  private adminServer?: http.Server;
  private readonly sessions = new Map<string, Session>();
  private stopped = false;

  constructor(private readonly options: GatewayOptions) {
    this.config = options.config;
    this.configPath = options.configPath;
    this.logger = options.logger ?? createLogger({ level: this.config.observability.logLevel });
    this.metrics = new Metrics();
    this.audit = new AuditLogger(this.config.observability.audit, options.auditSink);
    this.authChain = AuthChain.fromConfig(this.config.auth);
    this.rbac = new RbacEngine(this.config.tenants);

    this.rateLimitStore =
      this.config.rateLimit.backend === 'redis'
        ? new RedisRateLimitStore(this.config.redis.url, this.config.redis.keyPrefix)
        : new MemoryRateLimitStore();
    this.rateLimiter = new RateLimitService(this.rateLimitStore, this.config.tenants, {
      onRejected: (tenant, scope, tool) => {
        this.metrics.rateLimitRejections.inc({ tenant, scope });
        this.audit.record({ event: 'rate_limited', tenant, tool, status: 'denied' });
      },
    });

    this.cacheStore =
      this.config.cache.backend === 'redis'
        ? new RedisCacheStore(this.config.redis.url, this.config.redis.keyPrefix)
        : new MemoryCacheStore(this.config.cache.maxEntries);
    this.cache = new ResultCache(this.cacheStore, this.config.cache, this.logger, {
      onHit: (tool) => this.metrics.cacheHits.inc({ tool }),
      onMiss: (tool) => this.metrics.cacheMisses.inc({ tool }),
    });

    this.healthMonitor = new HealthMonitor(this.logger);
    this.router = new Router(
      this.config.upstreams.map((u) => this.newUpstream(u)),
      this.config.namespace,
      this.logger
    );
  }

  private newUpstream(config: UpstreamConfig): UpstreamConnection {
    return new UpstreamConnection(config, this.logger.child({ upstream: config.name }), {
      onCircuitStateChange: (name, _from, to) => this.metrics.setCircuitState(name, to),
      onHealthChange: (name, healthy) =>
        this.metrics.upstreamHealthy.set({ upstream: name }, healthy ? 1 : 0),
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const results = await Promise.allSettled(
      this.router.allUpstreams().map((u) => u.connect())
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const name = this.router.allUpstreams()[i].name;
        this.logger.error(
          { upstream: name, err: (r.reason as Error).message },
          'failed to connect upstream at startup; will keep retrying lazily'
        );
      }
    });

    this.healthMonitor.watch(this.router.allUpstreams());

    this.httpServer = this.createMcpServer();
    await this.listen(this.httpServer, this.config.server.port, this.config.server.host);
    this.logger.info(
      { host: this.config.server.host, port: this.mcpPort, path: this.config.server.path },
      'mcp endpoint listening'
    );

    if (this.config.admin.enabled) {
      this.adminServer = createAdminServer({
        logger: this.logger,
        token: this.config.admin.token,
        metrics: this.config.observability.metrics.enabled ? this.metrics : undefined,
        metricsPath: this.config.observability.metrics.path,
        getUpstreams: () => this.router.allUpstreams().map((u) => u.status()),
        getTenants: () =>
          this.config.tenants.map((t) => ({
            id: t.id,
            displayName: t.displayName,
            rbac: t.rbac,
            rateLimit: t.rateLimit,
          })),
        invalidateCache: (tool) => this.cache.invalidate(tool),
        reload: () => this.reload(),
      });
      await this.listen(this.adminServer, this.config.admin.port, this.config.admin.host);
      this.logger.info({ port: this.adminPort }, 'admin endpoint listening');
    }
  }

  private listen(server: http.Server, port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  }

  get mcpPort(): number {
    return (this.httpServer?.address() as AddressInfo | null)?.port ?? this.config.server.port;
  }

  get adminPort(): number {
    return (this.adminServer?.address() as AddressInfo | null)?.port ?? this.config.admin.port;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.healthMonitor.stop();
    for (const [id, session] of this.sessions) {
      try {
        await session.transport.close();
      } catch {
        // best effort
      }
      this.sessions.delete(id);
    }
    await Promise.allSettled(this.router.allUpstreams().map((u) => u.close()));
    await new Promise<void>((resolve) => this.httpServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => this.adminServer?.close(() => resolve()) ?? resolve());
    await this.rateLimitStore.close();
    await this.cacheStore.close();
    await this.audit.close();
    this.logger.info('gateway stopped');
  }

  /**
   * Hot reload: re-reads the config file and applies tenant/RBAC/rate-limit/
   * cache/namespace/upstream changes in place. Listener address changes are
   * ignored (a restart is required for those) — by design, so a bad reload
   * can never take the listener down.
   */
  async reload(): Promise<{ reloaded: boolean; warnings: string[] }> {
    if (!this.configPath) {
      return { reloaded: false, warnings: ['gateway was started without a config file path'] };
    }
    const next = await loadConfig(this.configPath);
    const warnings: string[] = [];
    if (
      next.server.port !== this.config.server.port ||
      next.server.host !== this.config.server.host ||
      next.admin.port !== this.config.admin.port
    ) {
      warnings.push('listener host/port changes require a restart and were ignored');
    }

    this.rbac.replace(next.tenants);
    this.rateLimiter.replace(next.tenants);
    this.cache.reconfigure(next.cache);
    this.authChain = AuthChain.fromConfig(next.auth);

    // Reconcile upstreams: keep connections whose config is unchanged.
    const currentByName = new Map(this.router.allUpstreams().map((u) => [u.name, u]));
    const keep: UpstreamConnection[] = [];
    for (const upstreamCfg of next.upstreams) {
      const existing = currentByName.get(upstreamCfg.name);
      if (existing && JSON.stringify(existing.config) === JSON.stringify(upstreamCfg)) {
        keep.push(existing);
        currentByName.delete(upstreamCfg.name);
      } else {
        keep.push(this.newUpstream(upstreamCfg));
      }
    }
    // Anything left in currentByName was either removed or replaced.
    await Promise.allSettled([...currentByName.values()].map((u) => u.close()));

    this.router.replace(keep, next.namespace);
    this.healthMonitor.watch(keep);
    this.config = next;
    this.logger.info({ warnings }, 'configuration reloaded');
    return { reloaded: true, warnings };
  }

  // -------------------------------------------------------------------------
  // MCP endpoint
  // -------------------------------------------------------------------------

  private createMcpServer(): http.Server | https.Server {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      this.handleMcpRequest(req, res).catch((err: unknown) => {
        this.logger.error({ err: (err as Error).message }, 'unhandled error in mcp handler');
        if (!res.headersSent) {
          this.writeJson(res, 500, {
            jsonrpc: '2.0',
            error: { code: ErrorCode.InternalError, message: 'internal server error' },
            id: null,
          });
        }
      });
    };

    const tls = this.config.server.tls;
    if (tls) {
      return https.createServer(
        {
          cert: readFileSync(tls.certFile),
          key: readFileSync(tls.keyFile),
          ca: tls.caFile ? readFileSync(tls.caFile) : undefined,
          requestCert: tls.requestClientCert,
          // Identity mapping happens in the mTLS auth provider; unknown certs
          // are rejected there with a 401 rather than a TLS alert.
          rejectUnauthorized: false,
        },
        handler
      );
    }
    return http.createServer(handler);
  }

  private async handleMcpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://internal');
    if (url.pathname !== this.config.server.path) {
      this.writeJson(res, 404, { error: 'not found' });
      return;
    }

    // Authenticate every request, not just session creation: API keys can be
    // revoked mid-session and a session id must never outlive its credential.
    let tenant: TenantIdentity;
    try {
      tenant = await this.authChain.authenticate(this.authContext(req));
    } catch (err) {
      const message = err instanceof GatewayError ? err.message : 'authentication failed';
      this.metrics.authFailures.inc({ reason: 'invalid-credentials' });
      this.audit.record({ event: 'auth_failure', status: 'denied', error: message });
      this.writeJson(res, 401, {
        jsonrpc: '2.0',
        error: { code: ErrorCode.InvalidRequest, message },
        id: null,
      });
      return;
    }

    if (!this.rbac.knowsTenant(tenant.tenantId)) {
      this.metrics.authFailures.inc({ reason: 'unknown-tenant' });
      this.audit.record({
        event: 'auth_failure',
        tenant: tenant.tenantId,
        status: 'denied',
        error: 'tenant is not configured',
      });
      this.writeJson(res, 403, {
        jsonrpc: '2.0',
        error: { code: JSONRPC_FORBIDDEN, message: `tenant "${tenant.tenantId}" is not configured` },
        id: null,
      });
      return;
    }

    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined;
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (!session) {
        this.writeJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: ErrorCode.ConnectionClosed, message: 'session not found' },
          id: null,
        });
        return;
      }
      if (session.tenant.tenantId !== tenant.tenantId) {
        this.writeJson(res, 403, {
          jsonrpc: '2.0',
          error: { code: JSONRPC_FORBIDDEN, message: 'session belongs to another tenant' },
          id: null,
        });
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }

    // No session yet: this must be an initialize POST.
    await this.openSession(tenant, req, res);
  }

  private async openSession(
    tenant: TenantIdentity,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.sessions.set(sessionId, { transport, server, tenant });
        this.metrics.activeSessions.set(this.sessions.size);
        this.audit.record({
          event: 'session_open',
          tenant: tenant.tenantId,
          authMethod: tenant.method,
          subject: tenant.subject,
          sessionId,
        });
      },
      onsessionclosed: (sessionId) => {
        this.sessions.delete(sessionId);
        this.metrics.activeSessions.set(this.sessions.size);
        this.audit.record({ event: 'session_close', tenant: tenant.tenantId, sessionId });
      },
    });
    const server = this.buildSessionServer(tenant);
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid && this.sessions.delete(sid)) {
        this.metrics.activeSessions.set(this.sessions.size);
      }
    };
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  private authContext(req: http.IncomingMessage): AuthRequestContext {
    const socket = req.socket as TLSSocket;
    const peerCertificate =
      typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : undefined;
    return { headers: req.headers, peerCertificate };
  }

  // -------------------------------------------------------------------------
  // Per-session MCP server
  // -------------------------------------------------------------------------

  private buildSessionServer(tenant: TenantIdentity): Server {
    const server = new Server(
      { name: 'mcp-gateway', version: VERSION },
      {
        capabilities: { tools: {}, resources: {} },
        instructions:
          'Aggregated MCP gateway. Tool names are namespaced as <upstream>' +
          this.config.namespace.separator +
          '<tool>.',
      }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools = await this.router.listTools();
      const visible = this.rbac.filterTools(tenant.tenantId, tools);
      this.audit.record({ event: 'list_tools', tenant: tenant.tenantId, status: 'ok' });
      return { tools: visible };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const tool = request.params.name;
      const args = request.params.arguments;
      return this.executeToolCall(tenant, tool, args);
    });

    server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = await this.router.listResources();
      const visible = this.rbac.filterResources(tenant.tenantId, resources);
      this.audit.record({ event: 'list_resources', tenant: tenant.tenantId, status: 'ok' });
      return { resources: visible };
    });

    server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const uri = request.params.uri;
      const decision = this.rbac.checkResource(tenant.tenantId, uri);
      if (!decision.allowed) {
        this.metrics.rbacDenials.inc({ tenant: tenant.tenantId, kind: 'resource' });
        this.audit.record({
          event: 'rbac_denied',
          tenant: tenant.tenantId,
          resource: uri,
          status: 'denied',
          error: decision.reason,
        });
        throw new RpcError(JSONRPC_FORBIDDEN, `access to resource "${uri}" is denied`);
      }
      try {
        const result = await this.router.readResource(uri);
        this.audit.record({
          event: 'resource_read',
          tenant: tenant.tenantId,
          resource: uri,
          upstream: this.router.upstreamForResource(uri),
          status: 'ok',
        });
        return result;
      } catch (err) {
        this.audit.record({
          event: 'resource_read',
          tenant: tenant.tenantId,
          resource: uri,
          status: 'error',
          error: (err as Error).message,
        });
        throw this.toRpcError(err);
      }
    });

    return server;
  }

  private async executeToolCall(
    tenant: TenantIdentity,
    tool: string,
    args: Record<string, unknown> | undefined
  ): Promise<CallToolResult> {
    const decision = this.rbac.checkTool(tenant.tenantId, tool);
    if (!decision.allowed) {
      this.metrics.rbacDenials.inc({ tenant: tenant.tenantId, kind: 'tool' });
      this.audit.record({
        event: 'rbac_denied',
        tenant: tenant.tenantId,
        tool,
        status: 'denied',
        error: decision.reason,
      });
      throw new RpcError(JSONRPC_FORBIDDEN, `access to tool "${tool}" is denied`);
    }

    let resolved: ReturnType<Router['resolveTool']>;
    try {
      await this.rateLimiter.checkToolCall(tenant.tenantId, tool);
      resolved = this.router.resolveTool(tool);
    } catch (err) {
      throw this.toRpcError(err);
    }

    const cached = await this.cache.get(tool, args);
    if (cached) {
      this.metrics.toolCalls.inc({ tenant: tenant.tenantId, tool, upstream: 'cache', status: 'ok' });
      this.audit.record({
        event: 'tool_call',
        tenant: tenant.tenantId,
        tool,
        status: 'ok',
        cached: true,
      });
      return cached;
    }

    const upstreamName = resolved.upstream.name;
    const tracer = getTracer();
    const startedAt = process.hrtime.bigint();

    return tracer.startActiveSpan(`mcp.tool ${tool}`, async (span) => {
      span.setAttribute('mcp.tool', tool);
      span.setAttribute('mcp.upstream', upstreamName);
      span.setAttribute('mcp.tenant', tenant.tenantId);
      try {
        const result = await resolved.upstream.callTool(resolved.originalName, args);
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        this.metrics.toolCalls.inc({
          tenant: tenant.tenantId,
          tool,
          upstream: upstreamName,
          status: result.isError ? 'tool-error' : 'ok',
        });
        this.metrics.toolCallDuration.observe({ tool, upstream: upstreamName }, durationMs / 1000);
        this.audit.record({
          event: 'tool_call',
          tenant: tenant.tenantId,
          authMethod: tenant.method,
          subject: tenant.subject,
          tool,
          upstream: upstreamName,
          status: result.isError ? 'error' : 'ok',
          durationMs: Math.round(durationMs),
          cached: false,
        });
        if (!result.isError) {
          await this.cache.put(tool, args, result);
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
        this.metrics.toolCalls.inc({
          tenant: tenant.tenantId,
          tool,
          upstream: upstreamName,
          status: 'error',
        });
        this.audit.record({
          event: 'tool_call',
          tenant: tenant.tenantId,
          tool,
          upstream: upstreamName,
          status: 'error',
          durationMs: Math.round(durationMs),
          error: (err as Error).message,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        throw this.toRpcError(err);
      } finally {
        span.end();
      }
    });
  }

  private toRpcError(err: unknown): RpcError {
    if (err instanceof RpcError) return err;
    // Upstream protocol errors keep their code.
    if (err instanceof McpError) return new RpcError(err.code, err.message, err.data);
    if (err instanceof GatewayError) {
      switch (err.code) {
        case 'UNKNOWN_TOOL':
        case 'UNKNOWN_RESOURCE':
          return new RpcError(ErrorCode.InvalidParams, err.message, err.details);
        case 'FORBIDDEN':
          return new RpcError(JSONRPC_FORBIDDEN, err.message, err.details);
        case 'RATE_LIMITED':
        case 'QUOTA_EXCEEDED':
          return new RpcError(JSONRPC_RATE_LIMITED, err.message, err.details);
        case 'UPSTREAM_TIMEOUT':
          return new RpcError(ErrorCode.RequestTimeout, err.message, err.details);
        default:
          return new RpcError(ErrorCode.InternalError, err.message, err.details);
      }
    }
    return new RpcError(ErrorCode.InternalError, (err as Error).message ?? 'internal error');
  }

  private writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

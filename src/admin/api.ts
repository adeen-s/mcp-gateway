import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { RbacConfig, TenantRateLimitConfig } from '../config/schema.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { UpstreamStatus } from '../routing/upstream.js';

export interface TenantSummary {
  id: string;
  displayName?: string;
  rbac: RbacConfig;
  rateLimit: TenantRateLimitConfig;
}

export interface AdminContext {
  logger: Logger;
  /** Bearer token guarding /admin/*; when unset, admin routes are open (bind to localhost!). */
  token?: string;
  metrics?: Metrics;
  metricsPath: string;
  getUpstreams(): UpstreamStatus[];
  getTenants(): TenantSummary[];
  invalidateCache(tool?: string): Promise<number>;
  reload(): Promise<{ reloaded: boolean; warnings: string[] }>;
}

function send(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const payload = contentType === 'application/json' ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(status, { 'content-type': contentType });
  res.end(payload);
}

function authorized(ctx: AdminContext, req: http.IncomingMessage): boolean {
  if (!ctx.token) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(ctx.token);
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
    if (Buffer.concat(chunks).length > 64 * 1024) {
      throw new Error('request body too large');
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  return JSON.parse(text);
}

/**
 * Small operational API, deliberately separate from the MCP listener so that
 * operators can firewall it independently.
 *
 *   GET  /healthz                  liveness + upstream summary
 *   GET  /metrics                  Prometheus exposition
 *   GET  /admin/upstreams          upstream config/health/circuit detail
 *   GET  /admin/tenants            configured tenants with policy summary
 *   POST /admin/cache/invalidate   { "tool": "github__*" } (omit = flush all)
 *   POST /admin/reload             re-read config file and apply
 */
export function createAdminServer(ctx: AdminContext): http.Server {
  return http.createServer((req, res) => {
    handle(ctx, req, res).catch((err: unknown) => {
      ctx.logger.error({ err: (err as Error).message }, 'admin api error');
      if (!res.headersSent) {
        send(res, 500, { error: 'internal error' });
      }
    });
  });
}

async function handle(
  ctx: AdminContext,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://internal');
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /healthz') {
    const upstreams = ctx.getUpstreams();
    const healthy = upstreams.filter((u) => u.healthy).length;
    const status = healthy === upstreams.length ? 'ok' : healthy > 0 ? 'degraded' : 'unhealthy';
    send(res, status === 'unhealthy' ? 503 : 200, {
      status,
      upstreams: { healthy, total: upstreams.length },
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === ctx.metricsPath) {
    if (!ctx.metrics) {
      send(res, 404, { error: 'metrics disabled' });
      return;
    }
    const text = await ctx.metrics.render();
    send(res, 200, text, ctx.metrics.registry.contentType);
    return;
  }

  if (url.pathname.startsWith('/admin/')) {
    if (!authorized(ctx, req)) {
      send(res, 401, { error: 'missing or invalid admin token' });
      return;
    }

    if (route === 'GET /admin/upstreams') {
      send(res, 200, { upstreams: ctx.getUpstreams() });
      return;
    }
    if (route === 'GET /admin/tenants') {
      send(res, 200, { tenants: ctx.getTenants() });
      return;
    }
    if (route === 'POST /admin/cache/invalidate') {
      const body = (await readBody(req)) as { tool?: string };
      const removed = await ctx.invalidateCache(body.tool);
      ctx.logger.info({ tool: body.tool ?? '*', removed }, 'cache invalidated via admin api');
      send(res, 200, { removed });
      return;
    }
    if (route === 'POST /admin/reload') {
      try {
        const result = await ctx.reload();
        send(res, result.reloaded ? 200 : 409, result);
      } catch (err) {
        send(res, 400, { reloaded: false, error: (err as Error).message });
      }
      return;
    }
  }

  send(res, 404, { error: 'not found' });
}

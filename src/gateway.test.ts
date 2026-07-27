import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { parseConfig } from './config/loader.js';
import { silentLogger } from './observability/logger.js';
import { Gateway } from './server.js';

/**
 * Full-stack test: a real MCP client talks streamable HTTP to the gateway,
 * which proxies to a real stdio upstream. Exercises auth, RBAC, rate
 * limiting, caching and error mapping exactly as a client would see them.
 */

const audit: Record<string, unknown>[] = [];

const gateway = new Gateway({
  logger: silentLogger(),
  auditSink: {
    write: (line) => void audit.push(JSON.parse(line) as Record<string, unknown>),
    close: () => Promise.resolve(),
  },
  config: parseConfig({
    server: { host: '127.0.0.1', port: 0 },
    admin: { enabled: true, host: '127.0.0.1', port: 0, token: 'admin-token' },
    upstreams: [
      {
        name: 'echo',
        transport: {
          type: 'stdio',
          command: process.execPath,
          args: ['examples/upstream-echo/server.mjs'],
          env: { ECHO_SERVER_NAME: 'echo' },
        },
        timeoutMs: 10_000,
      },
    ],
    auth: {
      providers: [
        {
          type: 'apiKey',
          keys: [
            { key: 'acme-key', tenant: 'acme' },
            { key: 'ghost-key', tenant: 'ghost' },
          ],
        },
      ],
    },
    tenants: [
      {
        id: 'acme',
        rbac: { allowTools: ['echo__*', 'ghost__*'], denyTools: ['echo__fail'] },
        rateLimit: { perTool: { echo__counter: { ratePerSec: 0.001, burst: 2 } } },
      },
    ],
    cache: { enabled: true, tools: ['echo__add'] },
  }),
});

const mcpUrl = () => new URL(`http://127.0.0.1:${gateway.mcpPort}/mcp`);

async function connect(apiKey: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(mcpUrl(), {
      requestInit: { headers: { 'x-api-key': apiKey } },
    })
  );
  return client;
}

describe('gateway end-to-end (http client -> gateway -> stdio upstream)', () => {
  let client: Client;

  beforeAll(async () => {
    await gateway.start();
    client = await connect('acme-key');
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    await gateway.stop();
  });

  it('rejects requests without credentials with 401', async () => {
    const res = await fetch(mcpUrl(), { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects authenticated but unconfigured tenants with 403', async () => {
    const res = await fetch(mcpUrl(), {
      method: 'POST',
      headers: { 'x-api-key': 'ghost-key' },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('lists only the tools the tenant is allowed to see', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('echo__echo');
    expect(names).not.toContain('echo__fail');
  });

  it('proxies tool calls to the upstream', async () => {
    const result = await client.callTool({ name: 'echo__echo', arguments: { message: 'hi' } });
    expect(JSON.stringify(result.content)).toContain('[echo] hi');
  });

  it('denies tools blocked by RBAC even when called directly', async () => {
    await expect(client.callTool({ name: 'echo__fail', arguments: {} })).rejects.toThrow(/denied/);
  });

  it('maps unknown upstream namespaces to InvalidParams', async () => {
    await expect(client.callTool({ name: 'ghost__echo', arguments: {} })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
    });
  });

  it('serves repeat calls to cacheable tools from the cache', async () => {
    await client.callTool({ name: 'echo__add', arguments: { a: 2, b: 3 } });
    const second = await client.callTool({ name: 'echo__add', arguments: { b: 3, a: 2 } });
    expect(JSON.stringify(second.content)).toContain('5');
    const adds = audit.filter((e) => e.event === 'tool_call' && e.tool === 'echo__add');
    expect(adds.map((e) => e.cached)).toEqual([false, true]);
  });

  it('enforces per-tool rate limits', async () => {
    await client.callTool({ name: 'echo__counter', arguments: {} });
    await client.callTool({ name: 'echo__counter', arguments: {} });
    await expect(client.callTool({ name: 'echo__counter', arguments: {} })).rejects.toThrow(
      /rate limit/
    );
  });

  it('exposes upstream health on the admin API behind a token', async () => {
    const url = `http://127.0.0.1:${gateway.adminPort}/admin/upstreams`;
    expect((await fetch(url)).status).toBe(401);
    const res = await fetch(url, { headers: { authorization: 'Bearer admin-token' } });
    const body = (await res.json()) as { upstreams: { name: string; connected: boolean }[] };
    expect(body.upstreams).toEqual([expect.objectContaining({ name: 'echo', connected: true })]);
  });

  it('answers malformed admin payloads with 400', async () => {
    const res = await fetch(`http://127.0.0.1:${gateway.adminPort}/admin/cache/invalidate`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin-token' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
}, 60_000);

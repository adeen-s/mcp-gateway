import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { parseConfig } from './config/loader.js';
import { silentLogger } from './observability/logger.js';
import { Gateway } from './server.js';

/**
 * Idle-session reaping: a client that vanishes without a DELETE must not keep
 * its session forever, but a connected client holding its GET stream open
 * must never be reaped.
 */

const IDLE_MS = 300;
const audit: Record<string, unknown>[] = [];

const gateway = new Gateway({
  logger: silentLogger(),
  auditSink: {
    write: (line) => void audit.push(JSON.parse(line) as Record<string, unknown>),
    close: () => Promise.resolve(),
  },
  config: parseConfig({
    server: { host: '127.0.0.1', port: 0, sessionIdleTimeoutMs: IDLE_MS },
    admin: { enabled: false },
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
    auth: { providers: [{ type: 'apiKey', keys: [{ key: 'acme-key', tenant: 'acme' }] }] },
    tenants: [{ id: 'acme' }],
  }),
});

const mcpUrl = () => `http://127.0.0.1:${gateway.mcpPort}/mcp`;
const headers = {
  'x-api-key': 'acme-key',
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

/** Initialize a session over raw HTTP, then walk away without a DELETE. */
async function abandonedSession(): Promise<string> {
  const res = await fetch(mcpUrl(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'vanishing', version: '0.0.0' },
      },
    }),
  });
  await res.text();
  const sessionId = res.headers.get('mcp-session-id');
  if (!sessionId) throw new Error(`initialize failed with HTTP ${res.status}`);
  return sessionId;
}

function listTools(sessionId: string): Promise<Response> {
  return fetch(mcpUrl(), {
    method: 'POST',
    headers: {
      ...headers,
      'mcp-session-id': sessionId,
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('idle session reaping', () => {
  beforeAll(() => gateway.start(), 30_000);
  afterAll(() => gateway.stop());

  it('keeps a session that is used within the timeout', async () => {
    const sessionId = await abandonedSession();
    await sleep(IDLE_MS / 2);
    const res = await listTools(sessionId);
    await res.text();
    expect(res.status).toBe(200);
  });

  it('closes a session left idle past the timeout and audits it', async () => {
    const sessionId = await abandonedSession();
    await sleep(IDLE_MS * 2);
    const res = await listTools(sessionId);
    await res.text();
    expect(res.status).toBe(404);
    expect(audit).toContainEqual(
      expect.objectContaining({ event: 'session_expired', tenant: 'acme', sessionId })
    );
  });

  it('never reaps a connected client holding its GET stream open', async () => {
    const client = new Client({ name: 'live', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(mcpUrl()), {
        requestInit: { headers: { 'x-api-key': 'acme-key' } },
      })
    );
    try {
      await sleep(IDLE_MS * 2);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('echo__echo');
    } finally {
      await client.close();
    }
  });
});

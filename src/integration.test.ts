import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upstreamSchema, namespaceSchema } from './config/schema.js';
import { silentLogger } from './observability/logger.js';
import { Router } from './routing/router.js';
import { UpstreamConnection } from './routing/upstream.js';

/**
 * End-to-end wiring test: two real MCP upstreams (the bundled echo example)
 * spawned over stdio, aggregated by the Router with namespaced routing.
 */

function makeUpstream(name: string): UpstreamConnection {
  return new UpstreamConnection(
    upstreamSchema.parse({
      name,
      transport: {
        type: 'stdio',
        command: process.execPath,
        args: ['examples/upstream-echo/server.mjs'],
        env: { ECHO_SERVER_NAME: name },
      },
      timeoutMs: 10_000,
    }),
    silentLogger()
  );
}

describe('gateway <-> upstream integration (stdio)', () => {
  const alpha = makeUpstream('alpha');
  const beta = makeUpstream('beta');
  const router = new Router([alpha, beta], namespaceSchema.parse({}), silentLogger());

  beforeAll(async () => {
    await Promise.all([alpha.connect(), beta.connect()]);
  }, 30_000);

  afterAll(async () => {
    await Promise.all([alpha.close(), beta.close()]);
  });

  it('aggregates and namespaces tools from every upstream', async () => {
    const tools = await router.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toContain('alpha__echo');
    expect(names).toContain('alpha__add');
    expect(names).toContain('beta__echo');
    // Same tool name on two upstreams must not collide once namespaced.
    expect(new Set(names).size).toBe(names.length);
  });

  it('routes namespaced calls to the right upstream process', async () => {
    const fromAlpha = await router.callTool('alpha__echo', { message: 'hi' });
    const fromBeta = await router.callTool('beta__echo', { message: 'hi' });
    expect(JSON.stringify(fromAlpha.content)).toContain('[alpha] hi');
    expect(JSON.stringify(fromBeta.content)).toContain('[beta] hi');
  });

  it('returns real results from deterministic tools', async () => {
    const result = await router.callTool('alpha__add', { a: 19, b: 23 });
    expect(JSON.stringify(result.content)).toContain('42');
  });

  it('rejects unknown namespaces with a typed gateway error', async () => {
    await expect(router.callTool('ghost__echo', {})).rejects.toMatchObject({
      code: 'UNKNOWN_TOOL',
    });
  });
}, 60_000);

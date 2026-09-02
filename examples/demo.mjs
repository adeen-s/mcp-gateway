#!/usr/bin/env node
/**
 * Walks through what the gateway does, as a client sees it. Start the gateway
 * first (`npm run dev -- --config config/example.yaml` or `docker compose up`).
 *
 *   GATEWAY_URL=http://localhost:8080/mcp API_KEY=dev-acme-key-123 node examples/demo.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.GATEWAY_URL ?? 'http://localhost:8080/mcp');
const apiKey = process.env.API_KEY ?? 'dev-acme-key-123';

const step = (title) => console.log(`\n▸ ${title}`);
const text = (result) => result.content.map((c) => c.text).join(' ');
const attempt = async (fn) => {
  try {
    return `ok: ${text(await fn())}`;
  } catch (err) {
    return `rejected: ${err.message}`;
  }
};

step('Unauthenticated request');
const anon = await fetch(url, { method: 'POST', body: '{}' });
console.log(`  HTTP ${anon.status}`);

const client = new Client({ name: 'demo', version: '1.0.0' });
await client.connect(
  new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'x-api-key': apiKey } } })
);

step('tools/list as tenant "acme" (filtered by RBAC)');
const { tools } = await client.listTools();
for (const t of tools) console.log(`  ${t.name}`);

step('Call echo__echo (routed to the "echo" upstream)');
console.log(`  ${await attempt(() => client.callTool({ name: 'echo__echo', arguments: { message: 'hello' } }))}`);

step('Call echo__fail (denied by RBAC even though the upstream has it)');
console.log(`  ${await attempt(() => client.callTool({ name: 'echo__fail', arguments: {} }))}`);

step('Call echo__add twice with the same args (the second is a cache hit: "cached":true in the audit log)');
for (let i = 0; i < 2; i++) {
  console.log(`  ${await attempt(() => client.callTool({ name: 'echo__add', arguments: { a: 20, b: 22 } }))}`);
}

step('Keep calling echo__add past its per-tool limit (burst 5, refill 2/s)');
for (let i = 1; i <= 8; i++) {
  console.log(`  #${i} ${await attempt(() => client.callTool({ name: 'echo__add', arguments: { a: i, b: i } }))}`);
}

await client.close();

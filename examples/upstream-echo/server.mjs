#!/usr/bin/env node
/**
 * Tiny example MCP server used by docker-compose and the integration tests.
 * Speaks stdio; exposes a few tools and one resource.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const NAME = process.env.ECHO_SERVER_NAME ?? 'upstream-echo';

const server = new McpServer({ name: NAME, version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Echoes the message back, prefixed with the server name.',
    inputSchema: { message: z.string().describe('Text to echo back') },
  },
  async ({ message }) => ({
    content: [{ type: 'text', text: `[${NAME}] ${message}` }],
  })
);

server.registerTool(
  'add',
  {
    description: 'Adds two numbers. Deterministic, safe to cache.',
    inputSchema: { a: z.number(), b: z.number() },
  },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  })
);

let callCount = 0;
server.registerTool(
  'counter',
  {
    description: 'Returns how many times it has been called. NOT idempotent.',
    inputSchema: {},
  },
  async () => {
    callCount += 1;
    return { content: [{ type: 'text', text: String(callCount) }] };
  }
);

server.registerTool(
  'fail',
  {
    description: 'Always fails. Useful for testing error propagation.',
    inputSchema: {},
  },
  async () => ({
    content: [{ type: 'text', text: 'deliberate failure' }],
    isError: true,
  })
);

server.registerResource(
  'greeting',
  'echo://greeting',
  { description: 'A static greeting resource.', mimeType: 'text/plain' },
  async () => ({
    contents: [{ uri: 'echo://greeting', mimeType: 'text/plain', text: `hello from ${NAME}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);

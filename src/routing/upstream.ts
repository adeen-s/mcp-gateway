import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { UpstreamConfig } from '../config/schema.js';
import { CircuitBreaker, CircuitOpenError, type CircuitState } from '../resilience/circuitBreaker.js';
import { withRetry, withTimeout, TimeoutError } from '../resilience/retry.js';
import { GatewayError, VERSION } from '../types.js';
import type { Logger } from '../observability/logger.js';

export interface UpstreamStatus {
  name: string;
  transport: UpstreamConfig['transport']['type'];
  connected: boolean;
  healthy: boolean;
  circuitState: CircuitState;
  lastHealthCheck?: {
    at: string;
    ok: boolean;
    latencyMs?: number;
    error?: string;
  };
}

export interface UpstreamEvents {
  onCircuitStateChange?: (upstream: string, from: CircuitState, to: CircuitState) => void;
  onHealthChange?: (upstream: string, healthy: boolean) => void;
}

/**
 * A managed connection to a single upstream MCP server.
 *
 * Wraps the SDK Client with:
 *  - lazy (re)connection — a dead stdio child or dropped HTTP session is
 *    transparently re-established on the next call,
 *  - a circuit breaker shared by all operations against this upstream,
 *  - per-call timeouts,
 *  - retries with exponential backoff + jitter for idempotent operations.
 *
 * Tool calls are deliberately NOT retried: the gateway cannot know whether an
 * arbitrary tool is safe to re-execute, and duplicating side effects is worse
 * than surfacing an error to the caller.
 */
export class UpstreamConnection {
  readonly name: string;
  private client: Client | undefined;
  private transport: Transport | undefined;
  private connecting: Promise<void> | undefined;
  private closed = false;
  private healthy = false;
  private lastHealthCheck: UpstreamStatus['lastHealthCheck'];
  readonly breaker: CircuitBreaker;

  constructor(
    readonly config: UpstreamConfig,
    private readonly logger: Logger,
    private readonly events: UpstreamEvents = {}
  ) {
    this.name = config.name;
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitBreaker.failureThreshold,
      successThreshold: config.circuitBreaker.successThreshold,
      openDurationMs: config.circuitBreaker.openDurationMs,
      halfOpenMaxConcurrent: config.circuitBreaker.halfOpenMaxConcurrent,
      onStateChange: (from, to) => {
        this.logger.warn({ upstream: this.name, from, to }, 'circuit breaker state change');
        this.events.onCircuitStateChange?.(this.name, from, to);
      },
    });
  }

  private buildTransport(): Transport {
    const t = this.config.transport;
    switch (t.type) {
      case 'stdio':
        return new StdioClientTransport({
          command: t.command,
          args: t.args,
          env: { ...process.env, ...t.env } as Record<string, string>,
          cwd: t.cwd,
          stderr: 'pipe',
        });
      case 'http':
        return new StreamableHTTPClientTransport(new URL(t.url), {
          requestInit: { headers: t.headers },
        });
      case 'sse':
        return new SSEClientTransport(new URL(t.url), {
          requestInit: { headers: t.headers },
        });
    }
  }

  /** Establish the connection if it is not already up. Safe to call concurrently. */
  async connect(): Promise<void> {
    if (this.closed) {
      throw new GatewayError(`upstream "${this.name}" is closed`, 'UPSTREAM_UNAVAILABLE');
    }
    if (this.client) return;
    if (!this.connecting) {
      this.connecting = this.doConnect().finally(() => {
        this.connecting = undefined;
      });
    }
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const transport = this.buildTransport();
    const client = new Client(
      { name: 'mcp-gateway', version: VERSION },
      { capabilities: {} }
    );
    transport.onclose = () => {
      this.logger.warn({ upstream: this.name }, 'upstream transport closed');
      this.client = undefined;
      this.transport = undefined;
      this.setHealthy(false);
    };
    transport.onerror = (err) => {
      this.logger.error({ upstream: this.name, err: err.message }, 'upstream transport error');
    };
    await withTimeout(client.connect(transport), this.config.timeoutMs);
    this.client = client;
    this.transport = transport;
    this.logger.info(
      { upstream: this.name, transport: this.config.transport.type },
      'connected to upstream'
    );
  }

  private async ensureClient(): Promise<Client> {
    if (!this.client) {
      await this.connect();
    }
    if (!this.client) {
      throw new GatewayError(`upstream "${this.name}" is not connected`, 'UPSTREAM_UNAVAILABLE');
    }
    return this.client;
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof CircuitOpenError) return false;
    if (err instanceof GatewayError) return err.code === 'UPSTREAM_TIMEOUT';
    return true;
  }

  /** Run an idempotent operation with retry + breaker + timeout. */
  private async guardedIdempotent<T>(op: string, fn: (client: Client) => Promise<T>): Promise<T> {
    return withRetry(() => this.guardedOnce(op, fn), {
      maxAttempts: this.config.retry.maxAttempts,
      baseDelayMs: this.config.retry.baseDelayMs,
      maxDelayMs: this.config.retry.maxDelayMs,
      jitter: this.config.retry.jitter,
      isRetryable: (err) => this.isRetryable(err),
      onRetry: (attempt, delayMs, err) =>
        this.logger.debug(
          { upstream: this.name, op, attempt, delayMs, err: (err as Error).message },
          'retrying upstream operation'
        ),
    });
  }

  /** Run a single attempt through the circuit breaker with a timeout. */
  private async guardedOnce<T>(op: string, fn: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await this.breaker.execute(async () => {
        const client = await this.ensureClient();
        return withTimeout(fn(client), this.config.timeoutMs);
      });
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        throw new GatewayError(
          `upstream "${this.name}" is unavailable (circuit open)`,
          'UPSTREAM_UNAVAILABLE',
          { retryAfterMs: err.retryAfterMs, op }
        );
      }
      if (err instanceof TimeoutError) {
        throw new GatewayError(
          `upstream "${this.name}" timed out after ${err.timeoutMs}ms`,
          'UPSTREAM_TIMEOUT',
          { op }
        );
      }
      throw err;
    }
  }

  async listTools(): Promise<Tool[]> {
    const res = await this.guardedIdempotent('tools/list', (c) => c.listTools());
    return res.tools;
  }

  async listResources(): Promise<Resource[]> {
    const res = await this.guardedIdempotent('resources/list', (c) => c.listResources());
    return res.resources;
  }

  async callTool(name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    // Single attempt: see class doc for why tool calls are not retried.
    const res = await this.guardedOnce('tools/call', (c) =>
      c.callTool({ name, arguments: args })
    );
    return res as CallToolResult;
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    return this.guardedIdempotent('resources/read', (c) => c.readResource({ uri }));
  }

  /** Lightweight liveness probe; never throws. */
  async healthCheck(): Promise<boolean> {
    const startedAt = Date.now();
    try {
      const client = await this.ensureClient();
      await withTimeout(client.ping(), Math.min(this.config.timeoutMs, 5_000));
      this.lastHealthCheck = {
        at: new Date(startedAt).toISOString(),
        ok: true,
        latencyMs: Date.now() - startedAt,
      };
      this.setHealthy(true);
      return true;
    } catch (err) {
      this.lastHealthCheck = {
        at: new Date(startedAt).toISOString(),
        ok: false,
        error: (err as Error).message,
      };
      this.setHealthy(false);
      return false;
    }
  }

  private setHealthy(healthy: boolean): void {
    if (this.healthy !== healthy) {
      this.healthy = healthy;
      this.events.onHealthChange?.(this.name, healthy);
    }
  }

  get isConnected(): boolean {
    return this.client !== undefined;
  }

  status(): UpstreamStatus {
    return {
      name: this.name,
      transport: this.config.transport.type,
      connected: this.isConnected,
      healthy: this.healthy,
      circuitState: this.breaker.getState(),
      lastHealthCheck: this.lastHealthCheck,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    this.transport = undefined;
    if (client) {
      try {
        await client.close();
      } catch (err) {
        this.logger.debug({ upstream: this.name, err: (err as Error).message }, 'error on close');
      }
    }
  }
}

import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { CircuitState } from '../resilience/circuitBreaker.js';

const CIRCUIT_STATE_VALUE: Record<CircuitState, number> = {
  closed: 0,
  'half-open': 1,
  open: 2,
};

/** Prometheus metrics for the gateway, exposed on the admin server. */
export class Metrics {
  readonly registry: Registry;

  readonly toolCalls: Counter<'tenant' | 'tool' | 'upstream' | 'status'>;
  readonly toolCallDuration: Histogram<'tool' | 'upstream'>;
  readonly rateLimitRejections: Counter<'tenant' | 'scope'>;
  readonly rbacDenials: Counter<'tenant' | 'kind'>;
  readonly authFailures: Counter<'reason'>;
  readonly cacheHits: Counter<'tool'>;
  readonly cacheMisses: Counter<'tool'>;
  readonly upstreamHealthy: Gauge<'upstream'>;
  readonly circuitState: Gauge<'upstream'>;
  readonly activeSessions: Gauge<string>;

  constructor() {
    this.registry = new Registry();
    collectDefaultMetrics({ register: this.registry, prefix: 'mcpgw_' });

    this.toolCalls = new Counter({
      name: 'mcpgw_tool_calls_total',
      help: 'Tool calls processed by the gateway',
      labelNames: ['tenant', 'tool', 'upstream', 'status'] as const,
      registers: [this.registry],
    });
    this.toolCallDuration = new Histogram({
      name: 'mcpgw_tool_call_duration_seconds',
      help: 'End-to-end latency of proxied tool calls',
      labelNames: ['tool', 'upstream'] as const,
      buckets: [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
      registers: [this.registry],
    });
    this.rateLimitRejections = new Counter({
      name: 'mcpgw_ratelimit_rejections_total',
      help: 'Requests rejected by rate limiting or quotas',
      labelNames: ['tenant', 'scope'] as const,
      registers: [this.registry],
    });
    this.rbacDenials = new Counter({
      name: 'mcpgw_rbac_denials_total',
      help: 'Requests denied by RBAC policy',
      labelNames: ['tenant', 'kind'] as const,
      registers: [this.registry],
    });
    this.authFailures = new Counter({
      name: 'mcpgw_auth_failures_total',
      help: 'Requests that failed authentication',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });
    this.cacheHits = new Counter({
      name: 'mcpgw_cache_hits_total',
      help: 'Tool-call result cache hits',
      labelNames: ['tool'] as const,
      registers: [this.registry],
    });
    this.cacheMisses = new Counter({
      name: 'mcpgw_cache_misses_total',
      help: 'Tool-call result cache misses',
      labelNames: ['tool'] as const,
      registers: [this.registry],
    });
    this.upstreamHealthy = new Gauge({
      name: 'mcpgw_upstream_healthy',
      help: 'Upstream health (1 healthy, 0 unhealthy)',
      labelNames: ['upstream'] as const,
      registers: [this.registry],
    });
    this.circuitState = new Gauge({
      name: 'mcpgw_circuit_state',
      help: 'Circuit breaker state (0 closed, 1 half-open, 2 open)',
      labelNames: ['upstream'] as const,
      registers: [this.registry],
    });
    this.activeSessions = new Gauge({
      name: 'mcpgw_active_sessions',
      help: 'Currently active MCP client sessions',
      registers: [this.registry],
    });
  }

  setCircuitState(upstream: string, state: CircuitState): void {
    this.circuitState.set({ upstream }, CIRCUIT_STATE_VALUE[state]);
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }
}

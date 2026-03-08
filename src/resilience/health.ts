import type { UpstreamConnection } from '../routing/upstream.js';
import type { Logger } from '../observability/logger.js';

/**
 * Periodically pings every upstream on its configured interval. Health state
 * feeds the admin API and Prometheus gauges; the circuit breakers react to
 * real traffic on their own, so health checks are observational and also act
 * as a keep-alive that re-establishes dropped connections.
 */
export class HealthMonitor {
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly logger: Logger) {}

  watch(upstreams: UpstreamConnection[]): void {
    this.stop();
    for (const upstream of upstreams) {
      const tick = () => {
        upstream.healthCheck().catch((err: unknown) => {
          this.logger.debug(
            { upstream: upstream.name, err: (err as Error).message },
            'health check error'
          );
        });
      };
      // Prime immediately, then poll.
      tick();
      const timer = setInterval(tick, upstream.config.healthCheckIntervalMs);
      timer.unref();
      this.timers.set(upstream.name, timer);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** Consecutive failures (while closed) that trip the breaker. */
  failureThreshold: number;
  /** Consecutive successes (while half-open) that close the breaker. */
  successThreshold: number;
  /** How long the breaker stays open before allowing probe calls. */
  openDurationMs: number;
  /** Max concurrent probe calls allowed while half-open. */
  halfOpenMaxConcurrent: number;
  /** Injectable clock for tests. */
  now?: () => number;
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitOpenError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`circuit breaker is open, retry in ${retryAfterMs}ms`);
    this.name = 'CircuitOpenError';
  }
}

/**
 * Classic three-state circuit breaker.
 *
 * closed --(failureThreshold consecutive failures)--> open
 * open   --(openDurationMs elapsed)-->                half-open
 * half-open --(successThreshold successes)-->         closed
 * half-open --(any failure)-->                        open
 *
 * While half-open, at most `halfOpenMaxConcurrent` in-flight probes are
 * admitted; everything else is rejected as if the breaker were open. This
 * avoids the thundering-herd race where a burst of concurrent calls all see
 * the half-open state and hammer a barely-recovered upstream at once.
 */
export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private readonly now: () => number;

  constructor(private readonly opts: CircuitBreakerOptions) {
    this.now = opts.now ?? Date.now;
  }

  getState(): CircuitState {
    this.maybeTransitionToHalfOpen();
    return this.state;
  }

  private setState(next: CircuitState): void {
    if (next === this.state) return;
    const prev = this.state;
    this.state = next;
    if (next === 'open') {
      this.openedAt = this.now();
    }
    if (next === 'half-open') {
      this.consecutiveSuccesses = 0;
      this.halfOpenInFlight = 0;
    }
    if (next === 'closed') {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
      this.halfOpenInFlight = 0;
    }
    this.opts.onStateChange?.(prev, next);
  }

  private maybeTransitionToHalfOpen(): void {
    if (this.state === 'open' && this.now() - this.openedAt >= this.opts.openDurationMs) {
      this.setState('half-open');
    }
  }

  /** Reserve an execution slot. Throws CircuitOpenError when calls must be shed. */
  private acquire(): void {
    this.maybeTransitionToHalfOpen();
    if (this.state === 'open') {
      const retryAfterMs = Math.max(0, this.opts.openDurationMs - (this.now() - this.openedAt));
      throw new CircuitOpenError(retryAfterMs);
    }
    if (this.state === 'half-open') {
      if (this.halfOpenInFlight >= this.opts.halfOpenMaxConcurrent) {
        throw new CircuitOpenError(this.opts.openDurationMs);
      }
      this.halfOpenInFlight += 1;
    }
  }

  private onSuccess(wasHalfOpen: boolean): void {
    if (wasHalfOpen) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.consecutiveSuccesses += 1;
      if (this.consecutiveSuccesses >= this.opts.successThreshold) {
        this.setState('closed');
      }
      return;
    }
    this.consecutiveFailures = 0;
  }

  private onFailure(wasHalfOpen: boolean): void {
    if (wasHalfOpen) {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.setState('open');
      return;
    }
    this.consecutiveFailures += 1;
    if (this.state === 'closed' && this.consecutiveFailures >= this.opts.failureThreshold) {
      this.setState('open');
    }
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.acquire();
    const wasHalfOpen = this.state === 'half-open';
    try {
      const result = await fn();
      this.onSuccess(wasHalfOpen);
      return result;
    } catch (err) {
      this.onFailure(wasHalfOpen);
      throw err;
    }
  }
}

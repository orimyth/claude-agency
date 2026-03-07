/**
 * Circuit Breaker for Anthropic API calls.
 *
 * States:
 *   CLOSED  → normal operation, requests flow through
 *   OPEN    → too many failures, all requests rejected immediately
 *   HALF_OPEN → testing if service recovered, allows one probe request
 *
 * Thresholds:
 *   - Opens after `failureThreshold` consecutive failures (default: 5)
 *   - Stays open for `resetTimeoutMs` (default: 60s)
 *   - Half-open allows 1 request; success → closed, failure → open again
 */

export type CircuitState = 'closed' | 'open' | 'half_open';

export class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount = 0;
  private lastFailureAt = 0;
  private failureThreshold: number;
  private resetTimeoutMs: number;
  private onStateChange?: (state: CircuitState) => void;

  constructor(opts: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
    onStateChange?: (state: CircuitState) => void;
  } = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 60_000;
    this.onStateChange = opts.onStateChange;
  }

  /**
   * Check if request should be allowed.
   * Throws if circuit is open.
   */
  canExecute(): boolean {
    if (this.state === 'closed') return true;

    if (this.state === 'open') {
      // Check if reset timeout has elapsed
      if (Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
        this.transition('half_open');
        return true; // Allow probe request
      }
      return false;
    }

    // half_open — allow one probe
    return true;
  }

  /**
   * Record a successful call.
   */
  recordSuccess(): void {
    if (this.state === 'half_open') {
      this.transition('closed');
    }
    this.failureCount = 0;
  }

  /**
   * Record a failed call.
   */
  recordFailure(): void {
    this.failureCount++;
    this.lastFailureAt = Date.now();

    if (this.state === 'half_open') {
      this.transition('open');
      return;
    }

    if (this.failureCount >= this.failureThreshold) {
      this.transition('open');
    }
  }

  getState(): CircuitState {
    // Auto-transition from open to half_open if timeout elapsed
    if (this.state === 'open' && Date.now() - this.lastFailureAt >= this.resetTimeoutMs) {
      this.transition('half_open');
    }
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  reset(): void {
    this.failureCount = 0;
    this.lastFailureAt = 0;
    this.transition('closed');
  }

  private transition(newState: CircuitState): void {
    if (this.state === newState) return;
    const old = this.state;
    this.state = newState;
    if (newState === 'closed') this.failureCount = 0;
    this.onStateChange?.(newState);
    console.log(`[CircuitBreaker] ${old} → ${newState} (failures: ${this.failureCount})`);
  }
}

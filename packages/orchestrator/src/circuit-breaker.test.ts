import { describe, it, expect, vi } from 'vitest';
import { CircuitBreaker } from './circuit-breaker.js';

describe('CircuitBreaker', () => {
  it('starts in closed state', () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe('closed');
    expect(cb.canExecute()).toBe(true);
  });

  it('stays closed on success', () => {
    const cb = new CircuitBreaker();
    cb.recordSuccess();
    expect(cb.getState()).toBe('closed');
  });

  it('opens after threshold failures', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
  });

  it('rejects requests when open', () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canExecute()).toBe(false);
  });

  it('transitions to half_open after timeout', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');

    // Manually advance time concept by checking after delay
    vi.useFakeTimers();
    vi.advanceTimersByTime(150);
    expect(cb.getState()).toBe('half_open');
    expect(cb.canExecute()).toBe(true);
    vi.useRealTimers();
  });

  it('closes on success in half_open', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 0 });
    cb.recordFailure(); // → open
    // With resetTimeoutMs=0, canExecute triggers half_open immediately
    cb.canExecute(); // → half_open
    cb.recordSuccess(); // → closed
    expect(cb.getState()).toBe('closed');
  });

  it('reopens on failure in half_open', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    cb.recordFailure(); // → open

    // Manually force half_open by advancing time
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);
    cb.canExecute(); // → half_open
    cb.recordFailure(); // → open again
    // Don't use getState() as it auto-transitions with elapsed time;
    // instead check canExecute which returns false when open
    expect(cb.canExecute()).toBe(false);
    vi.useRealTimers();
  });

  it('resets failure count on success', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.getFailureCount()).toBe(0);
    // Should need 3 more failures to open
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.getState()).toBe('closed');
  });

  it('calls onStateChange callback', () => {
    const onChange = vi.fn();
    const cb = new CircuitBreaker({ failureThreshold: 1, onStateChange: onChange });
    cb.recordFailure();
    expect(onChange).toHaveBeenCalledWith('open');
  });

  it('reset() returns to closed', () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    expect(cb.getState()).toBe('open');
    cb.reset();
    expect(cb.getState()).toBe('closed');
    expect(cb.getFailureCount()).toBe(0);
  });
});

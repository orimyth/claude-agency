import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatCheckFailures, type MechanicalCheckResult } from './verification.js';

// We can't easily test runMechanicalChecks without a real project dir,
// but we can test the formatting and result handling logic.

function makeResult(overrides: Partial<MechanicalCheckResult> = {}): MechanicalCheckResult {
  return {
    build: { passed: true, output: 'Build succeeded', duration_ms: 1000 },
    tests: { passed: true, output: 'All tests passed', duration_ms: 2000 },
    lint: { passed: true, output: 'No lint errors', duration_ms: 500 },
    typecheck: { passed: true, output: 'No type errors', duration_ms: 800 },
    allPassed: true,
    ...overrides,
  };
}

describe('formatCheckFailures', () => {
  it('formats single failure', () => {
    const result = makeResult({
      build: { passed: false, output: 'Error: cannot find module', duration_ms: 1000 },
      allPassed: false,
    });
    const formatted = formatCheckFailures(result);
    expect(formatted).toContain('BUILD FAILED');
    expect(formatted).toContain('cannot find module');
    expect(formatted).not.toContain('TESTS FAILED');
    expect(formatted).not.toContain('LINT FAILED');
  });

  it('formats multiple failures', () => {
    const result = makeResult({
      build: { passed: false, output: 'Build error', duration_ms: 1000 },
      tests: { passed: false, output: 'Test error', duration_ms: 2000 },
      allPassed: false,
    });
    const formatted = formatCheckFailures(result);
    expect(formatted).toContain('BUILD FAILED');
    expect(formatted).toContain('TESTS FAILED');
    expect(formatted).not.toContain('LINT FAILED');
    expect(formatted).not.toContain('TYPECHECK FAILED');
  });

  it('formats all failures', () => {
    const result: MechanicalCheckResult = {
      build: { passed: false, output: 'build err', duration_ms: 100 },
      tests: { passed: false, output: 'test err', duration_ms: 100 },
      lint: { passed: false, output: 'lint err', duration_ms: 100 },
      typecheck: { passed: false, output: 'type err', duration_ms: 100 },
      allPassed: false,
    };
    const formatted = formatCheckFailures(result);
    expect(formatted).toContain('BUILD FAILED');
    expect(formatted).toContain('TESTS FAILED');
    expect(formatted).toContain('LINT FAILED');
    expect(formatted).toContain('TYPECHECK FAILED');
  });

  it('includes header text', () => {
    const result = makeResult({
      lint: { passed: false, output: 'Lint issue', duration_ms: 100 },
      allPassed: false,
    });
    const formatted = formatCheckFailures(result);
    expect(formatted).toContain('Mechanical checks failed');
    expect(formatted).toContain('Fix these issues');
  });
});

describe('MechanicalCheckResult', () => {
  it('allPassed is true when all checks pass', () => {
    const result = makeResult();
    expect(result.allPassed).toBe(true);
  });

  it('allPassed is false when any check fails', () => {
    const result = makeResult({
      lint: { passed: false, output: 'error', duration_ms: 100 },
      allPassed: false,
    });
    expect(result.allPassed).toBe(false);
  });
});

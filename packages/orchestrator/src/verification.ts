import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

export interface CheckResult {
  passed: boolean;
  output: string;
  duration_ms: number;
}

export interface MechanicalCheckResult {
  build: CheckResult;
  tests: CheckResult;
  lint: CheckResult;
  typecheck: CheckResult;
  allPassed: boolean;
}

/**
 * Run mechanical checks (build, test, lint, typecheck) on a working directory.
 * These are zero-LLM-cost checks run by the orchestrator process.
 */
export async function runMechanicalChecks(workDir: string): Promise<MechanicalCheckResult> {
  // Detect available scripts from package.json
  let scripts: Record<string, string> = {};
  const pkgPath = resolve(workDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
      scripts = pkg.scripts ?? {};
    } catch { /* malformed package.json */ }
  }

  // Run checks in parallel
  const [build, tests, lint, typecheck] = await Promise.all([
    runCheck(workDir, detectBuildCommand(scripts), 'build', 120000),
    runCheck(workDir, detectTestCommand(scripts), 'test', 180000),
    runCheck(workDir, detectLintCommand(scripts), 'lint', 60000),
    runCheck(workDir, detectTypecheckCommand(scripts), 'typecheck', 60000),
  ]);

  return {
    build,
    tests,
    lint,
    typecheck,
    allPassed: build.passed && tests.passed && lint.passed && typecheck.passed,
  };
}

/**
 * Format check failures into a human-readable string for the agent.
 */
export function formatCheckFailures(result: MechanicalCheckResult): string {
  const failures: string[] = [];

  if (!result.build.passed) {
    failures.push(`BUILD FAILED:\n${result.build.output}`);
  }
  if (!result.tests.passed) {
    failures.push(`TESTS FAILED:\n${result.tests.output}`);
  }
  if (!result.lint.passed) {
    failures.push(`LINT FAILED:\n${result.lint.output}`);
  }
  if (!result.typecheck.passed) {
    failures.push(`TYPECHECK FAILED:\n${result.typecheck.output}`);
  }

  return `Mechanical checks failed. Fix these issues:\n\n${failures.join('\n\n')}`;
}

async function runCheck(
  cwd: string,
  command: string | null,
  name: string,
  timeoutMs: number,
): Promise<CheckResult> {
  if (!command) {
    return { passed: true, output: `skipped (no ${name} script)`, duration_ms: 0 };
  }

  const start = Date.now();
  try {
    const output = execSync(command, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: 'true', NODE_ENV: 'test' },
    });
    return {
      passed: true,
      output: truncateOutput(output),
      duration_ms: Date.now() - start,
    };
  } catch (err: any) {
    const output = [err.stdout, err.stderr, err.message]
      .filter(Boolean)
      .join('\n');
    return {
      passed: false,
      output: truncateOutput(output),
      duration_ms: Date.now() - start,
    };
  }
}

function detectBuildCommand(scripts: Record<string, string>): string | null {
  if (scripts.build) return 'npm run build';
  return null;
}

function detectTestCommand(scripts: Record<string, string>): string | null {
  if (scripts.test && scripts.test !== 'echo "Error: no test specified" && exit 1') {
    return 'npm test';
  }
  return null;
}

function detectLintCommand(scripts: Record<string, string>): string | null {
  if (scripts.lint) return 'npm run lint';
  return null;
}

function detectTypecheckCommand(scripts: Record<string, string>): string | null {
  if (scripts.typecheck) return 'npm run typecheck';
  // Fallback: check if tsconfig.json exists
  // Don't auto-run tsc if there's already a build script (it might include tsc)
  return null;
}

function truncateOutput(output: string): string {
  const maxLen = 3000;
  if (output.length <= maxLen) return output;
  return '...(truncated)\n' + output.slice(-maxLen);
}

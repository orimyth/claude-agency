import { execSync } from 'child_process';

/**
 * Shared git environment for all git operations.
 * Ensures credential helpers (osxkeychain) and git internals are found
 * even when running from pnpm/node context with limited PATH.
 */

function buildGitEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Discover GIT_EXEC_PATH so git can find credential helpers
  try {
    const execPath = execSync('git --exec-path', { encoding: 'utf-8', timeout: 5000 }).trim();
    if (execPath) {
      env['GIT_EXEC_PATH'] = execPath;
      // Also add to PATH so git-credential-osxkeychain etc. are found
      env['PATH'] = `${execPath}:${env['PATH'] ?? ''}`;
    }
  } catch { /* fallback to existing env */ }

  // Common paths that may contain git helpers
  const extraPaths = [
    '/Library/Developer/CommandLineTools/usr/libexec/git-core',
    '/opt/homebrew/libexec/git-core',
    '/usr/local/libexec/git-core',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ];
  env['PATH'] = `${extraPaths.join(':')}:${env['PATH'] ?? ''}`;

  // Never prompt for credentials interactively — fail fast instead of hanging
  env['GIT_TERMINAL_PROMPT'] = '0';

  return env;
}

/** Pre-built git environment — reuse across all git calls */
export const gitEnv = buildGitEnv();

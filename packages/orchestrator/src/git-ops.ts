import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { ProjectRepository } from './types.js';

export interface WorktreeInfo {
  path: string;
  branch: string;
  taskId: string;
}

export interface MergeResult {
  success: boolean;
  merged: boolean;
  conflicted: boolean;
  error?: string;
  conflictFiles?: string[];
}

export interface VerifyMainResult {
  buildPassed: boolean;
  error?: string;
}

/**
 * Git operations module.
 * Handles worktree creation/cleanup, branch management, merge flow, and rollback.
 */
export class GitOps {
  /**
   * Create an isolated worktree for a task.
   * Each task gets its own working directory branched from main.
   */
  async createTaskWorktree(
    repo: ProjectRepository,
    taskId: string,
    agentId: string,
  ): Promise<WorktreeInfo> {
    const shortId = taskId.slice(0, 8);
    const branchName = `feature/${agentId}/${shortId}`;
    const worktreeDir = resolve(dirname(repo.localPath), '.worktrees', shortId);

    if (!existsSync(repo.localPath)) {
      throw new Error(`Main repo clone not found at ${repo.localPath}`);
    }

    // Ensure worktrees parent directory exists
    const worktreeParent = dirname(worktreeDir);
    if (!existsSync(worktreeParent)) {
      mkdirSync(worktreeParent, { recursive: true });
    }

    // If worktree already exists (retry scenario), reuse it
    if (existsSync(worktreeDir)) {
      return { path: worktreeDir, branch: branchName, taskId };
    }

    // Fetch latest from origin
    try {
      execSync(`git -C "${repo.localPath}" fetch origin`, {
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch {
      // Fetch failure is non-fatal — we'll branch from local main
    }

    // Determine base: origin/main if available, else local main
    const mainBranch = repo.defaultBranch || 'main';
    let base = `origin/${mainBranch}`;
    try {
      execSync(`git -C "${repo.localPath}" rev-parse ${base}`, {
        timeout: 5000,
        stdio: 'pipe',
      });
    } catch {
      base = mainBranch;
    }

    // Create worktree with new branch
    execSync(
      `git -C "${repo.localPath}" worktree add -b "${branchName}" "${worktreeDir}" ${base}`,
      { timeout: 30000, stdio: 'pipe' },
    );

    // Install dependencies if package.json exists
    if (existsSync(resolve(worktreeDir, 'package.json'))) {
      try {
        execSync('npm install --prefer-offline', {
          cwd: worktreeDir,
          timeout: 120000,
          stdio: 'pipe',
        });
      } catch {
        // Non-fatal — agent can install if needed
      }
    }

    return { path: worktreeDir, branch: branchName, taskId };
  }

  /**
   * Clean up a worktree after task completion + merge.
   */
  async cleanupWorktree(repo: ProjectRepository, taskId: string): Promise<void> {
    const shortId = taskId.slice(0, 8);
    const worktreeDir = resolve(dirname(repo.localPath), '.worktrees', shortId);

    if (!existsSync(worktreeDir)) return;

    try {
      execSync(`git -C "${repo.localPath}" worktree remove "${worktreeDir}" --force`, {
        timeout: 15000,
        stdio: 'pipe',
      });
    } catch {
      // If worktree remove fails, try manual cleanup
      try {
        execSync(`rm -rf "${worktreeDir}"`, { timeout: 10000, stdio: 'pipe' });
        execSync(`git -C "${repo.localPath}" worktree prune`, {
          timeout: 10000,
          stdio: 'pipe',
        });
      } catch {
        // Best effort — log but don't fail
      }
    }
  }

  /**
   * Commit and push changes from a worktree to its feature branch.
   */
  async commitAndPush(
    worktreeDir: string,
    commitMessage: string,
  ): Promise<{ pushed: boolean; branch: string; noChanges: boolean }> {
    // Stage all changes
    execSync(`git -C "${worktreeDir}" add -A`, { timeout: 30000, stdio: 'pipe' });

    // Check for changes
    const status = execSync(`git -C "${worktreeDir}" status --porcelain`, {
      timeout: 10000,
      encoding: 'utf-8',
    }).trim();

    if (!status) {
      const branch = execSync(`git -C "${worktreeDir}" branch --show-current`, {
        timeout: 5000,
        encoding: 'utf-8',
      }).trim();
      return { pushed: false, branch, noChanges: true };
    }

    // Commit
    const safeMsg = commitMessage.replace(/"/g, '\\"');
    execSync(`git -C "${worktreeDir}" commit -m "${safeMsg}"`, {
      timeout: 30000,
      stdio: 'pipe',
    });

    // Get branch name
    const branch = execSync(`git -C "${worktreeDir}" branch --show-current`, {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();

    // Push
    execSync(`git -C "${worktreeDir}" push -u origin "${branch}"`, {
      timeout: 60000,
      stdio: 'pipe',
    });

    return { pushed: true, branch, noChanges: false };
  }

  /**
   * Merge a feature branch into main via squash merge.
   * Returns success/failure and handles conflicts.
   */
  async mergeToMain(repo: ProjectRepository, featureBranch: string): Promise<MergeResult> {
    const cwd = repo.localPath;
    const mainBranch = repo.defaultBranch || 'main';

    try {
      // Switch to main and pull latest
      execSync(`git -C "${cwd}" checkout "${mainBranch}"`, { timeout: 10000, stdio: 'pipe' });
      execSync(`git -C "${cwd}" pull origin "${mainBranch}"`, { timeout: 30000, stdio: 'pipe' });

      // Squash merge the feature branch
      execSync(`git -C "${cwd}" merge --squash "${featureBranch}"`, {
        timeout: 30000,
        stdio: 'pipe',
      });

      // Commit the squash
      const commitMsg = `Merge ${featureBranch} (squash)`;
      execSync(`git -C "${cwd}" commit -m "${commitMsg}"`, {
        timeout: 30000,
        stdio: 'pipe',
      });

      // Push to main
      execSync(`git -C "${cwd}" push origin "${mainBranch}"`, {
        timeout: 60000,
        stdio: 'pipe',
      });

      return { success: true, merged: true, conflicted: false };
    } catch (err: any) {
      const errMsg = err.stderr?.toString() ?? err.message;

      // Check for merge conflicts
      if (errMsg.includes('CONFLICT') || errMsg.includes('Automatic merge failed')) {
        // Get conflicted files
        let conflictFiles: string[] = [];
        try {
          const conflictOutput = execSync(
            `git -C "${cwd}" diff --name-only --diff-filter=U`,
            { timeout: 10000, encoding: 'utf-8' },
          ).trim();
          conflictFiles = conflictOutput.split('\n').filter(Boolean);
        } catch { /* ignore */ }

        // Abort the merge
        try {
          execSync(`git -C "${cwd}" merge --abort`, { timeout: 10000, stdio: 'pipe' });
        } catch { /* ignore */ }

        return { success: false, merged: false, conflicted: true, conflictFiles, error: errMsg };
      }

      return { success: false, merged: false, conflicted: false, error: errMsg };
    }
  }

  /**
   * Run post-merge verification on main.
   * If checks fail, auto-revert the last merge commit.
   */
  async verifyAndRollbackIfNeeded(
    repo: ProjectRepository,
    runChecks: (cwd: string) => Promise<{ passed: boolean; error?: string }>,
  ): Promise<{ verified: boolean; rolledBack: boolean; error?: string }> {
    const cwd = repo.localPath;
    const mainBranch = repo.defaultBranch || 'main';

    // Ensure we're on main
    const currentBranch = execSync(`git -C "${cwd}" branch --show-current`, {
      timeout: 5000,
      encoding: 'utf-8',
    }).trim();

    if (currentBranch !== mainBranch) {
      return { verified: false, rolledBack: false, error: `Not on ${mainBranch} branch` };
    }

    const result = await runChecks(cwd);
    if (result.passed) {
      return { verified: true, rolledBack: false };
    }

    // Checks failed — revert the last commit
    try {
      execSync(`git -C "${cwd}" revert HEAD --no-edit`, { timeout: 30000, stdio: 'pipe' });
      execSync(`git -C "${cwd}" push origin "${mainBranch}"`, { timeout: 60000, stdio: 'pipe' });
      return { verified: false, rolledBack: true, error: result.error };
    } catch (revertErr: any) {
      return {
        verified: false,
        rolledBack: false,
        error: `Checks failed AND revert failed: ${revertErr.message}. Original error: ${result.error}`,
      };
    }
  }

  /**
   * Delete a feature branch (local + remote) after successful merge.
   */
  async deleteFeatureBranch(repo: ProjectRepository, branchName: string): Promise<void> {
    const cwd = repo.localPath;
    try {
      execSync(`git -C "${cwd}" branch -D "${branchName}"`, { timeout: 10000, stdio: 'pipe' });
    } catch { /* branch may not exist locally */ }
    try {
      execSync(`git -C "${cwd}" push origin --delete "${branchName}"`, {
        timeout: 30000,
        stdio: 'pipe',
      });
    } catch { /* remote branch may not exist */ }
  }

  /**
   * Get the diff of a worktree compared to its base (for review).
   */
  async getWorktreeDiff(worktreeDir: string): Promise<string> {
    try {
      // Diff against the merge base with main
      const diff = execSync(`git -C "${worktreeDir}" diff origin/main...HEAD`, {
        timeout: 30000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 5, // 5MB
      });
      return diff;
    } catch {
      // Fallback: diff against HEAD~1
      try {
        return execSync(`git -C "${worktreeDir}" diff HEAD~1`, {
          timeout: 30000,
          encoding: 'utf-8',
          maxBuffer: 1024 * 1024 * 5,
        });
      } catch {
        return '';
      }
    }
  }

  /**
   * Get list of files changed in a worktree.
   */
  async getChangedFiles(worktreeDir: string): Promise<string[]> {
    try {
      const output = execSync(`git -C "${worktreeDir}" diff --name-only origin/main...HEAD`, {
        timeout: 10000,
        encoding: 'utf-8',
      }).trim();
      return output ? output.split('\n') : [];
    } catch {
      return [];
    }
  }
}

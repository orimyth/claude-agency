import type { ProjectRepository, Task } from "./api";

export interface TaskBranchInfo {
  taskId: string;
  branchName: string;
  repoName: string;
  repoUrl: string;
  branchUrl: string | null;
  prUrl: string | null;
  isActive: boolean; // true if this branch is currently checked out
}

/**
 * Derive branch info for a task from project repositories.
 * Branches follow the `feature/{taskId}` naming convention.
 */
export function getTaskBranch(
  task: Task,
  repositories: ProjectRepository[]
): TaskBranchInfo | null {
  if (!repositories.length) return null;

  const branchName = `feature/${task.id}`;

  // Check if any repo currently has this branch checked out
  for (const repo of repositories) {
    if (repo.currentBranch === branchName) {
      return {
        taskId: task.id,
        branchName,
        repoName: repo.repoName,
        repoUrl: repo.repoUrl,
        branchUrl: buildGitHubUrl(repo.repoUrl, "tree", branchName),
        prUrl: buildGitHubUrl(repo.repoUrl, "compare", branchName),
        isActive: true,
      };
    }
  }

  // For in-progress/review tasks, infer the branch even if not currently checked out
  if (
    task.status === "in_progress" ||
    task.status === "review" ||
    task.status === "done"
  ) {
    const repo = repositories[0]; // use primary repo
    return {
      taskId: task.id,
      branchName,
      repoName: repo.repoName,
      repoUrl: repo.repoUrl,
      branchUrl: buildGitHubUrl(repo.repoUrl, "tree", branchName),
      prUrl: buildGitHubUrl(repo.repoUrl, "compare", branchName),
      isActive: false,
    };
  }

  return null;
}

/**
 * Build a GitHub URL for a branch (tree or compare view).
 * Returns null for non-GitHub repos.
 */
function buildGitHubUrl(
  repoUrl: string,
  action: "tree" | "compare",
  branchName: string
): string | null {
  if (!repoUrl.includes("github.com")) return null;

  // Normalize URL: remove .git suffix and trailing slashes
  let base = repoUrl.replace(/\.git$/, "").replace(/\/+$/, "");

  // Convert SSH URLs to HTTPS
  if (base.startsWith("git@github.com:")) {
    base = base.replace("git@github.com:", "https://github.com/");
  }

  return `${base}/${action}/${branchName}`;
}

/**
 * Map all tasks to their branch info given a set of repositories.
 */
export function mapTaskBranches(
  tasks: Task[],
  repositories: ProjectRepository[]
): Map<string, TaskBranchInfo> {
  const map = new Map<string, TaskBranchInfo>();
  for (const task of tasks) {
    const info = getTaskBranch(task, repositories);
    if (info) map.set(task.id, info);
  }
  return map;
}

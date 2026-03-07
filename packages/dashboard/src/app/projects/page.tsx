"use client";

import { useState, useEffect } from "react";
import { fetchProjects, fetchProject } from "@/lib/api";
import { EmptyState } from "@/components/empty-state";
import { SkeletonLine } from "@/components/skeleton";
import { projectStyle, taskStyle } from "@/lib/status-colors";
import { getTaskBranch, type TaskBranchInfo } from "@/lib/branch-utils";
import type { Project, ProjectRepository, Task } from "@/lib/api";

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

// ---------------------------------------------------------------------------
// Segmented progress bar — shows colored segments per status
// ---------------------------------------------------------------------------
function SegmentedProgress({
  counts,
  total,
}: {
  counts: NonNullable<Project["taskCounts"]>;
  total: number;
}) {
  if (total === 0) return null;

  const segments = [
    { count: counts.done, color: "bg-emerald-500", label: "Done" },
    { count: counts.review, color: "bg-purple-500", label: "Review" },
    { count: counts.in_progress, color: "bg-blue-500", label: "In Progress" },
    { count: counts.assigned, color: "bg-amber-400", label: "Assigned" },
    { count: counts.blocked, color: "bg-red-500", label: "Blocked" },
    { count: counts.backlog, color: "bg-gray-300", label: "Backlog" },
  ].filter((s) => s.count > 0);

  return (
    <div>
      <div className="flex rounded-full h-2 overflow-hidden bg-gray-100">
        {segments.map((seg) => (
          <div
            key={seg.label}
            className={`${seg.color} transition-all duration-500`}
            style={{ width: `${(seg.count / total) * 100}%`, animation: "progressGrow 0.6s ease-out" }}
            title={`${seg.label}: ${seg.count}`}
          />
        ))}
      </div>
      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
        {segments.map((seg) => (
          <span key={seg.label} className="flex items-center gap-1 text-xs text-gray-500">
            <span className={`w-2 h-2 rounded-full ${seg.color}`} />
            {seg.count} {seg.label.toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Repo card
// ---------------------------------------------------------------------------
function RepoCard({ repo }: { repo: ProjectRepository }) {
  const isCloned = !!repo.localPath;

  return (
    <div className="border border-gray-100 dark:border-gray-700 rounded-lg p-3.5 bg-gray-50 dark:bg-gray-800 hover:bg-gray-100/50 dark:hover:bg-gray-700/50 transition-colors">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">{repo.repoName}</span>
        </div>
        <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
          isCloned ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800" : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 border border-gray-200 dark:border-gray-600"
        }`}>
          {isCloned ? "Cloned" : "Not Cloned"}
        </span>
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-500 dark:text-gray-400">
        {(repo.currentBranch || repo.defaultBranch) && (
          <span className="inline-flex items-center gap-1 font-mono bg-white dark:bg-gray-700 px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-600">
            <svg className="w-3 h-3 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            {repo.currentBranch || repo.defaultBranch}
          </span>
        )}
        {repo.lastSyncedAt && (
          <span>Synced {timeAgo(repo.lastSyncedAt)}</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Project Detail View
// ---------------------------------------------------------------------------
function ProjectDetail({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchProject(projectId)
      .then(setProject)
      .catch(() => {})
      .finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchProject(projectId).then(setProject).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [projectId]);

  if (loading || !project) {
    return (
      <div className="max-w-6xl mx-auto">
        <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-800 mb-4 flex items-center gap-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Back to Projects
        </button>
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-6 animate-pulse space-y-4">
          <SkeletonLine className="h-6 w-48" />
          <SkeletonLine className="h-4 w-full" />
          <SkeletonLine className="h-2 w-full" />
        </div>
      </div>
    );
  }

  const tasks = project.tasks ?? [];
  const repos = project.repositories ?? [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const pStyle = projectStyle(project.status);

  return (
    <div className="max-w-6xl mx-auto space-y-5" style={{ animation: "fadeSlideIn 0.25s ease-out" }}>
      <button onClick={onBack} className="text-sm text-gray-500 hover:text-gray-900 flex items-center gap-1 transition-colors">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        Back to Projects
      </button>

      {/* Project header */}
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-6">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-xl font-bold text-gray-900 dark:text-white">{project.name}</h1>
          <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${pStyle.bg} ${pStyle.text}`}>
            {pStyle.label}
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{project.description}</p>
        {total > 0 && (
          <div>
            <div className="flex justify-between text-xs text-gray-400 mb-1.5">
              <span>{done}/{total} tasks completed</span>
              <span className="font-medium text-gray-600">{progress}%</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2.5">
              <div
                className="bg-emerald-500 h-2.5 rounded-full transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Repositories */}
      {repos.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-3">
            Repositories <span className="text-gray-400 font-normal">({repos.length})</span>
          </h2>
          <div className="space-y-2.5">
            {repos.map((repo) => (
              <RepoCard key={repo.id} repo={repo} />
            ))}
          </div>
        </div>
      )}

      {/* Tasks */}
      {tasks.length > 0 && (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-6">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-3">
            Tasks <span className="text-gray-400 font-normal">({tasks.length})</span>
          </h2>
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {tasks.map((task) => {
              const dep = task.dependsOn ? taskMap.get(task.dependsOn) : null;
              const isWaiting = dep && dep.status !== "done";
              const style = taskStyle(task.status);
              const branch = getTaskBranch(task, repos);

              return (
                <div
                  key={task.id}
                  className={`py-2.5 flex items-center justify-between ${isWaiting ? "opacity-50" : ""}`}
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-gray-900 dark:text-gray-200 truncate">{task.title || task.id}</p>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {task.assignedTo && (
                        <p className="text-xs text-gray-400">{task.assignedTo}</p>
                      )}
                      {branch && (
                        <span className="inline-flex items-center gap-1.5">
                          <a
                            href={branch.branchUrl ?? "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-[10px] font-mono text-gray-600 dark:text-gray-300 transition-colors max-w-[180px]"
                            title={branch.branchName}
                          >
                            <svg className="w-3 h-3 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                            </svg>
                            <span className="truncate">{branch.branchName}</span>
                            {branch.isActive && (
                              <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" title="Active" />
                            )}
                          </a>
                          {branch.prUrl && (
                            <a
                              href={branch.prUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/30 hover:bg-purple-100 dark:hover:bg-purple-900/50 text-[10px] font-medium text-purple-600 dark:text-purple-400 transition-colors"
                              title="Open PR / Compare"
                            >
                              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                              </svg>
                              PR
                            </a>
                          )}
                        </span>
                      )}
                      {isWaiting && dep && (
                        <span className="text-xs text-amber-600 flex items-center gap-1">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
                          </svg>
                          Waiting: {dep.title || dep.id}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className={`ml-3 px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${style.bg} ${style.text}`}>
                    {style.label}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Projects List
// ---------------------------------------------------------------------------
export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchProjects()
      .then((data) => setProjects(Array.isArray(data) ? data : []))
      .catch(() => {})
      .finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchProjects()
        .then((data) => setProjects(Array.isArray(data) ? data : []))
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  if (selectedProject) {
    return (
      <ProjectDetail
        projectId={selectedProject}
        onBack={() => setSelectedProject(null)}
      />
    );
  }

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Projects</h1>
          <p className="text-sm text-gray-500 mt-1">{projects.length} projects</p>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-6 animate-pulse space-y-3">
              <SkeletonLine className="h-5 w-32" />
              <SkeletonLine className="h-4 w-full" />
              <SkeletonLine className="h-2 w-full" />
              <div className="flex gap-2">
                <SkeletonLine className="h-5 w-20" />
                <SkeletonLine className="h-5 w-20" />
              </div>
            </div>
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
          <EmptyState
            icon="inbox"
            title="No projects yet"
            description="Projects are created when the CEO decides an idea needs a dedicated workspace."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((project) => {
            const total = project.taskCount ?? 0;
            const done = project.taskCounts?.done ?? 0;
            const progress = total > 0 ? Math.round((done / total) * 100) : 0;
            const repos = project.repositories ?? [];
            const pStyle = projectStyle(project.status);

            return (
              <div
                key={project.id}
                onClick={() => setSelectedProject(project.id)}
                className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-5 hover:shadow-md transition-all duration-200 cursor-pointer group"
              >
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 transition-colors">{project.name}</h3>
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${pStyle.bg} ${pStyle.text}`}>
                    {pStyle.label}
                  </span>
                </div>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-3 line-clamp-2">{project.description}</p>

                {/* Repos */}
                {repos.length > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <svg className="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                    {repos.map((r) => (
                      <span key={r.id} className="text-xs font-mono text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded border border-gray-200">
                        {r.repoName}
                      </span>
                    ))}
                  </div>
                )}

                {/* Progress */}
                {total > 0 && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-gray-400">
                      <span>{done}/{total} tasks</span>
                      <span className="font-medium text-gray-600">{progress}%</span>
                    </div>
                    {project.taskCounts ? (
                      <SegmentedProgress counts={project.taskCounts} total={total} />
                    ) : (
                      <div className="w-full bg-gray-100 rounded-full h-2">
                        <div
                          className="bg-emerald-500 h-2 rounded-full transition-all duration-500"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

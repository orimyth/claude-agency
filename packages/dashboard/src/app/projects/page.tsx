"use client";

import { useState, useEffect } from "react";
import { fetchProjects, fetchProject } from "@/lib/api";
import type { Project, ProjectRepository, Task } from "@/lib/api";

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const diff = Date.now() - new Date(dateStr).getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function RepoCard({ repo }: { repo: ProjectRepository }) {
  const isCloned = !!repo.localPath;
  const isSynced = !!repo.lastSyncedAt;

  return (
    <div className="border border-gray-100 rounded-lg p-4 bg-gray-50">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
          </svg>
          <span className="text-sm font-medium text-gray-900">{repo.repoName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
            isCloned ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"
          }`}>
            {isCloned ? "Cloned" : "Not Cloned"}
          </span>
          {isSynced && (
            <span className="px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-700">
              Synced
            </span>
          )}
        </div>
      </div>
      <div className="space-y-1 text-xs text-gray-500">
        {repo.repoUrl && (
          <p className="truncate">
            <span className="text-gray-400">URL:</span>{" "}
            <span className="font-mono">{repo.repoUrl}</span>
          </p>
        )}
        {repo.localPath && (
          <p className="truncate">
            <span className="text-gray-400">Path:</span>{" "}
            <span className="font-mono">{repo.localPath}</span>
          </p>
        )}
        <div className="flex items-center gap-4 mt-1">
          {repo.currentBranch && (
            <span className="inline-flex items-center gap-1">
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
              <span className="font-mono">{repo.currentBranch}</span>
            </span>
          )}
          {!repo.currentBranch && repo.defaultBranch && (
            <span className="inline-flex items-center gap-1">
              <span className="text-gray-400">Branch:</span>{" "}
              <span className="font-mono">{repo.defaultBranch}</span>
            </span>
          )}
          {repo.lastSyncedAt && (
            <span>
              <span className="text-gray-400">Last sync:</span> {timeAgo(repo.lastSyncedAt)}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectDetail({
  projectId,
  onBack,
}: {
  projectId: string;
  onBack: () => void;
}) {
  const [project, setProject] = useState<Project | null>(null);

  useEffect(() => {
    fetchProject(projectId)
      .then(setProject)
      .catch(() => {});

    const interval = setInterval(() => {
      fetchProject(projectId).then(setProject).catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, [projectId]);

  if (!project) {
    return (
      <div className="max-w-6xl mx-auto">
        <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-800 mb-4">
          &larr; Back to Projects
        </button>
        <p className="text-gray-500">Loading project...</p>
      </div>
    );
  }

  const tasks = project.tasks ?? [];
  const repos = project.repositories ?? [];
  const total = tasks.length;
  const done = tasks.filter((t) => t.status === "done").length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  // Build task dependency map
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <button onClick={onBack} className="text-sm text-blue-600 hover:text-blue-800">
        &larr; Back to Projects
      </button>

      {/* Project header */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-xl font-bold text-gray-900">{project.name}</h1>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
            project.status === "active" ? "bg-green-100 text-green-700" :
            project.status === "paused" ? "bg-yellow-100 text-yellow-700" :
            project.status === "completed" ? "bg-blue-100 text-blue-700" :
            "bg-gray-100 text-gray-600"
          }`}>
            {project.status}
          </span>
        </div>
        <p className="text-sm text-gray-500 mb-4">{project.description}</p>
        {total > 0 && (
          <div>
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>{done}/{total} tasks completed</span>
              <span>{progress}%</span>
            </div>
            <div className="w-full bg-gray-100 rounded-full h-2">
              <div
                className="bg-blue-500 h-2 rounded-full transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* Repositories */}
      {repos.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">
            Repositories ({repos.length})
          </h2>
          <div className="space-y-3">
            {repos.map((repo) => (
              <RepoCard key={repo.id} repo={repo} />
            ))}
          </div>
        </div>
      )}

      {/* Tasks with dependencies */}
      {tasks.length > 0 && (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
          <h2 className="font-semibold text-gray-900 mb-4">
            Tasks ({tasks.length})
          </h2>
          <div className="divide-y divide-gray-50">
            {tasks.map((task) => {
              const dep = task.dependsOn ? taskMap.get(task.dependsOn) : null;
              const isWaiting = dep && dep.status !== "done";

              // Check for QA pipeline
              const qaChild = tasks.find(
                (t) => t.dependsOn === task.id && /qa|review|quality/i.test(t.title)
              );
              const fixChild = qaChild
                ? tasks.find(
                    (t) => t.dependsOn === qaChild.id && /fix|bug|patch/i.test(t.title)
                  )
                : null;

              let qaLabel = "";
              let qaColor = "";
              if (qaChild) {
                if (fixChild && (fixChild.status === "in_progress" || fixChild.status === "assigned")) {
                  qaLabel = "QA Failed - Fix in Progress";
                  qaColor = "bg-red-100 text-red-700";
                } else if (qaChild.status === "done") {
                  qaLabel = "QA Passed";
                  qaColor = "bg-green-100 text-green-700";
                } else if (qaChild.status === "in_progress" || qaChild.status === "assigned" || qaChild.status === "review") {
                  qaLabel = "In QA Review";
                  qaColor = "bg-yellow-100 text-yellow-700";
                }
              }

              // Feature branch detection
              const branchMatch = task.title.match(/\b(feature|fix|hotfix|release|chore)\/[\w-]+/i)
                || (task.description && task.description.match(/branch[:\s]+[`"]?([\w/.-]+)[`"]?/i));
              const branch = branchMatch ? branchMatch[0] : null;

              return (
                <div
                  key={task.id}
                  className={`py-3 flex items-center justify-between ${
                    isWaiting ? "opacity-50" : ""
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {task.title || task.id}
                      </p>
                      {branch && (
                        <span className="flex-shrink-0 px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-xs font-mono">
                          {branch}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      {task.assignedTo && (
                        <p className="text-xs text-gray-400">{task.assignedTo}</p>
                      )}
                      {isWaiting && dep && (
                        <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
                          </svg>
                          Waiting for: {dep.title || dep.id}
                        </span>
                      )}
                      {qaLabel && (
                        <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${qaColor}`}>
                          {qaLabel}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className={`ml-3 px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${
                    task.status === "in_progress" ? "bg-blue-100 text-blue-700" :
                    task.status === "done" ? "bg-green-100 text-green-700" :
                    task.status === "review" ? "bg-purple-100 text-purple-700" :
                    task.status === "blocked" ? "bg-red-100 text-red-700" :
                    task.status === "assigned" ? "bg-yellow-100 text-yellow-700" :
                    "bg-gray-100 text-gray-600"
                  }`}>
                    {task.status}
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

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<string | null>(null);

  useEffect(() => {
    fetchProjects()
      .then((data) => setProjects(Array.isArray(data) ? data : []))
      .catch(() => {});

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
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Projects</h1>

      {projects.length === 0 ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-12 text-center">
          <p className="text-gray-400 text-lg">No projects yet</p>
          <p className="text-gray-300 text-sm mt-2">
            Projects are created when the CEO decides an idea needs a dedicated workspace.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {projects.map((project) => {
            const total = project.taskCount ?? 0;
            const done = project.taskCounts?.done ?? 0;
            const progress = total > 0 ? Math.round((done / total) * 100) : 0;
            const repos = project.repositories ?? [];

            return (
              <div
                key={project.id}
                onClick={() => setSelectedProject(project.id)}
                className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 hover:shadow-md transition-shadow cursor-pointer"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold text-gray-900">{project.name}</h3>
                  <span
                    className={`px-2 py-0.5 rounded text-xs font-medium ${
                      project.status === "active"
                        ? "bg-green-100 text-green-700"
                        : project.status === "paused"
                        ? "bg-yellow-100 text-yellow-700"
                        : project.status === "completed"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {project.status}
                  </span>
                </div>
                <p className="text-sm text-gray-500 mb-4">{project.description}</p>

                {/* Repositories summary */}
                {repos.length > 0 && (
                  <div className="flex items-center gap-2 mb-3">
                    <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                    <span className="text-xs text-gray-500">
                      {repos.length} {repos.length === 1 ? "repo" : "repos"}
                    </span>
                    {repos.map((r) => (
                      <span key={r.id} className="text-xs font-mono text-gray-400">
                        {r.repoName}
                        {r.currentBranch && r.currentBranch !== r.defaultBranch && (
                          <span className="ml-1 text-blue-500">({r.currentBranch})</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {total > 0 && (
                  <>
                    <div className="mb-2">
                      <div className="flex justify-between text-xs text-gray-400 mb-1">
                        <span>{done}/{total} tasks</span>
                        <span>{progress}%</span>
                      </div>
                      <div className="w-full bg-gray-100 rounded-full h-2">
                        <div
                          className="bg-blue-500 h-2 rounded-full transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2 mt-3">
                      {project.taskCounts && project.taskCounts.in_progress > 0 && (
                        <span className="px-2 py-0.5 bg-blue-50 text-blue-600 rounded text-xs">
                          {project.taskCounts.in_progress} in progress
                        </span>
                      )}
                      {project.taskCounts && project.taskCounts.review > 0 && (
                        <span className="px-2 py-0.5 bg-purple-50 text-purple-600 rounded text-xs">
                          {project.taskCounts.review} in review
                        </span>
                      )}
                      {project.taskCounts && project.taskCounts.assigned > 0 && (
                        <span className="px-2 py-0.5 bg-yellow-50 text-yellow-600 rounded text-xs">
                          {project.taskCounts.assigned} assigned
                        </span>
                      )}
                      {project.taskCounts && project.taskCounts.backlog > 0 && (
                        <span className="px-2 py-0.5 bg-gray-50 text-gray-500 rounded text-xs">
                          {project.taskCounts.backlog} backlog
                        </span>
                      )}
                      {project.taskCounts && project.taskCounts.blocked > 0 && (
                        <span className="px-2 py-0.5 bg-red-50 text-red-600 rounded text-xs">
                          {project.taskCounts.blocked} blocked
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

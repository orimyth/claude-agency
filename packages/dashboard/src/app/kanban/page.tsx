"use client";

import { useState, useEffect, useRef } from "react";
import { useGlobalWS } from "@/components/ws-provider";
import { fetchTasks, fetchAgents, fetchProjects, fetchProjectRepositories } from "@/lib/api";
import { taskStyle } from "@/lib/status-colors";
import { mapTaskBranches, type TaskBranchInfo } from "@/lib/branch-utils";
import type { Task, TaskStatus, Agent, Project, ProjectRepository } from "@/lib/api";

// ---------------------------------------------------------------------------
// Column definitions
// ---------------------------------------------------------------------------

const COLUMNS: { status: TaskStatus; label: string; color: string; dotColor: string }[] = [
  { status: "backlog", label: "Backlog", color: "text-gray-500", dotColor: "bg-gray-400" },
  { status: "assigned", label: "Assigned", color: "text-amber-600", dotColor: "bg-amber-400" },
  { status: "in_progress", label: "In Progress", color: "text-blue-600", dotColor: "bg-blue-500" },
  { status: "review", label: "Review", color: "text-purple-600", dotColor: "bg-purple-500" },
  { status: "done", label: "Done", color: "text-emerald-600", dotColor: "bg-emerald-500" },
  { status: "blocked", label: "Blocked", color: "text-red-600", dotColor: "bg-red-500" },
];

// ---------------------------------------------------------------------------
// Task Card
// ---------------------------------------------------------------------------

function TaskCard({
  task,
  agent,
  project,
  allTasks,
  isDragging,
  onDragStart,
  branchInfo,
}: {
  task: Task;
  agent: Agent | undefined;
  project: Project | undefined;
  allTasks: Task[];
  isDragging: boolean;
  onDragStart: () => void;
  branchInfo: TaskBranchInfo | undefined;
}) {
  const dep = task.dependsOn ? allTasks.find((t) => t.id === task.dependsOn) : null;
  const isWaiting = dep && dep.status !== "done";
  const style = taskStyle(task.status);

  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("text/plain", task.id);
        onDragStart();
      }}
      className={`
        bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700
        p-3 cursor-grab active:cursor-grabbing
        hover:shadow-md hover:border-gray-300 dark:hover:border-gray-600
        transition-all duration-150
        ${isDragging ? "opacity-50 scale-95" : "opacity-100"}
        ${isWaiting ? "border-l-2 border-l-amber-400" : ""}
      `}
      style={{ animation: "fadeSlideIn 0.2s ease-out" }}
    >
      {/* Title */}
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-2 mb-1.5">
        {task.title || task.id.slice(0, 8)}
      </p>

      {/* Metadata row */}
      <div className="flex items-center flex-wrap gap-1.5">
        {/* Assignee */}
        {agent && (
          <span className="inline-flex items-center gap-1 text-[10px] text-gray-500 dark:text-gray-400">
            <span className="w-4 h-4 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-[8px] font-bold text-gray-600 dark:text-gray-300">
              {agent.name[0]}
            </span>
            {agent.name}
          </span>
        )}

        {/* Project */}
        {project && (
          <span className="px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 text-[10px] text-gray-500 dark:text-gray-400 truncate max-w-[100px]">
            {project.name}
          </span>
        )}

        {/* Priority */}
        {task.priority > 0 && (
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
            task.priority >= 3 ? "bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400" :
            task.priority >= 2 ? "bg-amber-50 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400" :
            "bg-gray-50 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
          }`}>
            P{task.priority}
          </span>
        )}
      </div>

      {/* Dependency warning */}
      {isWaiting && dep && (
        <div className="mt-2 flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400">
          <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
          </svg>
          <span className="truncate">Waiting: {dep.title || dep.id.slice(0, 8)}</span>
        </div>
      )}

      {/* Branch / PR link */}
      {branchInfo && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          <a
            href={branchInfo.branchUrl ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 text-[10px] font-mono text-gray-600 dark:text-gray-300 transition-colors max-w-[160px]"
            title={branchInfo.branchName}
          >
            <svg className="w-3 h-3 flex-shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
            </svg>
            <span className="truncate">{branchInfo.branchName}</span>
            {branchInfo.isActive && (
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" title="Active branch" />
            )}
          </a>
          {branchInfo.prUrl && (
            <a
              href={branchInfo.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-purple-50 dark:bg-purple-900/30 hover:bg-purple-100 dark:hover:bg-purple-900/50 text-[10px] font-medium text-purple-600 dark:text-purple-400 transition-colors"
              title="Open PR / Compare"
            >
              <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
              PR
            </a>
          )}
        </div>
      )}

      {/* Description preview */}
      {task.description && task.description.length > 0 && (
        <p className="mt-1.5 text-[11px] text-gray-400 dark:text-gray-500 line-clamp-2 leading-relaxed">
          {task.description}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kanban Column
// ---------------------------------------------------------------------------

function KanbanColumn({
  status,
  label,
  dotColor,
  tasks,
  agents,
  projects,
  allTasks,
  draggingId,
  setDraggingId,
  onDrop,
  branchMap,
}: {
  status: TaskStatus;
  label: string;
  dotColor: string;
  tasks: Task[];
  agents: Agent[];
  projects: Project[];
  allTasks: Task[];
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  onDrop: (taskId: string, newStatus: TaskStatus) => void;
  branchMap: Map<string, TaskBranchInfo>;
}) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div
      className={`
        flex flex-col min-w-[240px] max-w-[280px] flex-1 rounded-xl
        bg-gray-50 dark:bg-gray-950 border
        transition-colors duration-150
        ${dragOver
          ? "border-blue-400 dark:border-blue-500 bg-blue-50/50 dark:bg-blue-900/10"
          : "border-gray-200 dark:border-gray-800"
        }
      `}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const taskId = e.dataTransfer.getData("text/plain");
        if (taskId) onDrop(taskId, status);
        setDraggingId(null);
      }}
    >
      {/* Column header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-gray-200 dark:border-gray-800">
        <div className="flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
            {label}
          </span>
        </div>
        <span className="px-1.5 py-0.5 rounded-full bg-gray-200 dark:bg-gray-800 text-[10px] font-medium text-gray-500 dark:text-gray-400 tabular-nums">
          {tasks.length}
        </span>
      </div>

      {/* Cards */}
      <div className="flex-1 p-2 space-y-2 overflow-y-auto max-h-[calc(100vh-14rem)]">
        {tasks.length === 0 ? (
          <div className={`py-8 text-center text-xs ${
            dragOver ? "text-blue-500 dark:text-blue-400" : "text-gray-300 dark:text-gray-600"
          }`}>
            {dragOver ? "Drop here" : "No tasks"}
          </div>
        ) : (
          tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              agent={agents.find((a) => a.id === task.assignedTo)}
              project={projects.find((p) => p.id === task.projectId)}
              allTasks={allTasks}
              isDragging={draggingId === task.id}
              onDragStart={() => setDraggingId(task.id)}
              branchInfo={branchMap.get(task.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function KanbanPage() {
  const { on } = useGlobalWS();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [repositories, setRepositories] = useState<ProjectRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [filterProject, setFilterProject] = useState<string>("all");
  const [filterAgent, setFilterAgent] = useState<string>("all");

  // Fetch repos for all projects
  const loadRepos = async (projectsList: Project[]) => {
    const allRepos: ProjectRepository[] = [];
    await Promise.all(
      projectsList.map((p) =>
        fetchProjectRepositories(p.id)
          .then((repos) => { if (Array.isArray(repos)) allRepos.push(...repos); })
          .catch(() => {})
      )
    );
    setRepositories(allRepos);
  };

  useEffect(() => {
    Promise.all([
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {}),
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {}),
      fetchProjects().then((d) => {
        if (Array.isArray(d)) {
          setProjects(d);
          loadRepos(d);
        }
      }).catch(() => {}),
    ]).finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  // Real-time task updates via WebSocket
  useEffect(() => {
    const unsub = on("task:update", (data) => {
      setTasks((prev) => {
        const existing = prev.find((t) => t.id === data.taskId);
        if (existing) {
          return prev.map((t) =>
            t.id === data.taskId ? { ...t, status: data.status as TaskStatus, assignedTo: data.assignedTo ?? t.assignedTo } : t
          );
        }
        return [...prev, {
          id: data.taskId,
          title: data.title || "",
          description: "",
          status: data.status as TaskStatus,
          projectId: data.projectId || null,
          assignedTo: data.assignedTo || null,
          createdBy: "",
          parentTaskId: null,
          dependsOn: data.dependsOn || null,
          priority: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }];
      });
    });
    return unsub;
  }, [on]);

  // Handle "drop" — local optimistic update
  const handleDrop = (taskId: string, newStatus: TaskStatus) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t))
    );
  };

  // Filter tasks
  const filtered = tasks.filter((t) => {
    if (filterProject !== "all" && t.projectId !== filterProject) return false;
    if (filterAgent !== "all" && t.assignedTo !== filterAgent) return false;
    return true;
  });

  // Group by status
  const grouped = new Map<TaskStatus, Task[]>();
  for (const col of COLUMNS) grouped.set(col.status, []);
  for (const task of filtered) {
    const group = grouped.get(task.status);
    if (group) group.push(task);
  }

  // Build branch map from repositories
  const branchMap = mapTaskBranches(tasks, repositories);

  return (
    <div className="h-[calc(100vh-4rem)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Kanban Board</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            {filtered.length} tasks across {COLUMNS.length} columns
          </p>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3">
          <select
            value={filterProject}
            onChange={(e) => setFilterProject(e.target.value)}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>

          <select
            value={filterAgent}
            onChange={(e) => setFilterAgent(e.target.value)}
            className="text-xs px-2.5 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="all">All Agents</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Board */}
      {loading ? (
        <div className="flex gap-3 overflow-x-auto pb-4">
          {COLUMNS.map((col) => (
            <div key={col.status} className="min-w-[240px] flex-1 rounded-xl bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 p-3 animate-pulse">
              <div className="h-4 w-20 bg-gray-200 dark:bg-gray-700 rounded mb-3" />
              <div className="space-y-2">
                <div className="h-20 bg-gray-200 dark:bg-gray-700 rounded-lg" />
                <div className="h-20 bg-gray-200 dark:bg-gray-700 rounded-lg" />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-4 h-[calc(100%-3.5rem)]">
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col.status}
              status={col.status}
              label={col.label}
              dotColor={col.dotColor}
              tasks={grouped.get(col.status) ?? []}
              agents={agents}
              projects={projects}
              allTasks={tasks}
              draggingId={draggingId}
              setDraggingId={setDraggingId}
              onDrop={handleDrop}
              branchMap={branchMap}
            />
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import { useWebSocket } from "@/lib/ws-client";
import { KPICard } from "@/components/kpi-card";
import { AgentCard } from "@/components/agent-card";
import { ActivityFeed } from "@/components/activity-feed";
import { SubmitIdea } from "@/components/submit-idea";
import { SkeletonKPI, SkeletonAgentCard, SkeletonTaskRow } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { taskStyle } from "@/lib/status-colors";
import { fetchAgents, fetchTasks, fetchApprovals, submitIdea } from "@/lib/api";
import type { Agent, Task } from "@/lib/api";
import { useState, useEffect, useCallback, useMemo } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

/** Derive QA pipeline status from a task and its related tasks */
function getQAPipelineStatus(task: Task, allTasks: Task[]): {
  label: string;
  color: string;
} | null {
  const qaTask = allTasks.find(
    (t) => t.dependsOn === task.id && /qa|review|quality/i.test(t.title)
  );
  if (!qaTask) return null;

  const fixTask = allTasks.find(
    (t) => t.dependsOn === qaTask.id && /fix|bug|patch/i.test(t.title)
  );

  if (fixTask && (fixTask.status === "in_progress" || fixTask.status === "assigned")) {
    return { label: "QA Failed - Fixing", color: "bg-red-100 text-red-700" };
  }
  if (qaTask.status === "done") {
    return { label: "QA Passed", color: "bg-green-100 text-green-700" };
  }
  if (qaTask.status === "in_progress" || qaTask.status === "assigned" || qaTask.status === "review") {
    return { label: "In QA", color: "bg-yellow-100 text-yellow-700" };
  }
  return null;
}

/** Check if a task title/description hints at a feature branch */
function getFeatureBranch(task: Task): string | null {
  const branchMatch = task.title.match(/\b(feature|fix|hotfix|release|chore)\/[\w-]+/i);
  if (branchMatch) return branchMatch[0];
  if (task.description) {
    const descMatch = task.description.match(/branch[:\s]+[`"]?([\w/.-]+)[`"]?/i);
    if (descMatch) return descMatch[1];
  }
  return null;
}

// Task status display order for grouping
const STATUS_ORDER: Array<Task["status"]> = ["in_progress", "review", "assigned", "blocked", "backlog", "done"];

export default function Dashboard() {
  const { connected, events, on } = useWebSocket(WS_URL);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvalCount, setApprovalCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    new Set(["in_progress", "review", "assigned", "blocked"])
  );

  useEffect(() => {
    Promise.all([
      fetchAgents().then((data) => setAgents(Array.isArray(data) ? data : [])).catch(() => {}),
      fetchTasks().then((data) => setTasks(Array.isArray(data) ? data : [])).catch(() => {}),
      fetchApprovals().then((data) => setApprovalCount(Array.isArray(data) ? data.length : 0)).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});
      fetchApprovals()
        .then((data) => setApprovalCount(Array.isArray(data) ? data.length : 0))
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const unsub1 = on("agent:status", (data) => {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === data.agentId ? { ...a, status: data.status } : a
        )
      );
    });

    const unsub2 = on("task:update", (data) => {
      setTasks((prev) => {
        const existing = prev.find((t) => t.id === data.taskId);
        if (existing) {
          return prev.map((t) =>
            t.id === data.taskId ? { ...t, status: data.status as Task["status"] } : t
          );
        }
        return [...prev, {
          id: data.taskId,
          title: data.title || "",
          description: "",
          status: data.status as Task["status"],
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

    const unsub3 = on("break:start", (data) => {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === data.agentId ? { ...a, status: "on_break" } : a
        )
      );
    });

    const unsub4 = on("break:end", (data) => {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === data.agentId ? { ...a, status: "idle" } : a
        )
      );
    });

    const unsub5 = on("approval:new", () => setApprovalCount((p) => p + 1));
    const unsub6 = on("approval:resolved", () => setApprovalCount((p) => Math.max(0, p - 1)));

    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); };
  }, [on]);

  const activeAgents = agents.filter((a) => a.status === "active").length;
  const onBreak = agents.filter((a) => a.status === "on_break").length;
  const activeTasks = tasks.filter((t) => t.status === "in_progress" || t.status === "assigned").length;
  const completedTasks = tasks.filter((t) => t.status === "done").length;
  const inReviewTasks = tasks.filter((t) => t.status === "review").length;
  const blockedTasks = tasks.filter((t) => t.status === "blocked").length;

  const handleSubmitIdea = useCallback(async (title: string, description: string) => {
    try {
      await submitIdea(title, description);
    } catch {
      console.log("Idea submitted (orchestrator offline):", title, description);
    }
  }, []);

  // Group tasks by status
  const taskGroups = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const status of STATUS_ORDER) {
      const statusTasks = tasks.filter((t) => t.status === status);
      if (statusTasks.length > 0) {
        groups.set(status, statusTasks);
      }
    }
    return groups;
  }, [tasks]);

  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  const toggleGroup = (status: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agency Overview</h1>
          <p className="text-gray-500 text-sm mt-1">
            {connected ? "Live" : "Connecting..."} — {agents.length} agents registered
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full transition-colors duration-300 ${connected ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-sm text-gray-500">{connected ? "Connected" : "Disconnected"}</span>
        </div>
      </div>

      {/* KPIs */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonKPI key={i} />)}
        </div>
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <KPICard title="Active Agents" value={activeAgents} subtitle={`of ${agents.length}`} color="blue" icon="agents" />
          <KPICard title="On Break" value={onBreak} color="yellow" icon="pause" />
          <KPICard title="Active Tasks" value={activeTasks} color="green" icon="tasks" />
          <KPICard title="In Review" value={inReviewTasks} color="purple" icon="clock" />
          <KPICard title="Completed" value={completedTasks} color="green" icon="check" />
          <KPICard title="Approvals" value={approvalCount} color={approvalCount > 0 ? "red" : "green"} icon="alert" />
        </div>
      )}

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Agents + Tasks */}
        <div className="lg:col-span-2 space-y-5">
          {/* Team */}
          <div>
            <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide mb-3">Team</h2>
            {loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => <SkeletonAgentCard key={i} />)}
              </div>
            ) : agents.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100">
                <EmptyState icon="agents" title="No agents registered" description="Agents will appear here once they connect to the orchestrator." />
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {agents.map((agent) => {
                  const agentTasks = tasks.filter(
                    (t) => t.assignedTo === agent.id && (t.status === "in_progress" || t.status === "assigned")
                  );
                  return (
                    <AgentCard
                      key={agent.id}
                      name={agent.name}
                      role={agent.role}
                      status={agent.status}
                      avatar={agent.avatar}
                      currentTask={agentTasks[0]?.title}
                      projectId={agentTasks[0]?.projectId ?? undefined}
                      taskCount={agentTasks.length > 1 ? agentTasks.length : undefined}
                    />
                  );
                })}
              </div>
            )}
          </div>

          {/* Task Board — Grouped by Status */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-semibold text-gray-900 uppercase tracking-wide">
                Tasks {tasks.length > 0 && <span className="text-gray-400 font-normal">({tasks.length})</span>}
              </h2>
              {blockedTasks > 0 && (
                <span className="px-2 py-0.5 bg-red-50 text-red-600 rounded-full text-xs font-medium">
                  {blockedTasks} blocked
                </span>
              )}
            </div>

            {loading ? (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
                {Array.from({ length: 5 }).map((_, i) => <SkeletonTaskRow key={i} />)}
              </div>
            ) : tasks.length === 0 ? (
              <div className="bg-white rounded-xl shadow-sm border border-gray-100">
                <EmptyState icon="tasks" title="No tasks yet" description="Submit an idea or create a task to get started." />
              </div>
            ) : (
              <div className="space-y-2">
                {Array.from(taskGroups.entries()).map(([status, groupTasks]) => {
                  const style = taskStyle(status);
                  const isExpanded = expandedGroups.has(status);
                  const displayTasks = isExpanded ? groupTasks.slice(0, 20) : [];

                  return (
                    <div key={status} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
                      {/* Group header */}
                      <button
                        onClick={() => toggleGroup(status)}
                        className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-gray-50 transition-colors duration-150"
                      >
                        <div className="flex items-center gap-2.5">
                          <div className={`w-2.5 h-2.5 rounded-full ${style.dot}`} />
                          <span className="text-sm font-medium text-gray-900">{style.label}</span>
                          <span className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-xs font-medium tabular-nums">
                            {groupTasks.length}
                          </span>
                        </div>
                        <svg
                          className={`w-4 h-4 text-gray-400 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                          fill="none" stroke="currentColor" viewBox="0 0 24 24"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>

                      {/* Task rows */}
                      {isExpanded && (
                        <div className="border-t border-gray-100 divide-y divide-gray-50">
                          {displayTasks.map((task) => {
                            const dependsOnTask = task.dependsOn ? taskMap.get(task.dependsOn) : null;
                            const isWaiting = dependsOnTask && dependsOnTask.status !== "done";
                            const qaPipeline = getQAPipelineStatus(task, tasks);
                            const branch = getFeatureBranch(task);

                            return (
                              <div
                                key={task.id}
                                className={`px-4 py-2.5 flex items-center justify-between hover:bg-gray-50/50 transition-colors duration-150 ${
                                  isWaiting ? "opacity-50" : ""
                                }`}
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <p className="text-sm text-gray-900 truncate">
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
                                      <p className="text-xs text-gray-400">
                                        {agents.find((a) => a.id === task.assignedTo)?.name ?? task.assignedTo}
                                      </p>
                                    )}
                                    {isWaiting && dependsOnTask && (
                                      <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                                        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.172 13.828a4 4 0 015.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
                                        </svg>
                                        Waiting: {dependsOnTask.title || dependsOnTask.id}
                                      </span>
                                    )}
                                    {qaPipeline && (
                                      <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${qaPipeline.color}`}>
                                        {qaPipeline.label}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                          {groupTasks.length > 20 && (
                            <div className="px-4 py-2 text-center text-xs text-gray-400">
                              + {groupTasks.length - 20} more {style.label.toLowerCase()} tasks
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
        </div>

        {/* Right column */}
        <div className="space-y-5">
          <SubmitIdea onSubmit={handleSubmitIdea} />
          <ActivityFeed events={events} loading={loading} />
        </div>
      </div>
    </div>
  );
}

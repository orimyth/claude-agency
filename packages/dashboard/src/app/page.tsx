"use client";

import { useWebSocket } from "@/lib/ws-client";
import { KPICard } from "@/components/kpi-card";
import { AgentCard } from "@/components/agent-card";
import { ActivityFeed } from "@/components/activity-feed";
import { SubmitIdea } from "@/components/submit-idea";
import { fetchAgents, fetchTasks, fetchApprovals, submitIdea } from "@/lib/api";
import type { Agent, Task } from "@/lib/api";
import { useState, useEffect, useCallback } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

/** Derive QA pipeline status from a task and its related tasks */
function getQAPipelineStatus(task: Task, allTasks: Task[]): {
  label: string;
  color: string;
  qaTask?: Task;
  fixTask?: Task;
} | null {
  // Check if this task has a QA review child (a task that depends on it and has "QA" or "review" in the title)
  const qaTask = allTasks.find(
    (t) => t.dependsOn === task.id && /qa|review|quality/i.test(t.title)
  );
  if (!qaTask) return null;

  // Check if there's a fix task that depends on the QA task
  const fixTask = allTasks.find(
    (t) => t.dependsOn === qaTask.id && /fix|bug|patch/i.test(t.title)
  );

  if (fixTask && (fixTask.status === "in_progress" || fixTask.status === "assigned")) {
    return { label: "QA Failed - Fix in Progress", color: "bg-red-100 text-red-700", qaTask, fixTask };
  }
  if (qaTask.status === "done") {
    return { label: "QA Passed", color: "bg-green-100 text-green-700", qaTask };
  }
  if (qaTask.status === "in_progress" || qaTask.status === "assigned" || qaTask.status === "review") {
    return { label: "In QA Review", color: "bg-yellow-100 text-yellow-700", qaTask };
  }
  return null;
}

/** Check if a task title/description hints at a feature branch */
function getFeatureBranch(task: Task): string | null {
  // Look for branch-like patterns in the title: "feature/xxx", "fix/xxx", etc.
  const branchMatch = task.title.match(/\b(feature|fix|hotfix|release|chore)\/[\w-]+/i);
  if (branchMatch) return branchMatch[0];
  // Also check description
  if (task.description) {
    const descMatch = task.description.match(/branch[:\s]+[`"]?([\w/.-]+)[`"]?/i);
    if (descMatch) return descMatch[1];
  }
  return null;
}

export default function Dashboard() {
  const { connected, events, on } = useWebSocket(WS_URL);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvalCount, setApprovalCount] = useState(0);

  useEffect(() => {
    fetchAgents()
      .then((data) => setAgents(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetchTasks()
      .then((data) => setTasks(Array.isArray(data) ? data : []))
      .catch(() => {});
    fetchApprovals()
      .then((data) => setApprovalCount(Array.isArray(data) ? data.length : 0))
      .catch(() => {});
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

  // Build a map of task IDs to tasks for dependency lookups
  const taskMap = new Map(tasks.map((t) => [t.id, t]));

  return (
    <div className="max-w-7xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agency Overview</h1>
          <p className="text-gray-500 text-sm mt-1">
            {connected ? "Live" : "Connecting..."} — {agents.length} agents registered
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${connected ? "bg-green-500" : "bg-red-500"}`} />
          <span className="text-sm text-gray-500">{connected ? "Connected" : "Disconnected"}</span>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        <KPICard title="Active Agents" value={activeAgents} subtitle={`of ${agents.length}`} color="blue" />
        <KPICard title="On Break" value={onBreak} color="yellow" />
        <KPICard title="Active Tasks" value={activeTasks} color="green" />
        <KPICard title="In Review / QA" value={inReviewTasks} color="purple" />
        <KPICard title="Completed" value={completedTasks} color="green" />
        <KPICard title="Pending Approvals" value={approvalCount} color={approvalCount > 0 ? "red" : "green"} />
      </div>

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agents + Tasks */}
        <div className="lg:col-span-2 space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Team</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {agents.map((agent) => {
                const agentTask = tasks.find(
                  (t) => t.assignedTo === agent.id && (t.status === "in_progress" || t.status === "assigned")
                );
                return (
                  <AgentCard
                    key={agent.id}
                    name={agent.name}
                    role={agent.role}
                    status={agent.status}
                    avatar={agent.avatar}
                    currentTask={agentTask?.title}
                    projectId={agentTask?.projectId ?? undefined}
                  />
                );
              })}
            </div>
          </div>

          {/* Task Board */}
          {tasks.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Tasks ({tasks.length})</h2>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
                {tasks.slice(0, 30).map((task) => {
                  const dependsOnTask = task.dependsOn ? taskMap.get(task.dependsOn) : null;
                  const isWaiting = dependsOnTask && dependsOnTask.status !== "done";
                  const qaPipeline = getQAPipelineStatus(task, tasks);
                  const branch = getFeatureBranch(task);

                  return (
                    <div
                      key={task.id}
                      className={`px-4 py-3 flex items-center justify-between ${
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
                              Waiting for: {dependsOnTask.title || dependsOnTask.id}
                            </span>
                          )}
                          {qaPipeline && (
                            <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium ${qaPipeline.color}`}>
                              {qaPipeline.label}
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

        {/* Right column */}
        <div className="space-y-6">
          <SubmitIdea onSubmit={handleSubmitIdea} />
          <ActivityFeed events={events} />
        </div>
      </div>
    </div>
  );
}

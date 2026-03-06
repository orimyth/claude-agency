"use client";

import { useWebSocket } from "@/lib/ws-client";
import { KPICard } from "@/components/kpi-card";
import { AgentCard } from "@/components/agent-card";
import { ActivityFeed } from "@/components/activity-feed";
import { SubmitIdea } from "@/components/submit-idea";
import { fetchAgents, fetchTasks, fetchApprovals, submitIdea } from "@/lib/api";
import { useState, useEffect, useCallback } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  avatar?: string | null;
  currentTaskId?: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
  assignedTo?: string;
  projectId: string;
}

export default function Dashboard() {
  const { connected, events, on } = useWebSocket(WS_URL);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvalCount, setApprovalCount] = useState(0);

  // Load initial data from API
  useEffect(() => {
    fetchAgents()
      .then((data) => setAgents(data))
      .catch(() => {});
    fetchTasks()
      .then((data) => setTasks(data))
      .catch(() => {});
    fetchApprovals()
      .then((data) => setApprovalCount(Array.isArray(data) ? data.length : 0))
      .catch(() => {});
  }, []);

  // Refresh data periodically
  useEffect(() => {
    const interval = setInterval(() => {
      fetchAgents().then(setAgents).catch(() => {});
      fetchTasks().then(setTasks).catch(() => {});
      fetchApprovals()
        .then((data) => setApprovalCount(Array.isArray(data) ? data.length : 0))
        .catch(() => {});
    }, 10000);
    return () => clearInterval(interval);
  }, []);

  // Real-time updates via WebSocket
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
            t.id === data.taskId ? { ...t, status: data.status } : t
          );
        }
        return [...prev, { id: data.taskId, title: "", status: data.status, projectId: "" }];
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
  const completedTasks = tasks.filter((t) => t.status === "done" || t.status === "review").length;
  const blockedTasks = tasks.filter((t) => t.status === "blocked").length;

  const handleSubmitIdea = useCallback(async (title: string, description: string) => {
    try {
      await submitIdea(title, description);
    } catch {
      console.log("Idea submitted (orchestrator offline):", title, description);
    }
  }, []);

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
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <KPICard title="Active Agents" value={activeAgents} subtitle={`of ${agents.length}`} color="blue" />
        <KPICard title="On Break" value={onBreak} color="yellow" />
        <KPICard title="Active Tasks" value={activeTasks} color="green" />
        <KPICard title="Completed" value={completedTasks} color="purple" />
        <KPICard title="Pending Approvals" value={approvalCount} color={approvalCount > 0 ? "red" : "green"} />
      </div>

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agents + Tasks */}
        <div className="lg:col-span-2 space-y-6">
          <div>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Team</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {agents.map((agent) => (
                <AgentCard
                  key={agent.id}
                  name={agent.name}
                  role={agent.role}
                  status={agent.status}
                  avatar={agent.avatar}
                  currentTask={tasks.find((t) => t.assignedTo === agent.id && t.status === "in_progress")?.title}
                />
              ))}
            </div>
          </div>

          {/* Tasks */}
          {tasks.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-gray-900 mb-4">Tasks ({tasks.length})</h2>
              <div className="bg-white rounded-xl shadow-sm border border-gray-100 divide-y divide-gray-50">
                {tasks.slice(0, 20).map((task) => (
                  <div key={task.id} className="px-4 py-3 flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-900 truncate">{task.title || task.id}</p>
                      {task.assignedTo && (
                        <p className="text-xs text-gray-400 mt-0.5">
                          Assigned to {agents.find((a) => a.id === task.assignedTo)?.name ?? task.assignedTo}
                        </p>
                      )}
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
                ))}
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

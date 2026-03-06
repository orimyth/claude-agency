"use client";

import { useWebSocket } from "@/lib/ws-client";
import { KPICard } from "@/components/kpi-card";
import { AgentCard } from "@/components/agent-card";
import { ActivityFeed } from "@/components/activity-feed";
import { SubmitIdea } from "@/components/submit-idea";
import { useState, useEffect } from "react";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:3001";

const DEFAULT_AGENTS = [
  { id: "ceo", name: "Alice", role: "CEO", status: "idle", currentTask: undefined },
  { id: "hr", name: "Bob", role: "HR Manager", status: "idle", currentTask: undefined },
  { id: "architect", name: "Charlie", role: "Software Architect", status: "idle", currentTask: undefined },
  { id: "pm", name: "Diana", role: "Tech Lead / PM", status: "idle", currentTask: undefined },
  { id: "developer", name: "Eve", role: "Senior Developer", status: "idle", currentTask: undefined },
  { id: "designer", name: "Frank", role: "UI/UX Designer", status: "idle", currentTask: undefined },
  { id: "researcher", name: "Grace", role: "Researcher", status: "idle", currentTask: undefined },
];

export default function Dashboard() {
  const { connected, events, on } = useWebSocket(WS_URL);
  const [agents, setAgents] = useState(DEFAULT_AGENTS);
  const [taskCount, setTaskCount] = useState({ active: 0, completed: 0, blocked: 0 });
  const [approvalCount, setApprovalCount] = useState(0);

  useEffect(() => {
    const unsub1 = on("agent:status", (data) => {
      setAgents((prev) =>
        prev.map((a) =>
          a.id === data.agentId ? { ...a, status: data.status } : a
        )
      );
    });

    const unsub2 = on("task:update", (data) => {
      setTaskCount((prev) => {
        if (data.status === "in_progress") return { ...prev, active: prev.active + 1 };
        if (data.status === "done") return { ...prev, active: Math.max(0, prev.active - 1), completed: prev.completed + 1 };
        if (data.status === "blocked") return { ...prev, blocked: prev.blocked + 1 };
        return prev;
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

    const unsub5 = on("approval:new", () => {
      setApprovalCount((prev) => prev + 1);
    });

    const unsub6 = on("approval:resolved", () => {
      setApprovalCount((prev) => Math.max(0, prev - 1));
    });

    return () => { unsub1(); unsub2(); unsub3(); unsub4(); unsub5(); unsub6(); };
  }, [on]);

  const activeAgents = agents.filter((a) => a.status === "active").length;
  const onBreak = agents.filter((a) => a.status === "on_break").length;

  async function handleSubmitIdea(title: string, description: string) {
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, description }),
      });
      if (!res.ok) throw new Error("Failed to submit");
    } catch {
      // For now, just log — API routes will be added when orchestrator exposes HTTP
      console.log("Idea submitted:", title, description);
    }
  }

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
        <KPICard title="Active Tasks" value={taskCount.active} color="green" />
        <KPICard title="Completed" value={taskCount.completed} color="purple" />
        <KPICard title="Pending Approvals" value={approvalCount} color={approvalCount > 0 ? "red" : "green"} />
      </div>

      {/* Main content */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agents */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-semibold text-gray-900">Team</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {agents.map((agent) => (
              <AgentCard
                key={agent.id}
                name={agent.name}
                role={agent.role}
                status={agent.status}
                currentTask={agent.currentTask}
              />
            ))}
          </div>
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

"use client";

import { useState, useEffect, useCallback } from "react";
import Image from "next/image";
import { useGlobalWS } from "@/components/ws-provider";
import { fetchPerformance, fetchAgents, fetchWorkload, fetchScores } from "@/lib/api";
import type { Agent, AgentScore } from "@/lib/api";

interface AgentPerformance {
  agentId: string;
  tasksCompleted: number;
  tasksFailed: number;
  avgDurationMs: number;
  avgCostUsd: number;
  totalCostUsd: number;
  successRate: number;
}

interface AgentWorkload {
  agentId: string;
  activeTasks: number;
  queuedTasks: number;
  totalPending: number;
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function formatCost(usd: number): string {
  if (!usd || usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export default function PerformancePage() {
  const { on } = useGlobalWS();
  const [perf, setPerf] = useState<AgentPerformance[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [workloads, setWorkloads] = useState<AgentWorkload[]>([]);
  const [scores, setScores] = useState<AgentScore[]>([]);
  const [loading, setLoading] = useState(true);
  const [sortBy, setSortBy] = useState<"completed" | "success" | "speed" | "cost" | "efficiency">("efficiency");

  const refreshData = useCallback(() => {
    fetchPerformance().then((d) => { if (Array.isArray(d)) setPerf(d); }).catch(() => {});
    fetchScores().then((d) => { if (Array.isArray(d)) setScores(d); }).catch(() => {});
    fetchWorkload().then((d) => { if (Array.isArray(d)) setWorkloads(d); }).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      fetchPerformance().then((d) => { if (Array.isArray(d)) setPerf(d); }).catch(() => {}),
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {}),
      fetchWorkload().then((d) => { if (Array.isArray(d)) setWorkloads(d); }).catch(() => {}),
      fetchScores().then((d) => { if (Array.isArray(d)) setScores(d); }).catch(() => {}),
    ]).finally(() => setLoading(false));

    const interval = setInterval(refreshData, 30000);
    return () => clearInterval(interval);
  }, [refreshData]);

  // Refresh when tasks complete
  useEffect(() => {
    const unsub = on("task:update", (data) => {
      if (data.status === "done") refreshData();
    });
    return unsub;
  }, [on, refreshData]);

  const getAgent = (id: string) => agents.find((a) => a.id === id);
  const getWorkload = (id: string) => workloads.find((w) => w.agentId === id);
  const getScore = (id: string) => scores.find((s) => s.agentId === id);

  const sorted = [...perf].sort((a, b) => {
    switch (sortBy) {
      case "completed": return b.tasksCompleted - a.tasksCompleted;
      case "success": return b.successRate - a.successRate;
      case "speed": return (a.avgDurationMs || Infinity) - (b.avgDurationMs || Infinity);
      case "cost": return b.totalCostUsd - a.totalCostUsd;
      case "efficiency": {
        const sa = getScore(a.agentId)?.efficiency ?? 0;
        const sb = getScore(b.agentId)?.efficiency ?? 0;
        return sb - sa;
      }
      default: return 0;
    }
  });

  // Team-level stats
  const totalCompleted = perf.reduce((s, p) => s + p.tasksCompleted, 0);
  const totalFailed = perf.reduce((s, p) => s + p.tasksFailed, 0);
  const totalCost = perf.reduce((s, p) => s + p.totalCostUsd, 0);
  const avgSuccess = perf.length > 0 ? perf.reduce((s, p) => s + p.successRate, 0) / perf.length : 0;

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Performance</h1>
        <div className="animate-pulse space-y-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-20 bg-gray-100 dark:bg-gray-800 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Performance</h1>

      {/* Team Summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Tasks Completed</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{totalCompleted}</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Success Rate</p>
          <p className={`text-2xl font-bold mt-1 ${avgSuccess >= 80 ? "text-emerald-600" : avgSuccess >= 50 ? "text-amber-600" : "text-red-600"}`}>
            {avgSuccess > 0 ? `${Math.round(avgSuccess)}%` : "—"}
          </p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Tasks Failed</p>
          <p className="text-2xl font-bold text-red-500 mt-1">{totalFailed}</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Total Spend</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{formatCost(totalCost)}</p>
        </div>
      </div>

      {/* Sort controls */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-400 uppercase tracking-wide">Sort by:</span>
        {([
          { key: "efficiency", label: "Efficiency" },
          { key: "completed", label: "Tasks" },
          { key: "success", label: "Success Rate" },
          { key: "speed", label: "Speed" },
          { key: "cost", label: "Cost" },
        ] as const).map((s) => (
          <button
            key={s.key}
            onClick={() => setSortBy(s.key)}
            className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
              sortBy === s.key
                ? "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900"
                : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Agent Cards */}
      {sorted.length === 0 ? (
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-12 text-center">
          <p className="text-sm text-gray-400">No performance data yet</p>
        </div>
      ) : (
        <div className="space-y-3">
          {sorted.map((p, i) => {
            const agent = getAgent(p.agentId);
            const wl = getWorkload(p.agentId);
            const sc = getScore(p.agentId);
            const successColor =
              p.successRate >= 90 ? "text-emerald-600" :
              p.successRate >= 70 ? "text-amber-600" : "text-red-500";

            return (
              <div
                key={p.agentId}
                className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-5 hover:border-gray-300 dark:hover:border-gray-600 transition-colors"
              >
                <div className="flex items-center gap-4">
                  {/* Rank */}
                  <div className="w-8 text-center">
                    <span className={`text-lg font-bold ${i < 3 ? "text-amber-500" : "text-gray-300 dark:text-gray-600"}`}>
                      {i + 1}
                    </span>
                  </div>

                  {/* Avatar */}
                  {agent?.avatar ? (
                    <Image
                      src={agent.avatar}
                      alt={agent.name}
                      width={48}
                      height={48}
                      className="w-12 h-12 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-12 h-12 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-lg font-bold text-gray-500">
                      {(agent?.name ?? p.agentId)[0]}
                    </div>
                  )}

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-gray-900 dark:text-white">
                        {agent?.name ?? p.agentId}
                      </span>
                      {agent?.role && (
                        <span className="text-xs text-gray-400">{agent.role}</span>
                      )}
                      {sc && sc.efficiency > 0 && (
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold tabular-nums ${
                          sc.efficiency >= 70 ? "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400" :
                          sc.efficiency >= 40 ? "bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400" :
                          "bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400"
                        }`}>
                          {sc.efficiency}/100
                        </span>
                      )}
                    </div>
                    {wl && (wl.activeTasks > 0 || wl.queuedTasks > 0) && (
                      <p className="text-xs text-gray-400 mt-0.5">
                        {wl.activeTasks} active, {wl.queuedTasks} queued
                      </p>
                    )}
                  </div>

                  {/* Stats */}
                  <div className="flex items-center gap-6">
                    <div className="text-center">
                      <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">{p.tasksCompleted}</p>
                      <p className="text-xs text-gray-400">done</p>
                    </div>
                    <div className="text-center">
                      <p className={`text-lg font-bold tabular-nums ${successColor}`}>
                        {p.successRate > 0 ? `${Math.round(p.successRate)}%` : "—"}
                      </p>
                      <p className="text-xs text-gray-400">success</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                        {formatDuration(p.avgDurationMs)}
                      </p>
                      <p className="text-xs text-gray-400">avg time</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                        {formatCost(p.avgCostUsd)}
                      </p>
                      <p className="text-xs text-gray-400">avg cost</p>
                    </div>
                    <div className="text-center">
                      <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
                        {formatCost(p.totalCostUsd)}
                      </p>
                      <p className="text-xs text-gray-400">total</p>
                    </div>
                  </div>
                </div>

                {/* Success bar */}
                <div className="mt-3 ml-12">
                  <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        p.successRate >= 90 ? "bg-emerald-500" :
                        p.successRate >= 70 ? "bg-amber-500" : "bg-red-500"
                      }`}
                      style={{ width: `${Math.max(p.successRate, 2)}%` }}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

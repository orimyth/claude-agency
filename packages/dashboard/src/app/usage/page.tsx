"use client";

import { useState, useEffect, useMemo } from "react";
import Image from "next/image";
import { fetchUsage, fetchAgents } from "@/lib/api";
import type { Agent } from "@/lib/api";

interface UsageRecord {
  agentId: string;
  taskId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  model: string | null;
  numTurns: number;
  durationMs: number;
  createdAt: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

type TimeRange = "1h" | "24h" | "7d" | "30d" | "all";

export default function UsagePage() {
  const [records, setRecords] = useState<UsageRecord[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [timeRange, setTimeRange] = useState<TimeRange>("7d");

  useEffect(() => {
    Promise.all([
      fetchUsage().then((d) => {
        if (Array.isArray(d)) setRecords(d);
        else if (d?.usage) setRecords(d.usage);
        else if (d?.recent) setRecords(d.recent);
      }),
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }),
    ])
      .catch(() => {})
      .finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchUsage().then((d) => {
        if (Array.isArray(d)) setRecords(d);
        else if (d?.usage) setRecords(d.usage);
        else if (d?.recent) setRecords(d.recent);
      }).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const getAgent = (id: string) => agents.find((a) => a.id === id);

  const filtered = useMemo(() => {
    const now = Date.now();
    const ms: Record<string, number> = {
      "1h": 3_600_000,
      "24h": 86_400_000,
      "7d": 604_800_000,
      "30d": 2_592_000_000,
      all: Infinity,
    };
    const cutoff = now - (ms[timeRange] ?? Infinity);
    return records.filter((u) => new Date(u.createdAt).getTime() > cutoff);
  }, [records, timeRange]);

  // Aggregates
  const totalCost = filtered.reduce((s, u) => s + (u.costUsd ?? 0), 0);
  const totalInput = filtered.reduce((s, u) => s + (u.inputTokens ?? 0), 0);
  const totalOutput = filtered.reduce((s, u) => s + (u.outputTokens ?? 0), 0);
  const totalCacheRead = filtered.reduce((s, u) => s + (u.cacheReadTokens ?? 0), 0);
  const totalSessions = filtered.length;

  // By agent
  const byAgent = useMemo(() => {
    const map = new Map<string, { cost: number; sessions: number; inputTokens: number; outputTokens: number }>();
    for (const u of filtered) {
      const e = map.get(u.agentId) ?? { cost: 0, sessions: 0, inputTokens: 0, outputTokens: 0 };
      e.cost += u.costUsd ?? 0;
      e.sessions += 1;
      e.inputTokens += u.inputTokens ?? 0;
      e.outputTokens += u.outputTokens ?? 0;
      map.set(u.agentId, e);
    }
    return Array.from(map.entries())
      .map(([agentId, data]) => ({ agentId, ...data }))
      .sort((a, b) => b.cost - a.cost);
  }, [filtered]);

  // By model
  const byModel = useMemo(() => {
    const map = new Map<string, { cost: number; sessions: number; tokens: number }>();
    for (const u of filtered) {
      const model = u.model ?? "unknown";
      const e = map.get(model) ?? { cost: 0, sessions: 0, tokens: 0 };
      e.cost += u.costUsd ?? 0;
      e.sessions += 1;
      e.tokens += (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      map.set(model, e);
    }
    return Array.from(map.entries())
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.cost - a.cost);
  }, [filtered]);

  const maxAgentCost = byAgent[0]?.cost ?? 1;
  const maxModelCost = byModel[0]?.cost ?? 1;

  const rangeButtons: { value: TimeRange; label: string }[] = [
    { value: "1h", label: "1h" },
    { value: "24h", label: "24h" },
    { value: "7d", label: "7d" },
    { value: "30d", label: "30d" },
    { value: "all", label: "All" },
  ];

  if (loading) {
    return (
      <div className="max-w-6xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-6">Usage & Costs</h1>
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
      {/* Header + time range */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Usage & Costs</h1>
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          {rangeButtons.map((r) => (
            <button
              key={r.value}
              onClick={() => setTimeRange(r.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                timeRange === r.value
                  ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
                  : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Total Cost</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{formatCost(totalCost)}</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Sessions</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{totalSessions.toLocaleString()}</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Input Tokens</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{formatTokens(totalInput)}</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Output Tokens</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-white mt-1">{formatTokens(totalOutput)}</p>
        </div>
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-4">
          <p className="text-xs text-gray-500 uppercase tracking-wide">Cache Hit Rate</p>
          <p className="text-2xl font-bold text-emerald-600 mt-1">
            {totalInput > 0 ? `${Math.round((totalCacheRead / totalInput) * 100)}%` : "—"}
          </p>
          <p className="text-xs text-gray-400 mt-0.5">{formatTokens(totalCacheRead)} cached</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost by Agent */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-4">
            Cost by Agent
          </h2>
          {byAgent.length === 0 ? (
            <p className="text-sm text-gray-400">No usage data</p>
          ) : (
            <div className="space-y-3">
              {byAgent.map((entry) => {
                const agent = getAgent(entry.agentId);
                const pct = (entry.cost / maxAgentCost) * 100;
                return (
                  <div key={entry.agentId} className="flex items-center gap-3">
                    {agent?.avatar ? (
                      <Image
                        src={agent.avatar}
                        alt={agent?.name ?? entry.agentId}
                        width={32}
                        height={32}
                        className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-8 h-8 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-sm font-bold text-gray-500 flex-shrink-0">
                        {(agent?.name ?? entry.agentId)[0]}
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-200 truncate">
                          {agent?.name ?? entry.agentId}
                          {agent?.role && (
                            <span className="text-gray-400 font-normal ml-1.5 text-xs">{agent.role}</span>
                          )}
                        </span>
                        <span className="text-sm font-mono text-gray-700 dark:text-gray-300 tabular-nums ml-2">
                          {formatCost(entry.cost)}
                        </span>
                      </div>
                      <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-500 rounded-full transition-all duration-500"
                          style={{ width: `${Math.max(pct, 2)}%` }}
                        />
                      </div>
                      <div className="flex gap-3 mt-1 text-xs text-gray-400">
                        <span>{formatTokens(entry.inputTokens)} in</span>
                        <span>{formatTokens(entry.outputTokens)} out</span>
                        <span>{entry.sessions} sessions</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Cost by Model */}
        <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-5">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-4">
            Cost by Model
          </h2>
          {byModel.length === 0 ? (
            <p className="text-sm text-gray-400">No usage data</p>
          ) : (
            <div className="space-y-3">
              {byModel.map((m) => {
                const pct = (m.cost / maxModelCost) * 100;
                const label = m.model
                  .replace("claude-", "")
                  .replace(/-202\d{5}/, "");
                return (
                  <div key={m.model}>
                    <div className="flex items-center justify-between text-sm mb-1">
                      <span className="text-gray-700 dark:text-gray-300 font-mono text-xs">{label}</span>
                      <span className="text-gray-500 tabular-nums">{formatCost(m.cost)}</span>
                    </div>
                    <div className="h-2 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-purple-500 rounded-full transition-all duration-500"
                        style={{ width: `${Math.max(pct, 2)}%` }}
                      />
                    </div>
                    <div className="flex gap-3 mt-1 text-xs text-gray-400">
                      <span>{m.sessions} sessions</span>
                      <span>{formatTokens(m.tokens)} tokens</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Most Expensive Sessions */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 p-5">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-4">
          Recent Sessions
        </h2>
        {filtered.length === 0 ? (
          <p className="text-sm text-gray-400">No sessions recorded</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 uppercase tracking-wide border-b border-gray-100 dark:border-gray-800">
                  <th className="pb-2 pr-4">Agent</th>
                  <th className="pb-2 pr-4">Type</th>
                  <th className="pb-2 pr-4">Model</th>
                  <th className="pb-2 pr-4 text-right">Cost</th>
                  <th className="pb-2 pr-4 text-right">Tokens</th>
                  <th className="pb-2 pr-4 text-right">Turns</th>
                  <th className="pb-2 pr-4 text-right">Duration</th>
                  <th className="pb-2 text-right">When</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 dark:divide-gray-800">
                {filtered
                  .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
                  .slice(0, 20)
                  .map((u, i) => {
                    const agent = getAgent(u.agentId);
                    return (
                      <tr key={i} className="text-gray-600 dark:text-gray-400">
                        <td className="py-2.5 pr-4">
                          <div className="flex items-center gap-2">
                            {agent?.avatar ? (
                              <Image
                                src={agent.avatar}
                                alt={agent?.name ?? u.agentId}
                                width={24}
                                height={24}
                                className="w-6 h-6 rounded-full object-cover"
                              />
                            ) : (
                              <div className="w-6 h-6 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-xs font-bold text-gray-500">
                                {(agent?.name ?? u.agentId)[0]}
                              </div>
                            )}
                            <span className="font-medium text-gray-900 dark:text-gray-200">
                              {agent?.name ?? u.agentId}
                            </span>
                          </div>
                        </td>
                        <td className="py-2.5 pr-4">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            u.taskId
                              ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400"
                              : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400"
                          }`}>
                            {u.taskId ? "Task" : "Chat"}
                          </span>
                        </td>
                        <td className="py-2.5 pr-4 font-mono text-xs text-gray-500 truncate max-w-[120px]">
                          {(u.model ?? "—").replace("claude-", "").replace(/-202\d{5}/, "")}
                        </td>
                        <td className="py-2.5 pr-4 text-right font-mono tabular-nums text-gray-700 dark:text-gray-300">
                          {formatCost(u.costUsd ?? 0)}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">
                          {formatTokens((u.inputTokens ?? 0) + (u.outputTokens ?? 0))}
                        </td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">{u.numTurns ?? 0}</td>
                        <td className="py-2.5 pr-4 text-right tabular-nums">{formatDuration(u.durationMs)}</td>
                        <td className="py-2.5 text-right text-xs">{timeAgo(u.createdAt)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Cost breakdown info */}
      <div className="bg-gray-50 dark:bg-gray-900/50 rounded-xl border border-gray-100 dark:border-gray-800 p-5 text-xs text-gray-500 dark:text-gray-400 space-y-1">
        <p className="font-semibold text-gray-600 dark:text-gray-300">Understanding costs:</p>
        <p>Input tokens: text sent to Claude (prompts, context, file contents). ~$3/M tokens for Sonnet, ~$15/M for Opus.</p>
        <p>Output tokens: text generated by Claude (responses, code). ~$15/M tokens for Sonnet, ~$75/M for Opus.</p>
        <p>Cache read tokens: previously cached context reused at 90% discount. Higher cache hit rate = lower costs.</p>
        <p>Each &quot;session&quot; is one agent invocation — either a task execution or a chat response.</p>
      </div>
    </div>
  );
}

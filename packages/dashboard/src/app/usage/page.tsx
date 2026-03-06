"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { fetchUsage, fetchAgents } from "@/lib/api";

interface AgentUsage {
  agentId: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  sessions: number;
}

interface RecentEntry {
  agentId: string;
  taskId: string | null;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  numTurns: number;
  durationMs: number;
  model: string | null;
  recordedAt: string;
}

interface UsageData {
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalSessions: number;
  byAgent: AgentUsage[];
  last24h: {
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    sessions: number;
  };
  recent: RecentEntry[];
}

interface Agent {
  id: string;
  name: string;
  role: string;
  avatar?: string | null;
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
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export default function UsagePage() {
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);

  useEffect(() => {
    fetchUsage().then(setUsage).catch(() => {});
    fetchAgents().then(setAgents).catch(() => {});

    const interval = setInterval(() => {
      fetchUsage().then(setUsage).catch(() => {});
    }, 15000);
    return () => clearInterval(interval);
  }, []);

  const getAgent = (id: string) => agents.find((a) => a.id === id);

  if (!usage) {
    return (
      <div className="max-w-5xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Usage & Costs</h1>
        <p className="text-gray-500">Loading usage data...</p>
      </div>
    );
  }

  const maxAgentCost = Math.max(...usage.byAgent.map((a) => a.costUsd), 0.001);

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <h1 className="text-2xl font-bold text-gray-900">Usage & Costs</h1>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500">Total Cost</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">
            {formatCost(usage.totalCostUsd)}
          </p>
          <p className="text-xs text-gray-400 mt-1">all time</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500">Last 24h</p>
          <p className="text-2xl font-bold text-blue-600 mt-1">
            {formatCost(usage.last24h.costUsd)}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {usage.last24h.sessions} sessions
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500">Total Tokens</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">
            {formatTokens(usage.totalInputTokens + usage.totalOutputTokens)}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            {formatTokens(usage.totalInputTokens)} in / {formatTokens(usage.totalOutputTokens)} out
          </p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-5">
          <p className="text-sm text-gray-500">Cache Savings</p>
          <p className="text-2xl font-bold text-green-600 mt-1">
            {formatTokens(usage.totalCacheReadTokens)}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            tokens served from cache
          </p>
        </div>
      </div>

      {/* Cost by agent */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Cost by Agent</h2>
        {usage.byAgent.length === 0 ? (
          <p className="text-sm text-gray-400">No usage recorded yet</p>
        ) : (
          <div className="space-y-3">
            {usage.byAgent.map((entry) => {
              const agent = getAgent(entry.agentId);
              const pct = (entry.costUsd / maxAgentCost) * 100;
              return (
                <div key={entry.agentId} className="flex items-center gap-3">
                  {agent?.avatar ? (
                    <Image
                      src={agent.avatar}
                      alt={agent?.name ?? entry.agentId}
                      width={32}
                      height={32}
                      className="w-8 h-8 rounded-full object-cover"
                    />
                  ) : (
                    <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-sm font-bold text-gray-500">
                      {(agent?.name ?? entry.agentId)[0]}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-900">
                        {agent?.name ?? entry.agentId}
                        <span className="text-gray-400 font-normal ml-1.5 text-xs">
                          {agent?.role}
                        </span>
                      </span>
                      <span className="text-sm font-mono text-gray-700">
                        {formatCost(entry.costUsd)}
                      </span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className="bg-blue-500 rounded-full h-2 transition-all"
                        style={{ width: `${Math.max(pct, 1)}%` }}
                      />
                    </div>
                    <div className="flex gap-4 mt-1 text-xs text-gray-400">
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

      {/* Recent sessions */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <h2 className="font-semibold text-gray-900 mb-4">Recent Sessions</h2>
        {usage.recent.length === 0 ? (
          <p className="text-sm text-gray-400">No sessions recorded yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-100">
                  <th className="text-left py-2 pr-4 font-medium text-gray-500">Agent</th>
                  <th className="text-left py-2 pr-4 font-medium text-gray-500">Type</th>
                  <th className="text-right py-2 pr-4 font-medium text-gray-500">Cost</th>
                  <th className="text-right py-2 pr-4 font-medium text-gray-500">Tokens</th>
                  <th className="text-right py-2 pr-4 font-medium text-gray-500">Turns</th>
                  <th className="text-right py-2 pr-4 font-medium text-gray-500">Duration</th>
                  <th className="text-right py-2 font-medium text-gray-500">Model</th>
                </tr>
              </thead>
              <tbody>
                {usage.recent.map((entry, i) => {
                  const agent = getAgent(entry.agentId);
                  return (
                    <tr key={i} className="border-b border-gray-50">
                      <td className="py-2.5 pr-4">
                        <div className="flex items-center gap-2">
                          {agent?.avatar ? (
                            <Image
                              src={agent.avatar}
                              alt={agent?.name ?? entry.agentId}
                              width={24}
                              height={24}
                              className="w-6 h-6 rounded-full object-cover"
                            />
                          ) : (
                            <div className="w-6 h-6 bg-gray-100 rounded-full flex items-center justify-center text-xs font-bold text-gray-500">
                              {(agent?.name ?? entry.agentId)[0]}
                            </div>
                          )}
                          <span className="font-medium text-gray-900">
                            {agent?.name ?? entry.agentId}
                          </span>
                        </div>
                      </td>
                      <td className="py-2.5 pr-4">
                        <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                          entry.taskId
                            ? "bg-blue-50 text-blue-700"
                            : "bg-gray-100 text-gray-600"
                        }`}>
                          {entry.taskId ? "Task" : "Chat"}
                        </span>
                      </td>
                      <td className="py-2.5 pr-4 text-right font-mono text-gray-700">
                        {formatCost(entry.costUsd)}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-gray-600">
                        {formatTokens(entry.inputTokens + entry.outputTokens)}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-gray-600">
                        {entry.numTurns}
                      </td>
                      <td className="py-2.5 pr-4 text-right text-gray-600">
                        {formatDuration(entry.durationMs)}
                      </td>
                      <td className="py-2.5 text-right text-gray-400 text-xs font-mono truncate max-w-[120px]">
                        {entry.model ?? "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Token breakdown info */}
      <div className="bg-gray-50 rounded-xl p-5 text-xs text-gray-500 space-y-1">
        <p className="font-semibold text-gray-600">Understanding costs:</p>
        <p>Input tokens: text sent to Claude (prompts, context, file contents). ~$3/M tokens for Sonnet, ~$15/M for Opus.</p>
        <p>Output tokens: text generated by Claude (responses, code). ~$15/M tokens for Sonnet, ~$75/M for Opus.</p>
        <p>Cache read tokens: previously cached context reused at 90% discount. Higher cache = lower costs.</p>
        <p>Each &quot;session&quot; is one agent invocation — either a task execution or a chat response.</p>
      </div>
    </div>
  );
}

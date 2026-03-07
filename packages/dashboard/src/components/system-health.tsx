"use client";

import { useState, useEffect } from "react";
import { fetchHealth, fetchOverdueTasks, fetchDeadlocks } from "@/lib/api";
import type { AgentHealth } from "@/lib/api";

export function SystemHealth() {
  const [health, setHealth] = useState<AgentHealth[]>([]);
  const [overdueCount, setOverdueCount] = useState(0);
  const [deadlockCount, setDeadlockCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchHealth().then((d) => { if (Array.isArray(d)) setHealth(d); }).catch(() => {}),
      fetchOverdueTasks().then((d) => { if (Array.isArray(d)) setOverdueCount(d.length); }).catch(() => {}),
      fetchDeadlocks().then((d) => { if (d?.count !== undefined) setDeadlockCount(d.count); }).catch(() => {}),
    ]).finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchHealth().then((d) => { if (Array.isArray(d)) setHealth(d); }).catch(() => {});
      fetchOverdueTasks().then((d) => { if (Array.isArray(d)) setOverdueCount(d.length); }).catch(() => {});
      fetchDeadlocks().then((d) => { if (d?.count !== undefined) setDeadlockCount(d.count); }).catch(() => {});
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-3">System Health</h3>
        <div className="animate-pulse space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-4 bg-gray-100 dark:bg-gray-800 rounded" />
          ))}
        </div>
      </div>
    );
  }

  // Aggregated metrics
  const totalTasks7d = health.reduce((s, h) => s + h.last7dTasks, 0);
  const totalCost7d = health.reduce((s, h) => s + h.last7dCost, 0);
  const avgSuccess = health.length > 0
    ? Math.round(health.reduce((s, h) => s + h.successRate, 0) / health.length)
    : 0;
  const totalErrors = health.reduce((s, h) => s + h.errorCount, 0);
  const avgCacheHit = health.length > 0
    ? Math.round(health.reduce((s, h) => s + h.cacheHitRate, 0) / health.length)
    : 0;

  const hasIssues = overdueCount > 0 || deadlockCount > 0 || totalErrors > 5;
  const statusColor = hasIssues ? "text-amber-500" : "text-emerald-500";
  const statusLabel = hasIssues ? "Attention needed" : "All systems healthy";

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide">System Health</h3>
        <div className="flex items-center gap-1.5">
          <div className={`w-2 h-2 rounded-full ${hasIssues ? "bg-amber-500 animate-pulse" : "bg-emerald-500"}`} />
          <span className={`text-xs font-medium ${statusColor}`}>{statusLabel}</span>
        </div>
      </div>

      <div className="space-y-3">
        {/* 7-day summary */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2.5">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">7d Tasks</p>
            <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">{totalTasks7d}</p>
          </div>
          <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-2.5">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide">7d Cost</p>
            <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">
              ${totalCost7d < 1 ? totalCost7d.toFixed(2) : totalCost7d.toFixed(0)}
            </p>
          </div>
        </div>

        {/* Metrics list */}
        <div className="space-y-2">
          <HealthRow
            label="Success Rate"
            value={`${avgSuccess}%`}
            status={avgSuccess >= 80 ? "good" : avgSuccess >= 50 ? "warn" : "bad"}
          />
          <HealthRow
            label="Cache Hit Rate"
            value={`${avgCacheHit}%`}
            status={avgCacheHit >= 50 ? "good" : avgCacheHit >= 20 ? "warn" : "neutral"}
          />
          <HealthRow
            label="Errors"
            value={String(totalErrors)}
            status={totalErrors === 0 ? "good" : totalErrors <= 3 ? "warn" : "bad"}
          />
          <HealthRow
            label="Overdue Tasks"
            value={String(overdueCount)}
            status={overdueCount === 0 ? "good" : "bad"}
          />
          <HealthRow
            label="Deadlocks"
            value={String(deadlockCount)}
            status={deadlockCount === 0 ? "good" : "bad"}
          />
        </div>

        {/* Agent breakdown for errors */}
        {totalErrors > 0 && (
          <div className="pt-2 border-t border-gray-100 dark:border-gray-800">
            <p className="text-[10px] text-gray-400 uppercase tracking-wide mb-1.5">Error Sources</p>
            {health
              .filter((h) => h.errorCount > 0)
              .sort((a, b) => b.errorCount - a.errorCount)
              .slice(0, 5)
              .map((h) => (
                <div key={h.agentId} className="flex items-center justify-between text-xs py-0.5">
                  <span className="text-gray-600 dark:text-gray-400">{h.agentId}</span>
                  <span className="text-red-500 font-medium tabular-nums">{h.errorCount} errors</span>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}

function HealthRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status: "good" | "warn" | "bad" | "neutral";
}) {
  const colors = {
    good: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    bad: "text-red-600 dark:text-red-400",
    neutral: "text-gray-500 dark:text-gray-400",
  };
  const dots = {
    good: "bg-emerald-500",
    warn: "bg-amber-500",
    bad: "bg-red-500",
    neutral: "bg-gray-400",
  };

  return (
    <div className="flex items-center justify-between text-sm">
      <div className="flex items-center gap-2">
        <div className={`w-1.5 h-1.5 rounded-full ${dots[status]}`} />
        <span className="text-gray-600 dark:text-gray-400">{label}</span>
      </div>
      <span className={`font-medium tabular-nums ${colors[status]}`}>{value}</span>
    </div>
  );
}

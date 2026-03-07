"use client";

import { useState, useEffect, useMemo } from "react";
import { fetchAgents, fetchTasks } from "@/lib/api";
import type { Agent, Task } from "@/lib/api";

interface CollabEdge {
  from: string;
  to: string;
  count: number;
}

export function AgentCollabGraph() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {}),
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {}),
    ]).finally(() => setLoading(false));
  }, []);

  // Build collaboration edges from task dependencies
  const { edges, maxCount } = useMemo(() => {
    const edgeMap = new Map<string, number>();

    for (const task of tasks) {
      if (!task.assignedTo || !task.dependsOn) continue;
      const dep = tasks.find((t) => t.id === task.dependsOn);
      if (!dep?.assignedTo || dep.assignedTo === task.assignedTo) continue;

      const key = [dep.assignedTo, task.assignedTo].sort().join("→");
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }

    // Also detect review chains: tasks in review status assigned to different agents
    for (const task of tasks) {
      if (!task.assignedTo || task.status !== "review") continue;
      // Find who created the task
      const creator = task.createdBy;
      if (!creator || creator === task.assignedTo || creator === "investor" || creator === "system") continue;
      const key = [creator, task.assignedTo].sort().join("→");
      edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
    }

    const result: CollabEdge[] = [];
    let max = 0;
    for (const [key, count] of edgeMap) {
      const [from, to] = key.split("→");
      result.push({ from, to, count });
      if (count > max) max = count;
    }

    return { edges: result.sort((a, b) => b.count - a.count), maxCount: max };
  }, [tasks]);

  // Agent task counts for sizing
  const taskCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const task of tasks) {
      if (task.assignedTo) {
        counts.set(task.assignedTo, (counts.get(task.assignedTo) || 0) + 1);
      }
    }
    return counts;
  }, [tasks]);

  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-5">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-3">Agent Collaboration</h3>
        <div className="animate-pulse h-48 bg-gray-100 dark:bg-gray-800 rounded-lg" />
      </div>
    );
  }

  if (edges.length === 0 && agents.length <= 1) return null;

  // Get unique agents involved in collaborations
  const involvedAgents = new Set<string>();
  for (const edge of edges) {
    involvedAgents.add(edge.from);
    involvedAgents.add(edge.to);
  }
  // Also include agents with tasks even if not collaborating
  for (const agent of agents) {
    if (taskCounts.get(agent.id)) involvedAgents.add(agent.id);
  }

  const agentList = agents.filter((a) => involvedAgents.has(a.id));

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 p-5">
      <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 uppercase tracking-wide mb-4">
        Agent Collaboration
        {edges.length > 0 && (
          <span className="text-gray-400 font-normal ml-1">({edges.length} links)</span>
        )}
      </h3>

      {edges.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-6">
          No collaboration data yet. Connections appear when agents hand off tasks.
        </p>
      ) : (
        <div className="space-y-2">
          {edges.slice(0, 8).map((edge) => {
            const fromAgent = agents.find((a) => a.id === edge.from);
            const toAgent = agents.find((a) => a.id === edge.to);
            const intensity = maxCount > 0 ? edge.count / maxCount : 0;

            return (
              <div
                key={`${edge.from}-${edge.to}`}
                className="flex items-center gap-2.5 group"
              >
                {/* From agent */}
                <div className="flex items-center gap-1.5 w-20 flex-shrink-0 justify-end">
                  <span className="text-xs text-gray-600 dark:text-gray-400 truncate text-right">
                    {fromAgent?.name ?? edge.from}
                  </span>
                  <div className="w-6 h-6 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-[10px] font-bold text-gray-500 flex-shrink-0">
                    {(fromAgent?.name ?? edge.from)[0]}
                  </div>
                </div>

                {/* Connection bar */}
                <div className="flex-1 h-5 relative flex items-center">
                  <div className="absolute inset-0 flex items-center">
                    <div
                      className="h-1 rounded-full transition-all duration-300"
                      style={{
                        width: `${Math.max(intensity * 100, 20)}%`,
                        backgroundColor: intensity > 0.7
                          ? "rgb(16, 185, 129)" // emerald
                          : intensity > 0.3
                            ? "rgb(59, 130, 246)" // blue
                            : "rgb(156, 163, 175)", // gray
                        opacity: 0.4 + intensity * 0.6,
                      }}
                    />
                  </div>
                  <span className="relative px-1.5 py-0.5 rounded bg-white dark:bg-gray-900 text-[10px] font-bold text-gray-500 tabular-nums mx-auto border border-gray-200 dark:border-gray-700">
                    {edge.count}
                  </span>
                </div>

                {/* To agent */}
                <div className="flex items-center gap-1.5 w-20 flex-shrink-0">
                  <div className="w-6 h-6 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-[10px] font-bold text-gray-500 flex-shrink-0">
                    {(toAgent?.name ?? edge.to)[0]}
                  </div>
                  <span className="text-xs text-gray-600 dark:text-gray-400 truncate">
                    {toAgent?.name ?? edge.to}
                  </span>
                </div>
              </div>
            );
          })}

          {edges.length > 8 && (
            <p className="text-[10px] text-gray-400 text-center mt-2">
              + {edges.length - 8} more connections
            </p>
          )}
        </div>
      )}
    </div>
  );
}

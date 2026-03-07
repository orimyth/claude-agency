"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { AgentCard } from "@/components/agent-card";
import { SkeletonAgentCard } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";
import { agentStyle, taskStyle } from "@/lib/status-colors";
import { fetchAgents, fetchTasks, fetchProjects } from "@/lib/api";
import type { Agent, Task, Project } from "@/lib/api";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {}),
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {}),
      fetchProjects().then((d) => { if (Array.isArray(d)) setProjects(d); }).catch(() => {}),
    ]).finally(() => setLoading(false));

    const interval = setInterval(() => {
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const agent = agents.find((a) => a.id === selectedAgent);

  const agentTasks = agent ? tasks.filter((t) => t.assignedTo === agent.id) : [];
  const activeTasks = agentTasks.filter(
    (t) => t.status === "in_progress" || t.status === "assigned" || t.status === "review"
  );
  const completedTasks = agentTasks.filter((t) => t.status === "done");
  const blockedTasks = agentTasks.filter((t) => t.status === "blocked");

  const getProject = (id: string | null) =>
    id ? projects.find((p) => p.id === id) : null;

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Agent Roster</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{agents.length} agents registered</p>
        </div>
        {agents.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-gray-500">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-green-500" />
              {agents.filter((a) => a.status === "active").length} active
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              {agents.filter((a) => a.status === "idle").length} idle
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-orange-400" />
              {agents.filter((a) => a.status === "on_break").length} on break
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Agent list */}
        <div className="lg:col-span-2 space-y-3">
          {loading ? (
            <>
              <SkeletonAgentCard />
              <SkeletonAgentCard />
              <SkeletonAgentCard />
              <SkeletonAgentCard />
            </>
          ) : agents.length === 0 ? (
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800">
              <EmptyState
                icon="agents"
                title="No agents registered"
                description="Agents will appear here once they connect to the orchestrator."
              />
            </div>
          ) : (
            agents.map((a) => {
              const currentTask = tasks.find(
                (t) =>
                  t.assignedTo === a.id &&
                  (t.status === "in_progress" || t.status === "assigned")
              );
              const taskCount = tasks.filter(
                (t) =>
                  t.assignedTo === a.id &&
                  t.status !== "done"
              ).length;
              const proj = currentTask ? getProject(currentTask.projectId) : null;

              return (
                <AgentCard
                  key={a.id}
                  name={a.name}
                  role={a.role}
                  status={a.status}
                  avatar={a.avatar}
                  currentTask={currentTask?.title}
                  projectId={proj?.name ?? currentTask?.projectId ?? undefined}
                  taskCount={taskCount > 0 ? taskCount : undefined}
                  onClick={() => setSelectedAgent(a.id)}
                />
              );
            })
          )}
        </div>

        {/* Detail panel */}
        <div>
          {agent ? (
            <div
              className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 sticky top-8 overflow-hidden"
              style={{ animation: "fadeSlideIn 0.25s ease-out" }}
            >
              {/* Agent header */}
              <div className="px-6 pt-6 pb-4">
                <div className="flex items-center gap-4">
                  <div className="relative">
                    {agent.avatar ? (
                      <Image
                        src={agent.avatar}
                        alt={agent.name}
                        width={64}
                        height={64}
                        className="w-16 h-16 rounded-full object-cover ring-2 ring-white shadow-md"
                      />
                    ) : (
                      <div className="w-16 h-16 bg-gradient-to-br from-gray-100 to-gray-200 rounded-full flex items-center justify-center text-2xl font-bold text-gray-500 ring-2 ring-white shadow-md">
                        {agent.name[0]}
                      </div>
                    )}
                    <div className={`absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full border-2 border-white ${agentStyle(agent.status).dot}`} />
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-gray-900 dark:text-white">{agent.name}</h2>
                    <p className="text-sm text-gray-500">{agent.role}</p>
                    <span className={`inline-flex items-center mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${agentStyle(agent.status).bg} ${agentStyle(agent.status).text}`}>
                      {agentStyle(agent.status).label}
                    </span>
                  </div>
                </div>
              </div>

              {/* Stats row */}
              <div className="grid grid-cols-3 border-y border-gray-100 dark:border-gray-800">
                <div className="px-4 py-3 text-center">
                  <p className="text-lg font-bold text-gray-900 dark:text-white tabular-nums">{activeTasks.length}</p>
                  <p className="text-xs text-gray-400">Active</p>
                </div>
                <div className="px-4 py-3 text-center border-x border-gray-100 dark:border-gray-800">
                  <p className="text-lg font-bold text-emerald-600 tabular-nums">{completedTasks.length}</p>
                  <p className="text-xs text-gray-400">Done</p>
                </div>
                <div className="px-4 py-3 text-center">
                  <p className="text-lg font-bold text-red-500 tabular-nums">{blockedTasks.length}</p>
                  <p className="text-xs text-gray-400">Blocked</p>
                </div>
              </div>

              <div className="px-6 py-4 space-y-4">
                {/* Reports To */}
                <div>
                  <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1">Reports To</p>
                  <div className="flex items-center gap-2">
                    {agent.reportsTo ? (
                      <>
                        <div className="w-6 h-6 bg-gray-100 rounded-full flex items-center justify-center text-xs font-bold text-gray-500">
                          {(agents.find((a) => a.id === agent.reportsTo)?.name ?? agent.reportsTo)[0]}
                        </div>
                        <span className="text-sm text-gray-700">
                          {agents.find((a) => a.id === agent.reportsTo)?.name ?? agent.reportsTo}
                        </span>
                      </>
                    ) : (
                      <span className="text-sm text-gray-700">Investor (You)</span>
                    )}
                  </div>
                </div>

                {/* Channels */}
                {agent.channels && agent.channels.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-1.5">Channels</p>
                    <div className="flex flex-wrap gap-1.5">
                      {agent.channels.map((ch) => (
                        <span
                          key={ch}
                          className="px-2 py-0.5 bg-gray-50 text-gray-600 rounded-md text-xs border border-gray-200"
                        >
                          #{ch}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Active Tasks */}
                {activeTasks.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-400 uppercase tracking-wide mb-2">
                      Active Tasks
                    </p>
                    <div className="space-y-2">
                      {activeTasks.map((task) => {
                        const proj = getProject(task.projectId);
                        const style = taskStyle(task.status);
                        return (
                          <div
                            key={task.id}
                            className="bg-gray-50 dark:bg-gray-800 rounded-lg px-3 py-2 border border-gray-100 dark:border-gray-700"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm text-gray-900 dark:text-gray-200 truncate font-medium">
                                {task.title || task.id}
                              </p>
                              <span className={`flex-shrink-0 px-1.5 py-0.5 rounded text-xs font-medium ${style.bg} ${style.text}`}>
                                {style.label}
                              </span>
                            </div>
                            {proj && (
                              <p className="text-xs text-gray-400 mt-0.5">in {proj.name}</p>
                            )}
                            {task.dependsOn && (
                              <p className="text-xs text-amber-600 mt-0.5 flex items-center gap-1">
                                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
                                </svg>
                                Depends on: {tasks.find((t) => t.id === task.dependsOn)?.title ?? task.dependsOn}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Blocked Tasks */}
                {blockedTasks.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-red-400 uppercase tracking-wide mb-2">
                      Blocked Tasks
                    </p>
                    <div className="space-y-2">
                      {blockedTasks.map((task) => (
                        <div key={task.id} className="bg-red-50 rounded-lg px-3 py-2 border border-red-100">
                          <p className="text-sm text-red-800 truncate font-medium">{task.title || task.id}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 sticky top-8">
              <EmptyState
                icon="agents"
                title="Select an agent"
                description="Click on an agent card to view their details, tasks, and performance."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

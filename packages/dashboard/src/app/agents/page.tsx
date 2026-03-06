"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { AgentCard } from "@/components/agent-card";
import { fetchAgents, fetchTasks, fetchProjects } from "@/lib/api";
import type { Agent, Task, Project } from "@/lib/api";

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  useEffect(() => {
    fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
    fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});
    fetchProjects().then((d) => { if (Array.isArray(d)) setProjects(d); }).catch(() => {});

    const interval = setInterval(() => {
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const agent = agents.find((a) => a.id === selectedAgent);

  // Get tasks for the selected agent
  const agentTasks = agent
    ? tasks.filter((t) => t.assignedTo === agent.id)
    : [];
  const activeTasks = agentTasks.filter(
    (t) => t.status === "in_progress" || t.status === "assigned" || t.status === "review"
  );
  const completedTasks = agentTasks.filter((t) => t.status === "done");

  const getProject = (id: string | null) =>
    id ? projects.find((p) => p.id === id) : null;

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Agent Roster</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent list */}
        <div className="lg:col-span-2 space-y-3">
          {agents.map((a) => {
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
          })}
        </div>

        {/* Detail panel */}
        <div>
          {agent ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 sticky top-8">
              <div className="flex items-center gap-4 mb-6">
                {agent.avatar ? (
                  <Image
                    src={agent.avatar}
                    alt={agent.name}
                    width={64}
                    height={64}
                    className="w-16 h-16 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center text-2xl font-bold text-gray-600">
                    {agent.name[0]}
                  </div>
                )}
                <div>
                  <h2 className="text-xl font-bold">{agent.name}</h2>
                  <p className="text-gray-500">{agent.role}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-gray-500">Status</p>
                  <p className={`text-sm mt-1 font-medium ${
                    agent.status === "active" ? "text-green-600" :
                    agent.status === "on_break" ? "text-yellow-600" :
                    agent.status === "error" ? "text-red-600" :
                    "text-gray-600"
                  }`}>{agent.status}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-500">Reports To</p>
                  <p className="text-sm mt-1">
                    {agent.reportsTo
                      ? agents.find((a) => a.id === agent.reportsTo)?.name ?? agent.reportsTo
                      : "Investor (You)"}
                  </p>
                </div>
                {agent.channels && agent.channels.length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-gray-500">Channels</p>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {agent.channels.map((ch) => (
                        <span
                          key={ch}
                          className="px-2 py-0.5 bg-gray-100 text-gray-600 rounded text-xs"
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
                    <p className="text-sm font-medium text-gray-500 mb-2">
                      Active Tasks ({activeTasks.length})
                    </p>
                    <div className="space-y-2">
                      {activeTasks.map((task) => {
                        const proj = getProject(task.projectId);
                        return (
                          <div
                            key={task.id}
                            className="bg-gray-50 rounded-lg px-3 py-2"
                          >
                            <div className="flex items-center justify-between">
                              <p className="text-sm text-gray-900 truncate font-medium">
                                {task.title || task.id}
                              </p>
                              <span className={`ml-2 px-1.5 py-0.5 rounded text-xs font-medium whitespace-nowrap ${
                                task.status === "in_progress" ? "bg-blue-100 text-blue-700" :
                                task.status === "review" ? "bg-purple-100 text-purple-700" :
                                "bg-yellow-100 text-yellow-700"
                              }`}>
                                {task.status}
                              </span>
                            </div>
                            {proj && (
                              <p className="text-xs text-gray-400 mt-0.5">
                                in {proj.name}
                              </p>
                            )}
                            {task.dependsOn && (
                              <p className="text-xs text-amber-600 mt-0.5">
                                Depends on: {tasks.find((t) => t.id === task.dependsOn)?.title ?? task.dependsOn}
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Completed Tasks summary */}
                {completedTasks.length > 0 && (
                  <div>
                    <p className="text-sm font-medium text-gray-500">
                      Completed Tasks
                    </p>
                    <p className="text-sm mt-1 text-green-600">
                      {completedTasks.length} task{completedTasks.length !== 1 ? "s" : ""} done
                    </p>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 text-center text-gray-400">
              Select an agent to view details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

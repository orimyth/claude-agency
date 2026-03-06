"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { AgentCard } from "@/components/agent-card";
import { fetchAgents } from "@/lib/api";

interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
  avatar?: string | null;
  reportsTo?: string | null;
  channels?: string[];
  currentTaskId?: string;
}

export default function AgentsPage() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  useEffect(() => {
    fetchAgents()
      .then((data) => setAgents(data))
      .catch(() => {});

    const interval = setInterval(() => {
      fetchAgents().then(setAgents).catch(() => {});
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  const agent = agents.find((a) => a.id === selectedAgent);

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Agent Roster</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent list */}
        <div className="lg:col-span-2 space-y-3">
          {agents.map((a) => (
            <AgentCard
              key={a.id}
              name={a.name}
              role={a.role}
              status={a.status}
              avatar={a.avatar}
              currentTask={a.currentTaskId || undefined}
              onClick={() => setSelectedAgent(a.id)}
            />
          ))}
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
                {agent.currentTaskId && (
                  <div>
                    <p className="text-sm font-medium text-gray-500">Current Task</p>
                    <p className="text-sm mt-1 text-blue-600">{agent.currentTaskId}</p>
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

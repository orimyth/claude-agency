"use client";

import { useState } from "react";
import { AgentCard } from "@/components/agent-card";

const AGENTS = [
  { id: "ceo", name: "Alice", role: "CEO", status: "idle", reportsTo: null, channels: ["general", "ceo-investor", "leadership", "approvals"] },
  { id: "hr", name: "Bob", role: "HR Manager", status: "idle", reportsTo: "ceo", channels: ["general", "hr-hiring", "leadership"] },
  { id: "architect", name: "Charlie", role: "Software Architect", status: "idle", reportsTo: "ceo", channels: ["general", "leadership"] },
  { id: "pm", name: "Diana", role: "Tech Lead / PM", status: "idle", reportsTo: "ceo", channels: ["general", "leadership"] },
  { id: "developer", name: "Eve", role: "Senior Developer", status: "idle", reportsTo: "pm", channels: ["general"] },
  { id: "designer", name: "Frank", role: "UI/UX Designer", status: "idle", reportsTo: "pm", channels: ["general"] },
  { id: "researcher", name: "Grace", role: "Researcher", status: "idle", reportsTo: "pm", channels: ["general"] },
];

export default function AgentsPage() {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const agent = AGENTS.find((a) => a.id === selectedAgent);

  return (
    <div className="max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold text-gray-900 mb-6">Agent Roster</h1>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Agent list */}
        <div className="lg:col-span-2 space-y-3">
          {AGENTS.map((a) => (
            <AgentCard
              key={a.id}
              name={a.name}
              role={a.role}
              status={a.status}
              onClick={() => setSelectedAgent(a.id)}
            />
          ))}
        </div>

        {/* Detail panel */}
        <div>
          {agent ? (
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6 sticky top-8">
              <div className="flex items-center gap-4 mb-6">
                <div className="w-16 h-16 bg-gray-100 rounded-full flex items-center justify-center text-2xl font-bold text-gray-600">
                  {agent.name[0]}
                </div>
                <div>
                  <h2 className="text-xl font-bold">{agent.name}</h2>
                  <p className="text-gray-500">{agent.role}</p>
                </div>
              </div>

              <div className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-gray-500">Status</p>
                  <p className="text-sm mt-1">{agent.status}</p>
                </div>
                <div>
                  <p className="text-sm font-medium text-gray-500">Reports To</p>
                  <p className="text-sm mt-1">
                    {agent.reportsTo
                      ? AGENTS.find((a) => a.id === agent.reportsTo)?.name ?? agent.reportsTo
                      : "Investor (You)"}
                  </p>
                </div>
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
              </div>

              <div className="mt-6 flex gap-2">
                <button className="flex-1 bg-blue-600 text-white py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
                  Assign Task
                </button>
                <button className="flex-1 bg-gray-100 text-gray-700 py-2 rounded-lg text-sm font-medium hover:bg-gray-200">
                  View Logs
                </button>
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

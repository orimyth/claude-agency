"use client";

import { useState, useEffect, useMemo } from "react";
import { fetchAuditLog, fetchAgents } from "@/lib/api";
import type { AuditEntry, Agent } from "@/lib/api";

const CHANNELS = [
  { value: "ceo-investor", label: "CEO / Investor" },
  { value: "general", label: "General" },
  { value: "leadership", label: "Leadership" },
  { value: "approvals", label: "Approvals" },
  { value: "hr-hiring", label: "HR / Hiring" },
];

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

export default function AuditPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [channel, setChannel] = useState("ceo-investor");
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
  }, []);

  useEffect(() => {
    setLoading(true);
    fetchAuditLog(channel, 200)
      .then((d) => { if (Array.isArray(d)) setEntries(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [channel]);

  const getAgent = (id: string | null) => id ? agents.find((a) => a.id === id) : null;

  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(
      (e) =>
        e.message.toLowerCase().includes(q) ||
        (e.agentId && e.agentId.toLowerCase().includes(q)) ||
        (getAgent(e.agentId)?.name?.toLowerCase().includes(q))
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, search, agents]);

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Audit Log</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Communication history across all channels
          </p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3">
        <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
          {CHANNELS.map((ch) => (
            <button
              key={ch.value}
              onClick={() => setChannel(ch.value)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                channel === ch.value
                  ? "bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm"
                  : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              }`}
            >
              {ch.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search messages..."
          className="px-3 py-1.5 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 w-64"
        />
      </div>

      {/* Log entries */}
      <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-100 dark:border-gray-800 overflow-hidden">
        {loading ? (
          <div className="p-8 text-center">
            <div className="animate-pulse space-y-3">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="h-12 bg-gray-100 dark:bg-gray-800 rounded-lg" />
              ))}
            </div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-gray-400">
              {search ? "No messages match your search" : "No messages in this channel"}
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-50 dark:divide-gray-800">
            {filtered.map((entry) => {
              const agent = getAgent(entry.agentId);
              return (
                <div
                  key={entry.id}
                  className="px-5 py-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
                >
                  <div className="flex items-start gap-3">
                    {/* Avatar */}
                    <div className="w-8 h-8 bg-gray-100 dark:bg-gray-800 rounded-full flex items-center justify-center text-xs font-bold text-gray-500 flex-shrink-0 mt-0.5">
                      {(agent?.name ?? entry.agentId ?? "S")[0]?.toUpperCase()}
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-medium text-gray-900 dark:text-gray-200">
                          {agent?.name ?? entry.agentId ?? "System"}
                        </span>
                        {agent?.role && (
                          <span className="text-xs text-gray-400">{agent.role}</span>
                        )}
                        <span className="text-xs text-gray-400 ml-auto flex-shrink-0">
                          {timeAgo(entry.createdAt)}
                        </span>
                      </div>
                      <p className="text-sm text-gray-700 dark:text-gray-300 whitespace-pre-wrap break-words">
                        {entry.message}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <p className="text-xs text-gray-400 text-center">
        Showing {filtered.length} of {entries.length} entries
      </p>
    </div>
  );
}

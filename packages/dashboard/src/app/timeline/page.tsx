"use client";

import Image from "next/image";
import { useState, useEffect, useMemo } from "react";
import { fetchTimeline, fetchAgents } from "@/lib/api";
import type { AgentTimeline, Agent } from "@/lib/api";

// ---------------------------------------------------------------------------
// Constants & Helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  done:        { bg: "bg-emerald-100", border: "border-emerald-400", text: "text-emerald-800" },
  in_progress: { bg: "bg-blue-100",    border: "border-blue-400",    text: "text-blue-800" },
  review:      { bg: "bg-purple-100",  border: "border-purple-400",  text: "text-purple-800" },
  assigned:    { bg: "bg-amber-100",   border: "border-amber-400",   text: "text-amber-800" },
  blocked:     { bg: "bg-red-100",     border: "border-red-400",     text: "text-red-800" },
  backlog:     { bg: "bg-gray-100",    border: "border-gray-300",    text: "text-gray-600" },
};

const AGENT_STATUS_COLORS: Record<string, string> = {
  active: "bg-green-500",
  idle: "bg-gray-400",
  paused: "bg-yellow-500",
  on_break: "bg-orange-400",
  error: "bg-red-500",
};

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.round((ms % 3_600_000) / 60_000);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Time range options
// ---------------------------------------------------------------------------

const TIME_RANGES = [
  { label: "24h", hours: 24 },
  { label: "48h", hours: 48 },
  { label: "72h", hours: 72 },
  { label: "7d",  hours: 168 },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TimelinePage() {
  const [timeline, setTimeline] = useState<AgentTimeline[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hours, setHours] = useState(72);
  const [hoveredTask, setHoveredTask] = useState<string | null>(null);

  useEffect(() => {
    fetchTimeline(hours)
      .then((d) => setTimeline(Array.isArray(d) ? d : []))
      .catch(() => {});
    fetchAgents()
      .then((d) => setAgents(Array.isArray(d) ? d : []))
      .catch(() => {});
  }, [hours]);

  useEffect(() => {
    const interval = setInterval(() => {
      fetchTimeline(hours)
        .then((d) => { if (Array.isArray(d)) setTimeline(d); })
        .catch(() => {});
      fetchAgents()
        .then((d) => { if (Array.isArray(d)) setAgents(d); })
        .catch(() => {});
    }, 15_000);
    return () => clearInterval(interval);
  }, [hours]);

  // Compute time bounds for the entire timeline
  const { timeStart, timeEnd, totalMs, hourMarkers } = useMemo(() => {
    const now = Date.now();
    const start = now - hours * 3_600_000;
    const total = now - start;

    // Generate hour markers
    const markers: { label: string; pct: number; isDay: boolean }[] = [];
    const startHour = new Date(start);
    startHour.setMinutes(0, 0, 0);
    startHour.setHours(startHour.getHours() + 1);

    let cursor = startHour.getTime();
    while (cursor < now) {
      const d = new Date(cursor);
      const pct = ((cursor - start) / total) * 100;
      const isDay = d.getHours() === 0;
      const label = isDay
        ? formatDate(d.toISOString())
        : formatTime(d.toISOString());
      markers.push({ label, pct, isDay });
      // For long ranges, show every 6 hours
      cursor += hours > 72 ? 6 * 3_600_000 : hours > 24 ? 3 * 3_600_000 : 3_600_000;
    }

    return { timeStart: start, timeEnd: now, totalMs: total, hourMarkers: markers };
  }, [hours]);

  // Stats
  const totalTasks = timeline.reduce((sum, t) => sum + t.tasks.length, 0);
  const completedTasks = timeline.reduce(
    (sum, t) => sum + t.tasks.filter((tk) => tk.status === "done").length,
    0
  );
  const activeTasks = timeline.reduce(
    (sum, t) => sum + t.tasks.filter((tk) => tk.status === "in_progress").length,
    0
  );

  const agentMap = new Map(agents.map((a) => [a.id, a]));

  return (
    <div className="max-w-full mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Agent Timeline</h1>
          <p className="text-gray-500 text-sm mt-1">
            Swimlane view of agent activity over the last {hours}h
          </p>
        </div>
        <div className="flex items-center gap-2">
          {TIME_RANGES.map((r) => (
            <button
              key={r.hours}
              onClick={() => setHours(r.hours)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                hours === r.hours
                  ? "bg-gray-900 text-white"
                  : "bg-gray-100 text-gray-600 hover:bg-gray-200"
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-4">
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-sm text-gray-500">Active Agents</p>
          <p className="text-2xl font-bold text-gray-900">{timeline.length}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-sm text-gray-500">Total Tasks</p>
          <p className="text-2xl font-bold text-gray-900">{totalTasks}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-sm text-gray-500">Completed</p>
          <p className="text-2xl font-bold text-emerald-600">{completedTasks}</p>
        </div>
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
          <p className="text-sm text-gray-500">In Progress</p>
          <p className="text-2xl font-bold text-blue-600">{activeTasks}</p>
        </div>
      </div>

      {/* Swimlane Timeline */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        {/* Time axis header */}
        <div className="flex border-b border-gray-200">
          <div className="w-52 flex-shrink-0 px-4 py-2 bg-gray-50 border-r border-gray-200">
            <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Agent</span>
          </div>
          <div className="flex-1 relative h-8 bg-gray-50">
            {hourMarkers.map((m, i) => (
              <div
                key={i}
                className="absolute top-0 h-full flex items-center"
                style={{ left: `${m.pct}%` }}
              >
                <div className={`h-full border-l ${m.isDay ? "border-gray-400" : "border-gray-200"}`} />
                <span className={`ml-1 text-xs whitespace-nowrap ${m.isDay ? "font-semibold text-gray-700" : "text-gray-400"}`}>
                  {m.label}
                </span>
              </div>
            ))}
            {/* "Now" indicator */}
            <div
              className="absolute top-0 h-full border-l-2 border-red-400 z-10"
              style={{ left: "100%" }}
            >
              <span className="absolute -top-0.5 -left-3 text-xs font-bold text-red-500">Now</span>
            </div>
          </div>
        </div>

        {/* Agent swimlanes */}
        {timeline.length === 0 ? (
          <div className="px-4 py-12 text-center text-gray-400">
            No agent activity in the selected time range.
          </div>
        ) : (
          timeline.map((agentData) => {
            const agent = agentMap.get(agentData.agentId);
            const status = agent?.status ?? "idle";

            return (
              <div
                key={agentData.agentId}
                className="flex border-b border-gray-100 last:border-b-0 hover:bg-gray-50/50 transition-colors"
              >
                {/* Agent label */}
                <div className="w-52 flex-shrink-0 px-4 py-3 border-r border-gray-100 flex items-center gap-3">
                  {agentData.avatar ? (
                    <Image
                      src={agentData.avatar}
                      alt={agentData.agentName}
                      width={32}
                      height={32}
                      className="w-8 h-8 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <div className="w-8 h-8 bg-gray-100 rounded-full flex items-center justify-center text-sm font-bold text-gray-600 flex-shrink-0">
                      {agentData.agentName[0]}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${AGENT_STATUS_COLORS[status] ?? "bg-gray-400"}`} />
                      <p className="text-sm font-medium text-gray-900 truncate">{agentData.agentName}</p>
                    </div>
                    <p className="text-xs text-gray-400 truncate">{agentData.role}</p>
                  </div>
                </div>

                {/* Task bars */}
                <div className="flex-1 relative py-2 min-h-[3rem]">
                  {/* Vertical grid lines */}
                  {hourMarkers.map((m, i) => (
                    <div
                      key={i}
                      className={`absolute top-0 h-full border-l ${m.isDay ? "border-gray-200" : "border-gray-100"}`}
                      style={{ left: `${m.pct}%` }}
                    />
                  ))}

                  {/* Task bars */}
                  {agentData.tasks.map((task) => {
                    const taskStart = new Date(task.startedAt).getTime();
                    const taskEnd = task.completedAt
                      ? new Date(task.completedAt).getTime()
                      : Date.now();

                    // Clamp to visible range
                    const clampedStart = Math.max(taskStart, timeStart);
                    const clampedEnd = Math.min(taskEnd, timeEnd);
                    if (clampedStart >= clampedEnd) return null;

                    const leftPct = ((clampedStart - timeStart) / totalMs) * 100;
                    const widthPct = ((clampedEnd - clampedStart) / totalMs) * 100;
                    const colors = STATUS_COLORS[task.status] ?? STATUS_COLORS.backlog;
                    const isHovered = hoveredTask === task.id;

                    return (
                      <div
                        key={task.id}
                        className={`absolute top-1.5 h-7 rounded-md border ${colors.bg} ${colors.border} ${colors.text}
                          cursor-pointer transition-all duration-150
                          ${isHovered ? "shadow-md z-20 ring-2 ring-offset-1 ring-blue-300" : "z-10"}
                        `}
                        style={{
                          left: `${leftPct}%`,
                          width: `${Math.max(widthPct, 0.3)}%`,
                        }}
                        onMouseEnter={() => setHoveredTask(task.id)}
                        onMouseLeave={() => setHoveredTask(null)}
                      >
                        {/* Task label (only visible if bar is wide enough) */}
                        {widthPct > 3 && (
                          <div className="px-1.5 h-full flex items-center overflow-hidden">
                            <span className="text-xs font-medium truncate">
                              {task.title}
                            </span>
                          </div>
                        )}

                        {/* Tooltip on hover */}
                        {isHovered && (
                          <div className="absolute bottom-full left-0 mb-2 w-64 bg-gray-900 text-white rounded-lg shadow-xl p-3 z-50 pointer-events-none">
                            <p className="text-sm font-medium mb-1 leading-tight">{task.title}</p>
                            <div className="space-y-0.5 text-xs text-gray-300">
                              <p>Status: <span className="text-white font-medium">{task.status}</span></p>
                              <p>Started: {formatDate(task.startedAt)} {formatTime(task.startedAt)}</p>
                              {task.completedAt && (
                                <p>Completed: {formatDate(task.completedAt)} {formatTime(task.completedAt)}</p>
                              )}
                              {task.durationMs && (
                                <p>Duration: <span className="text-white font-medium">{formatDuration(task.durationMs)}</span></p>
                              )}
                              {!task.completedAt && (
                                <p className="text-blue-300 font-medium">In progress ({formatDuration(Date.now() - new Date(task.startedAt).getTime())})</p>
                              )}
                            </div>
                            {/* Arrow */}
                            <div className="absolute top-full left-4 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900" />
                          </div>
                        )}

                        {/* Animated pulse for in-progress tasks */}
                        {task.status === "in_progress" && (
                          <div className="absolute right-1 top-1/2 -translate-y-1/2">
                            <span className="relative flex h-2 w-2">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75" />
                              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-6 text-xs text-gray-500">
        <span className="font-medium text-gray-700">Status:</span>
        {Object.entries(STATUS_COLORS).map(([status, colors]) => (
          <div key={status} className="flex items-center gap-1.5">
            <div className={`w-3 h-3 rounded-sm border ${colors.bg} ${colors.border}`} />
            <span>{status.replace("_", " ")}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 ml-4">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-600" />
          </span>
          <span>Currently active</span>
        </div>
      </div>
    </div>
  );
}

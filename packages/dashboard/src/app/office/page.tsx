"use client";

import { useState, useEffect, useMemo } from "react";
import { useTheme } from "@/components/theme-provider";
import { fetchAgents, fetchTasks } from "@/lib/api";
import type { Agent, Task } from "@/lib/api";

// ---------------------------------------------------------------------------
// Room definitions
// ---------------------------------------------------------------------------

interface Room {
  id: string;
  label: string;
  emoji: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  floorColor: string;
  slots: { x: number; y: number }[];
}

const ROOMS: Room[] = [
  {
    id: "ceo-office",
    label: "CEO Office",
    emoji: "",
    x: 20,
    y: 20,
    w: 200,
    h: 150,
    color: "#7c3aed",
    floorColor: "#f5f3ff",
    slots: [{ x: 80, y: 70 }],
  },
  {
    id: "dev-floor",
    label: "Dev Floor",
    emoji: "",
    x: 240,
    y: 20,
    w: 340,
    h: 150,
    color: "#2563eb",
    floorColor: "#eff6ff",
    slots: [
      { x: 40, y: 50 },
      { x: 110, y: 50 },
      { x: 180, y: 50 },
      { x: 250, y: 50 },
      { x: 40, y: 100 },
      { x: 110, y: 100 },
      { x: 180, y: 100 },
      { x: 250, y: 100 },
    ],
  },
  {
    id: "qa-lab",
    label: "QA Lab",
    emoji: "",
    x: 600,
    y: 20,
    w: 180,
    h: 150,
    color: "#9333ea",
    floorColor: "#faf5ff",
    slots: [
      { x: 40, y: 60 },
      { x: 110, y: 60 },
      { x: 40, y: 105 },
      { x: 110, y: 105 },
    ],
  },
  {
    id: "meeting-room",
    label: "Meeting Room",
    emoji: "",
    x: 20,
    y: 190,
    w: 200,
    h: 140,
    color: "#0891b2",
    floorColor: "#ecfeff",
    slots: [
      { x: 50, y: 55 },
      { x: 120, y: 55 },
      { x: 50, y: 100 },
      { x: 120, y: 100 },
    ],
  },
  {
    id: "break-room",
    label: "Break Room",
    emoji: "",
    x: 240,
    y: 190,
    w: 200,
    h: 140,
    color: "#ea580c",
    floorColor: "#fff7ed",
    slots: [
      { x: 45, y: 55 },
      { x: 115, y: 55 },
      { x: 45, y: 100 },
      { x: 115, y: 100 },
    ],
  },
  {
    id: "server-room",
    label: "Server Room",
    emoji: "",
    x: 460,
    y: 190,
    w: 160,
    h: 140,
    color: "#059669",
    floorColor: "#ecfdf5",
    slots: [
      { x: 40, y: 60 },
      { x: 100, y: 60 },
      { x: 40, y: 105 },
    ],
  },
  {
    id: "hallway",
    label: "Hallway",
    emoji: "",
    x: 640,
    y: 190,
    w: 140,
    h: 140,
    color: "#6b7280",
    floorColor: "#f9fafb",
    slots: [
      { x: 40, y: 55 },
      { x: 90, y: 55 },
      { x: 40, y: 100 },
      { x: 90, y: 100 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Map agent to a room based on status / role / task
// ---------------------------------------------------------------------------

function agentToRoom(agent: Agent, task: Task | undefined): string {
  // Break
  if (agent.status === "on_break") return "break-room";
  // Error / idle with no task
  if (agent.status === "idle" && !task) return "hallway";
  if (agent.status === "error") return "server-room";

  // Role-based defaults
  const role = agent.role.toLowerCase();
  if (role.includes("ceo") || role.includes("chief")) return "ceo-office";
  if (role.includes("devops") || role.includes("infra") || role.includes("ops")) return "server-room";
  if (role.includes("qa") || role.includes("quality") || role.includes("test")) return "qa-lab";

  // Task-based
  if (task) {
    if (task.status === "review") return "meeting-room";
    if (task.status === "in_progress") {
      if (/qa|test|quality/i.test(task.title)) return "qa-lab";
      return "dev-floor";
    }
    if (task.status === "assigned") return "dev-floor";
  }

  // Active with no clear task
  if (agent.status === "active") return "dev-floor";

  return "hallway";
}

// ---------------------------------------------------------------------------
// Pixel Character Colors based on role
// ---------------------------------------------------------------------------

function agentColors(role: string): { body: string; head: string; accent: string } {
  const r = role.toLowerCase();
  if (r.includes("ceo") || r.includes("chief"))
    return { body: "#7c3aed", head: "#a78bfa", accent: "#fbbf24" };
  if (r.includes("frontend") || r.includes("ui"))
    return { body: "#2563eb", head: "#93c5fd", accent: "#60a5fa" };
  if (r.includes("backend") || r.includes("api"))
    return { body: "#059669", head: "#6ee7b7", accent: "#34d399" };
  if (r.includes("devops") || r.includes("infra"))
    return { body: "#d97706", head: "#fcd34d", accent: "#fbbf24" };
  if (r.includes("qa") || r.includes("quality") || r.includes("test"))
    return { body: "#9333ea", head: "#c084fc", accent: "#a855f7" };
  if (r.includes("design") || r.includes("ux"))
    return { body: "#ec4899", head: "#f9a8d4", accent: "#f472b6" };
  if (r.includes("pm") || r.includes("manager") || r.includes("product"))
    return { body: "#0891b2", head: "#67e8f9", accent: "#22d3ee" };
  return { body: "#4b5563", head: "#9ca3af", accent: "#6b7280" };
}

// ---------------------------------------------------------------------------
// Pixel Character SVG — 16x16 pixel art style
// ---------------------------------------------------------------------------

function PixelCharacter({
  colors,
  status,
  direction,
  walking,
}: {
  colors: { body: string; head: string; accent: string };
  status: string;
  direction: "left" | "right";
  walking: boolean;
}) {
  const isActive = status === "active";
  const isBreak = status === "on_break";
  const isError = status === "error";
  const flip = direction === "left" ? "scaleX(-1)" : "";

  return (
    <div
      className="relative"
      style={{
        transform: flip,
        animation: walking
          ? "pixelWalk 0.4s steps(2) infinite"
          : isActive
          ? "pixelBob 1.2s ease-in-out infinite"
          : isBreak
          ? "pixelSit 2s ease-in-out infinite"
          : "",
      }}
    >
      <svg width="24" height="32" viewBox="0 0 12 16" style={{ imageRendering: "pixelated" }}>
        {/* Shadow */}
        <ellipse cx="6" cy="15.5" rx="4" ry="0.5" fill="rgba(0,0,0,0.15)" />

        {/* Legs */}
        <rect x="3" y="12" width="2" height="3" fill={colors.body} rx="0.5"
          style={{ transform: walking ? "rotate(-10deg)" : "", transformOrigin: "4px 12px" }}
        />
        <rect x="7" y="12" width="2" height="3" fill={colors.body} rx="0.5"
          style={{ transform: walking ? "rotate(10deg)" : "", transformOrigin: "8px 12px" }}
        />

        {/* Body */}
        <rect x="2" y="7" width="8" height="6" fill={colors.body} rx="1" />

        {/* Arms */}
        <rect x="0" y="8" width="2" height="4" fill={colors.body} rx="0.5"
          style={{ transform: isActive ? "rotate(-15deg)" : "", transformOrigin: "2px 8px" }}
        />
        <rect x="10" y="8" width="2" height="4" fill={colors.body} rx="0.5"
          style={{ transform: isActive ? "rotate(15deg)" : "", transformOrigin: "10px 8px" }}
        />

        {/* Head */}
        <rect x="2" y="1" width="8" height="7" fill={colors.head} rx="2" />

        {/* Eyes */}
        <rect x="4" y="4" width="1.5" height="1.5" fill="#1e293b" rx="0.5" />
        <rect x="7" y="4" width="1.5" height="1.5" fill="#1e293b" rx="0.5" />

        {/* Mouth */}
        {isBreak ? (
          // Relaxed smile
          <path d="M5 6.5 Q6 7.5 7.5 6.5" stroke="#1e293b" strokeWidth="0.5" fill="none" />
        ) : isError ? (
          // Worried
          <path d="M4.5 7 Q6 6 7.5 7" stroke="#ef4444" strokeWidth="0.5" fill="none" />
        ) : (
          // Normal
          <rect x="5" y="6.5" width="2.5" height="0.5" fill="#1e293b" rx="0.25" />
        )}

        {/* Status indicator glow */}
        {isActive && (
          <circle cx="10" cy="2" r="1.5" fill="#22c55e">
            <animate attributeName="opacity" values="1;0.4;1" dur="1.5s" repeatCount="indefinite" />
          </circle>
        )}
        {isError && (
          <circle cx="10" cy="2" r="1.5" fill="#ef4444">
            <animate attributeName="opacity" values="1;0.3;1" dur="0.8s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Speech Bubble
// ---------------------------------------------------------------------------

function SpeechBubble({ text }: { text: string }) {
  const truncated = text.length > 28 ? text.slice(0, 26) + "..." : text;
  return (
    <div
      className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none"
      style={{ animation: "bubbleFadeIn 0.3s ease-out" }}
    >
      <div className="bg-white/95 backdrop-blur-sm text-[9px] text-gray-700 px-2 py-1 rounded-md shadow-md border border-gray-200 font-medium">
        {truncated}
      </div>
      <div className="w-2 h-2 bg-white border-r border-b border-gray-200 rotate-45 mx-auto -mt-1" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Furniture / Room Details
// ---------------------------------------------------------------------------

function Desk({ x, y }: { x: number; y: number }) {
  return (
    <rect x={x} y={y} width="20" height="12" rx="2" fill="#d4a574" stroke="#b8956a" strokeWidth="0.5" />
  );
}

function Chair({ x, y }: { x: number; y: number }) {
  return (
    <rect x={x} y={y} width="10" height="10" rx="5" fill="#6b7280" opacity="0.3" />
  );
}

function ServerRack({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width="14" height="24" rx="1" fill="#374151" />
      <rect x={x + 2} y={y + 3} width="10" height="2" rx="0.5" fill="#22c55e" opacity="0.6">
        <animate attributeName="opacity" values="0.6;1;0.6" dur="2s" repeatCount="indefinite" />
      </rect>
      <rect x={x + 2} y={y + 7} width="10" height="2" rx="0.5" fill="#3b82f6" opacity="0.6">
        <animate attributeName="opacity" values="0.6;1;0.6" dur="1.5s" repeatCount="indefinite" />
      </rect>
      <rect x={x + 2} y={y + 11} width="10" height="2" rx="0.5" fill="#22c55e" opacity="0.6">
        <animate attributeName="opacity" values="0.6;1;0.6" dur="1.8s" repeatCount="indefinite" />
      </rect>
      <rect x={x + 2} y={y + 15} width="10" height="2" rx="0.5" fill="#eab308" opacity="0.4">
        <animate attributeName="opacity" values="0.4;0.8;0.4" dur="2.2s" repeatCount="indefinite" />
      </rect>
    </g>
  );
}

function MeetingTable({ x, y }: { x: number; y: number }) {
  return (
    <ellipse cx={x} cy={y} rx="30" ry="16" fill="#92400e" opacity="0.3" />
  );
}

function CoffeeMachine({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width="12" height="16" rx="2" fill="#78716c" />
      <rect x={x + 2} y={y + 2} width="8" height="6" rx="1" fill="#292524" />
      <circle cx={x + 6} cy={y + 12} r="2" fill="#dc2626" opacity="0.7">
        <animate attributeName="opacity" values="0.7;1;0.7" dur="3s" repeatCount="indefinite" />
      </circle>
    </g>
  );
}

function Whiteboard({ x, y, w }: { x: number; y: number; w: number }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height="6" rx="1" fill="#e5e7eb" stroke="#d1d5db" strokeWidth="0.5" />
      <line x1={x + 4} y1={y + 2} x2={x + w * 0.3} y2={y + 2} stroke="#3b82f6" strokeWidth="0.5" />
      <line x1={x + 4} y1={y + 4} x2={x + w * 0.5} y2={y + 4} stroke="#ef4444" strokeWidth="0.5" />
    </g>
  );
}

function Plant({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y + 6} width="6" height="6" rx="1" fill="#92400e" opacity="0.5" />
      <circle cx={x + 3} cy={y + 3} r="5" fill="#22c55e" opacity="0.5" />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Room SVG decoration
// ---------------------------------------------------------------------------

function RoomFurniture({ room }: { room: Room }) {
  switch (room.id) {
    case "ceo-office":
      return (
        <g>
          <Desk x={room.x + 60} y={room.y + 40} />
          <Chair x={room.x + 65} y={room.y + 55} />
          <Plant x={room.x + 160} y={room.y + 20} />
          <Whiteboard x={room.x + 30} y={room.y + 15} w={60} />
        </g>
      );
    case "dev-floor":
      return (
        <g>
          {/* Row of desks */}
          <Desk x={room.x + 25} y={room.y + 35} />
          <Desk x={room.x + 95} y={room.y + 35} />
          <Desk x={room.x + 165} y={room.y + 35} />
          <Desk x={room.x + 235} y={room.y + 35} />
          <Desk x={room.x + 25} y={room.y + 85} />
          <Desk x={room.x + 95} y={room.y + 85} />
          <Desk x={room.x + 165} y={room.y + 85} />
          <Desk x={room.x + 235} y={room.y + 85} />
          <Plant x={room.x + 310} y={room.y + 20} />
        </g>
      );
    case "qa-lab":
      return (
        <g>
          <Desk x={room.x + 25} y={room.y + 45} />
          <Desk x={room.x + 95} y={room.y + 45} />
          <Desk x={room.x + 25} y={room.y + 90} />
          <Desk x={room.x + 95} y={room.y + 90} />
          <Whiteboard x={room.x + 20} y={room.y + 15} w={80} />
        </g>
      );
    case "meeting-room":
      return (
        <g>
          <MeetingTable x={room.x + 100} y={room.y + 75} />
          <Whiteboard x={room.x + 20} y={room.y + 15} w={100} />
        </g>
      );
    case "break-room":
      return (
        <g>
          <CoffeeMachine x={room.x + 160} y={room.y + 20} />
          <MeetingTable x={room.x + 80} y={room.y + 80} />
          <Plant x={room.x + 15} y={room.y + 15} />
        </g>
      );
    case "server-room":
      return (
        <g>
          <ServerRack x={room.x + 20} y={room.y + 30} />
          <ServerRack x={room.x + 50} y={room.y + 30} />
          <ServerRack x={room.x + 80} y={room.y + 30} />
          <ServerRack x={room.x + 110} y={room.y + 30} />
        </g>
      );
    default:
      return (
        <g>
          <Plant x={room.x + 15} y={room.y + 15} />
          <Plant x={room.x + 100} y={room.y + 100} />
        </g>
      );
  }
}

// ---------------------------------------------------------------------------
// Agent position state
// ---------------------------------------------------------------------------

interface AgentPosition {
  agentId: string;
  roomId: string;
  x: number;
  y: number;
  direction: "left" | "right";
  task: Task | undefined;
}

function computePositions(
  agents: Agent[],
  tasks: Task[]
): AgentPosition[] {
  const roomSlotIdx: Record<string, number> = {};

  return agents.map((agent) => {
    const currentTask = tasks.find(
      (t) =>
        t.assignedTo === agent.id &&
        (t.status === "in_progress" || t.status === "assigned" || t.status === "review")
    );

    const roomId = agentToRoom(agent, currentTask);
    const room = ROOMS.find((r) => r.id === roomId) ?? ROOMS[ROOMS.length - 1];
    const slotIdx = roomSlotIdx[roomId] ?? 0;
    roomSlotIdx[roomId] = slotIdx + 1;

    const slot = room.slots[slotIdx % room.slots.length];

    return {
      agentId: agent.id,
      roomId,
      x: room.x + slot.x,
      y: room.y + slot.y,
      direction: slotIdx % 2 === 0 ? "right" : "left" as const,
      task: currentTask,
    };
  });
}

// ---------------------------------------------------------------------------
// Main Page Component
// ---------------------------------------------------------------------------

export default function OfficePage() {
  const { resolved: theme } = useTheme();
  const isDark = theme === "dark";
  const [agents, setAgents] = useState<Agent[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null);
  const [prevPositions, setPrevPositions] = useState<Record<string, { x: number; y: number }>>({});

  useEffect(() => {
    fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
    fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});

    const interval = setInterval(() => {
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  const positions = useMemo(() => computePositions(agents, tasks), [agents, tasks]);

  // Track previous positions for walking animation
  useEffect(() => {
    const timer = setTimeout(() => {
      const newPrev: Record<string, { x: number; y: number }> = {};
      positions.forEach((p) => {
        newPrev[p.agentId] = { x: p.x, y: p.y };
      });
      setPrevPositions(newPrev);
    }, 1200);
    return () => clearTimeout(timer);
  }, [positions]);

  const getAgent = (id: string) => agents.find((a) => a.id === id);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">The Office</h1>
          <p className="text-sm text-gray-500 mt-1">
            Live view of your AI team — {agents.filter((a) => a.status === "active").length} working,{" "}
            {agents.filter((a) => a.status === "on_break").length} on break
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500 animate-pulse" /> Working
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-2.5 h-2.5 rounded-full bg-gray-400" /> Idle
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-2.5 h-2.5 rounded-full bg-orange-400" /> Break
          </div>
          <div className="flex items-center gap-1.5 text-xs text-gray-500">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500" /> Error
          </div>
        </div>
      </div>

      <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800 p-4 overflow-x-auto transition-colors duration-300">
        <div className="relative" style={{ width: 800, height: 350, minWidth: 800 }}>
          {/* Room backgrounds as SVG */}
          <svg
            width="800"
            height="350"
            viewBox="0 0 800 350"
            className="absolute inset-0"
            style={{ imageRendering: "auto" }}
          >
            {/* Grid pattern */}
            <defs>
              <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                <path d="M 20 0 L 0 0 0 20" fill="none" stroke={isDark ? "#1f2937" : "#e5e7eb"} strokeWidth="0.3" />
              </pattern>
            </defs>
            <rect width="800" height="350" fill={isDark ? "#111827" : "url(#grid)"} />
            {!isDark && <rect width="800" height="350" fill="url(#grid)" />}

            {/* Rooms */}
            {ROOMS.map((room) => (
              <g key={room.id}>
                {/* Room floor */}
                <rect
                  x={room.x}
                  y={room.y}
                  width={room.w}
                  height={room.h}
                  rx={8}
                  fill={isDark ? "#1a1f2e" : room.floorColor}
                  stroke={isDark ? room.color + "80" : room.color}
                  strokeWidth="1.5"
                  strokeDasharray={room.id === "hallway" ? "4 2" : "none"}
                  opacity={isDark ? 0.95 : 0.9}
                />
                {/* Room label */}
                <text
                  x={room.x + 10}
                  y={room.y + 14}
                  fill={room.color}
                  fontSize="9"
                  fontWeight="600"
                  fontFamily="system-ui, sans-serif"
                  opacity="0.7"
                >
                  {room.emoji} {room.label}
                </text>

                {/* Furniture */}
                <RoomFurniture room={room} />
              </g>
            ))}
          </svg>

          {/* Agent characters — positioned absolutely on top of SVG */}
          {positions.map((pos) => {
            const agent = getAgent(pos.agentId);
            if (!agent) return null;
            const colors = agentColors(agent.role);
            const prev = prevPositions[pos.agentId];
            const isWalking = prev && (Math.abs(prev.x - pos.x) > 5 || Math.abs(prev.y - pos.y) > 5);
            const isHovered = hoveredAgent === pos.agentId;

            return (
              <div
                key={pos.agentId}
                className="absolute cursor-pointer"
                style={{
                  left: pos.x - 12,
                  top: pos.y - 16,
                  width: 24,
                  height: 32,
                  transition: "left 1s ease-in-out, top 1s ease-in-out",
                  zIndex: isHovered ? 30 : 10,
                }}
                onMouseEnter={() => setHoveredAgent(pos.agentId)}
                onMouseLeave={() => setHoveredAgent(null)}
              >
                {/* Speech bubble — shown on hover or for active agents */}
                {(isHovered || (agent.status === "active" && pos.task)) && pos.task && (
                  <SpeechBubble text={pos.task.title || pos.task.id} />
                )}

                {/* Hover name label */}
                {isHovered && (
                  <div
                    className="absolute -top-[52px] left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none"
                    style={{ animation: "bubbleFadeIn 0.15s ease-out" }}
                  >
                    <div className="bg-gray-900 text-white text-[10px] px-2 py-0.5 rounded font-semibold shadow-lg">
                      {agent.name}
                    </div>
                  </div>
                )}

                <PixelCharacter
                  colors={colors}
                  status={agent.status}
                  direction={pos.direction}
                  walking={!!isWalking}
                />
              </div>
            );
          })}
        </div>
      </div>

      {/* Agent roster below the office */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
        {agents.map((agent) => {
          const pos = positions.find((p) => p.agentId === agent.id);
          const room = pos ? ROOMS.find((r) => r.id === pos.roomId) : null;
          const colors = agentColors(agent.role);

          return (
            <div
              key={agent.id}
              className={`bg-white dark:bg-gray-900 rounded-lg border p-2.5 cursor-pointer transition-all text-center ${
                hoveredAgent === agent.id
                  ? "border-blue-300 shadow-md ring-2 ring-blue-100"
                  : "border-gray-100 dark:border-gray-800 hover:border-gray-200 dark:hover:border-gray-700 hover:shadow-sm"
              }`}
              onMouseEnter={() => setHoveredAgent(agent.id)}
              onMouseLeave={() => setHoveredAgent(null)}
            >
              <div className="flex justify-center mb-1.5">
                <PixelCharacter
                  colors={colors}
                  status={agent.status}
                  direction="right"
                  walking={false}
                />
              </div>
              <p className="text-xs font-semibold text-gray-900 dark:text-gray-100 truncate">{agent.name}</p>
              <p className="text-[10px] text-gray-400 truncate">{agent.role}</p>
              {room && (
                <p className="text-[10px] mt-0.5 truncate" style={{ color: room.color }}>
                  {room.label}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

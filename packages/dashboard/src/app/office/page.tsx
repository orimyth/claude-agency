"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import { useTheme } from "@/components/theme-provider";
import { fetchAgents, fetchTasks } from "@/lib/api";
import { taskStyle } from "@/lib/status-colors";
import type { Agent, Task } from "@/lib/api";

// ---------------------------------------------------------------------------
// Room definitions
// ---------------------------------------------------------------------------

interface Room {
  id: string;
  label: string;
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
  if (agent.status === "on_break") return "break-room";
  if (agent.status === "idle" && !task) return "hallway";
  if (agent.status === "error") return "server-room";

  const role = agent.role.toLowerCase();
  if (role.includes("ceo") || role.includes("chief")) return "ceo-office";
  if (role.includes("devops") || role.includes("infra") || role.includes("ops")) return "server-room";
  if (role.includes("qa") || role.includes("quality") || role.includes("test")) return "qa-lab";

  if (task) {
    if (task.status === "review") return "meeting-room";
    if (task.status === "in_progress") {
      if (/qa|test|quality/i.test(task.title)) return "qa-lab";
      return "dev-floor";
    }
    if (task.status === "assigned") return "dev-floor";
  }

  if (agent.status === "active") return "dev-floor";
  return "hallway";
}

// ---------------------------------------------------------------------------
// Pixel Character Colors + accessories based on role
// ---------------------------------------------------------------------------

interface CharStyle {
  body: string;
  head: string;
  accent: string;
  hair: string;
  hairStyle: "spiky" | "neat" | "long" | "bun" | "mohawk" | "cap" | "none" | "short";
  accessory: "glasses" | "headset" | "tie" | "badge" | "none";
}

function agentStyle(role: string, idx: number): CharStyle {
  const r = role.toLowerCase();
  if (r.includes("ceo") || r.includes("chief"))
    return { body: "#7c3aed", head: "#ddd6fe", accent: "#fbbf24", hair: "#4c1d95", hairStyle: "neat", accessory: "tie" };
  if (r.includes("frontend") || r.includes("ui"))
    return { body: "#2563eb", head: "#bfdbfe", accent: "#60a5fa", hair: "#1e3a5f", hairStyle: "spiky", accessory: "headset" };
  if (r.includes("backend") || r.includes("api"))
    return { body: "#059669", head: "#a7f3d0", accent: "#34d399", hair: "#064e3b", hairStyle: "short", accessory: "glasses" };
  if (r.includes("devops") || r.includes("infra"))
    return { body: "#d97706", head: "#fde68a", accent: "#fbbf24", hair: "#78350f", hairStyle: "cap", accessory: "badge" };
  if (r.includes("qa") || r.includes("quality") || r.includes("test"))
    return { body: "#9333ea", head: "#e9d5ff", accent: "#a855f7", hair: "#581c87", hairStyle: "bun", accessory: "glasses" };
  if (r.includes("design") || r.includes("ux"))
    return { body: "#ec4899", head: "#fbcfe8", accent: "#f472b6", hair: "#831843", hairStyle: "long", accessory: "none" };
  if (r.includes("pm") || r.includes("manager") || r.includes("product"))
    return { body: "#0891b2", head: "#a5f3fc", accent: "#22d3ee", hair: "#164e63", hairStyle: "neat", accessory: "badge" };
  // Alternate styles for generic roles
  const styles: CharStyle[] = [
    { body: "#4b5563", head: "#d1d5db", accent: "#6b7280", hair: "#1f2937", hairStyle: "short", accessory: "none" },
    { body: "#6366f1", head: "#c7d2fe", accent: "#818cf8", hair: "#312e81", hairStyle: "spiky", accessory: "headset" },
  ];
  return styles[idx % styles.length];
}

// ---------------------------------------------------------------------------
// Emote system — role-based emotes that float above agents
// ---------------------------------------------------------------------------

const ROLE_EMOTES: Record<string, string[]> = {
  ceo: ["📊", "💡", "🎯", "📈", "🏆"],
  frontend: ["🎨", "💻", "⚛️", "🖌️", "✨"],
  backend: ["⚙️", "🔧", "🗄️", "🔌", "💾"],
  devops: ["🚀", "🐳", "☁️", "🔒", "📦"],
  qa: ["🔍", "🐛", "✅", "🧪", "📋"],
  design: ["🎨", "✏️", "🖼️", "💎", "🌈"],
  pm: ["📅", "📝", "🤝", "📊", "🎯"],
  default: ["💻", "📁", "✅", "⚡", "🔧"],
  break: ["☕", "🍕", "🎮", "😴", "🧘"],
  error: ["⚠️", "🔥", "💥", "🆘", "❌"],
};

function getEmotesForAgent(agent: Agent): string[] {
  if (agent.status === "on_break") return ROLE_EMOTES.break;
  if (agent.status === "error") return ROLE_EMOTES.error;
  const r = agent.role.toLowerCase();
  for (const key of Object.keys(ROLE_EMOTES)) {
    if (key !== "default" && key !== "break" && key !== "error" && r.includes(key)) return ROLE_EMOTES[key];
  }
  return ROLE_EMOTES.default;
}

// ---------------------------------------------------------------------------
// Pixel Character SVG — enhanced with hair + accessories
// ---------------------------------------------------------------------------

function PixelCharacter({
  style: cs,
  status,
  direction,
  walking,
  size = 1,
}: {
  style: CharStyle;
  status: string;
  direction: "left" | "right";
  walking: boolean;
  size?: number;
}) {
  const isActive = status === "active";
  const isBreak = status === "on_break";
  const isError = status === "error";
  const flip = direction === "left" ? "scaleX(-1)" : "";
  const w = 24 * size;
  const h = 32 * size;

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
        width: w,
        height: h,
      }}
    >
      <svg width={w} height={h} viewBox="0 0 12 16" style={{ imageRendering: "pixelated" }}>
        {/* Shadow */}
        <ellipse cx="6" cy="15.5" rx="4" ry="0.5" fill="rgba(0,0,0,0.15)" />

        {/* Legs */}
        <rect x="3" y="12" width="2" height="3" fill={cs.body} rx="0.5"
          style={{ transform: walking ? "rotate(-10deg)" : "", transformOrigin: "4px 12px" }}
        />
        <rect x="7" y="12" width="2" height="3" fill={cs.body} rx="0.5"
          style={{ transform: walking ? "rotate(10deg)" : "", transformOrigin: "8px 12px" }}
        />

        {/* Body */}
        <rect x="2" y="7" width="8" height="6" fill={cs.body} rx="1" />

        {/* Arms */}
        <rect x="0" y="8" width="2" height="4" fill={cs.body} rx="0.5"
          style={{ transform: isActive ? "rotate(-15deg)" : isBreak ? "rotate(-5deg)" : "", transformOrigin: "2px 8px" }}
        />
        <rect x="10" y="8" width="2" height="4" fill={cs.body} rx="0.5"
          style={{ transform: isActive ? "rotate(15deg)" : isBreak ? "rotate(5deg)" : "", transformOrigin: "10px 8px" }}
        />

        {/* Tie accessory */}
        {cs.accessory === "tie" && (
          <polygon points="6,7.5 5.3,10 6.7,10" fill={cs.accent} />
        )}

        {/* Badge accessory */}
        {cs.accessory === "badge" && (
          <rect x="3" y="8" width="2" height="2" rx="0.5" fill={cs.accent} />
        )}

        {/* Head */}
        <rect x="2" y="1" width="8" height="7" fill={cs.head} rx="2" />

        {/* Hair styles */}
        {cs.hairStyle === "spiky" && (
          <g fill={cs.hair}>
            <rect x="2" y="0.5" width="8" height="2.5" rx="1" />
            <rect x="3" y="-0.5" width="2" height="2" rx="0.5" />
            <rect x="6" y="-0.3" width="2" height="1.8" rx="0.5" />
            <rect x="8" y="0" width="2" height="1.5" rx="0.5" />
          </g>
        )}
        {cs.hairStyle === "neat" && (
          <g fill={cs.hair}>
            <rect x="2" y="0.5" width="8" height="2" rx="1" />
            <rect x="1.5" y="1.5" width="2" height="3" rx="0.5" />
          </g>
        )}
        {cs.hairStyle === "long" && (
          <g fill={cs.hair}>
            <rect x="2" y="0.5" width="8" height="2" rx="1" />
            <rect x="1" y="1" width="2" height="6" rx="0.5" />
            <rect x="9" y="1" width="2" height="6" rx="0.5" />
          </g>
        )}
        {cs.hairStyle === "bun" && (
          <g fill={cs.hair}>
            <rect x="2" y="0.5" width="8" height="2" rx="1" />
            <circle cx="6" cy="0" r="2" />
          </g>
        )}
        {cs.hairStyle === "mohawk" && (
          <g fill={cs.hair}>
            <rect x="4" y="-1" width="4" height="3" rx="1" />
          </g>
        )}
        {cs.hairStyle === "cap" && (
          <g>
            <rect x="1" y="0.5" width="10" height="2.5" rx="1" fill={cs.accent} />
            <rect x="0" y="2.5" width="3" height="1" rx="0.5" fill={cs.accent} />
          </g>
        )}
        {cs.hairStyle === "short" && (
          <g fill={cs.hair}>
            <rect x="2" y="0.5" width="8" height="2.5" rx="1" />
          </g>
        )}

        {/* Glasses accessory */}
        {cs.accessory === "glasses" && (
          <g stroke="#374151" strokeWidth="0.4" fill="none">
            <circle cx="4.5" cy="4.2" r="1.3" />
            <circle cx="7.5" cy="4.2" r="1.3" />
            <line x1="5.8" y1="4.2" x2="6.2" y2="4.2" />
          </g>
        )}

        {/* Headset accessory */}
        {cs.accessory === "headset" && (
          <g stroke="#374151" strokeWidth="0.5" fill="none">
            <path d="M2,3.5 Q2,-0.5 10,3.5" />
            <rect x="0.5" y="3" width="2" height="2.5" rx="0.5" fill="#374151" />
          </g>
        )}

        {/* Eyes */}
        <rect x="4" y="4" width="1.5" height="1.5" fill="#1e293b" rx="0.5" />
        <rect x="7" y="4" width="1.5" height="1.5" fill="#1e293b" rx="0.5" />
        {/* Eye shine */}
        <rect x="4.3" y="4.2" width="0.5" height="0.5" fill="white" rx="0.25" opacity="0.6" />
        <rect x="7.3" y="4.2" width="0.5" height="0.5" fill="white" rx="0.25" opacity="0.6" />

        {/* Mouth */}
        {isBreak ? (
          <path d="M5 6.5 Q6 7.5 7.5 6.5" stroke="#1e293b" strokeWidth="0.5" fill="none" />
        ) : isError ? (
          <path d="M4.5 7 Q6 6 7.5 7" stroke="#ef4444" strokeWidth="0.5" fill="none" />
        ) : isActive ? (
          <path d="M5 6.3 Q6 7 7.5 6.3" stroke="#1e293b" strokeWidth="0.5" fill="none" />
        ) : (
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

        {/* Break: holding coffee mug */}
        {isBreak && (
          <g>
            <rect x="10.5" y="9" width="2" height="2.5" rx="0.5" fill="#78716c" />
            <rect x="10.5" y="8.5" width="2" height="0.8" rx="0.3" fill="#a16207" />
            {/* Steam */}
            <line x1="11" y1="8" x2="11.2" y2="7" stroke="#9ca3af" strokeWidth="0.3" opacity="0.5">
              <animate attributeName="opacity" values="0.5;0.2;0.5" dur="2s" repeatCount="indefinite" />
            </line>
            <line x1="12" y1="8.2" x2="11.8" y2="7.2" stroke="#9ca3af" strokeWidth="0.3" opacity="0.3">
              <animate attributeName="opacity" values="0.3;0.1;0.3" dur="1.5s" repeatCount="indefinite" />
            </line>
          </g>
        )}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Floating Emote Component
// ---------------------------------------------------------------------------

function FloatingEmote({ emote, onDone }: { emote: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2200);
    return () => clearTimeout(t);
  }, [onDone]);

  return (
    <div
      className="absolute -top-3 left-1/2 -translate-x-1/2 pointer-events-none text-sm"
      style={{ animation: "emoteFloat 2.2s ease-out forwards" }}
    >
      {emote}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typing Sparkles — particles that appear when agent is working
// ---------------------------------------------------------------------------

function TypingSparkles() {
  return (
    <div className="absolute -top-1 left-0 w-6 h-4 pointer-events-none overflow-visible">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="absolute w-1 h-1 rounded-full"
          style={{
            background: ["#fbbf24", "#60a5fa", "#34d399"][i],
            left: `${4 + i * 6}px`,
            top: "0px",
            "--sx": `${(i - 1) * 3}px`,
            "--sy": `-${4 + i * 2}px`,
            "--ex": `${(i - 1) * 6}px`,
            "--ey": `-${10 + i * 3}px`,
            animation: `sparkle 1.2s ${i * 0.3}s ease-out infinite`,
          } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Speech Bubble
// ---------------------------------------------------------------------------

function SpeechBubble({ text, dark }: { text: string; dark?: boolean }) {
  const truncated = text.length > 28 ? text.slice(0, 26) + "..." : text;
  return (
    <div
      className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none"
      style={{ animation: "bubbleFadeIn 0.3s ease-out" }}
    >
      <div className={`text-[9px] px-2 py-1 rounded-md shadow-md border font-medium backdrop-blur-sm ${
        dark
          ? "bg-gray-800/95 text-gray-200 border-gray-700"
          : "bg-white/95 text-gray-700 border-gray-200"
      }`}>
        {truncated}
      </div>
      <div className={`w-2 h-2 rotate-45 mx-auto -mt-1 border-r border-b ${
        dark ? "bg-gray-800 border-gray-700" : "bg-white border-gray-200"
      }`} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Furniture / Room Details — enhanced
// ---------------------------------------------------------------------------

function Desk({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <rect x={x} y={y} width="20" height="12" rx="2" fill="#d4a574" stroke="#b8956a" strokeWidth="0.5" />
      {/* Monitor */}
      <rect x={x + 5} y={y - 8} width="10" height="7" rx="1" fill="#1e293b" />
      <rect x={x + 6} y={y - 7} width="8" height="5" rx="0.5" fill="#0f172a">
        {/* Screen glow */}
        <animate attributeName="fill" values="#0f172a;#1e293b;#0f172a" dur="4s" repeatCount="indefinite" />
      </rect>
      {/* Code lines on screen */}
      <line x1={x + 7} y1={y - 5.5} x2={x + 11} y2={y - 5.5} stroke="#22c55e" strokeWidth="0.4" opacity="0.7">
        <animate attributeName="opacity" values="0.7;1;0.7" dur="2s" repeatCount="indefinite" />
      </line>
      <line x1={x + 7} y1={y - 4} x2={x + 12} y2={y - 4} stroke="#60a5fa" strokeWidth="0.4" opacity="0.6">
        <animate attributeName="opacity" values="0.6;0.9;0.6" dur="2.5s" repeatCount="indefinite" />
      </line>
      <line x1={x + 7} y1={y - 2.5} x2={x + 10} y2={y - 2.5} stroke="#a78bfa" strokeWidth="0.4" opacity="0.5" />
      {/* Monitor stand */}
      <rect x={x + 9} y={y - 1} width="2" height="1.5" fill="#6b7280" />
    </g>
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
      {/* Activity LED */}
      <circle cx={x + 12} cy={y + 21} r="0.8" fill="#ef4444">
        <animate attributeName="opacity" values="1;0;1" dur="0.5s" repeatCount="indefinite" />
      </circle>
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
      {/* Steam wisps */}
      <g opacity="0.4">
        <path d={`M${x + 4} ${y - 1} Q${x + 5} ${y - 5} ${x + 3} ${y - 8}`} stroke="#9ca3af" strokeWidth="0.6" fill="none">
          <animate attributeName="opacity" values="0.4;0.1;0.4" dur="3s" repeatCount="indefinite" />
        </path>
        <path d={`M${x + 8} ${y - 1} Q${x + 7} ${y - 4} ${x + 9} ${y - 7}`} stroke="#9ca3af" strokeWidth="0.6" fill="none">
          <animate attributeName="opacity" values="0.3;0.1;0.3" dur="2.5s" repeatCount="indefinite" />
        </path>
      </g>
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
      <circle cx={x + 1} cy={y + 1} r="3" fill="#16a34a" opacity="0.3" />
    </g>
  );
}

function WallClock({ x, y }: { x: number; y: number }) {
  const now = new Date();
  const hours = now.getHours() % 12;
  const minutes = now.getMinutes();
  const hourAngle = (hours + minutes / 60) * 30;
  const minuteAngle = minutes * 6;

  return (
    <g>
      <circle cx={x} cy={y} r="7" fill="white" stroke="#d1d5db" strokeWidth="0.5" />
      <circle cx={x} cy={y} r="0.8" fill="#374151" />
      {/* Hour hand */}
      <line
        x1={x} y1={y}
        x2={x + 3.5 * Math.sin((hourAngle * Math.PI) / 180)}
        y2={y - 3.5 * Math.cos((hourAngle * Math.PI) / 180)}
        stroke="#374151" strokeWidth="0.8" strokeLinecap="round"
      />
      {/* Minute hand */}
      <line
        x1={x} y1={y}
        x2={x + 5 * Math.sin((minuteAngle * Math.PI) / 180)}
        y2={y - 5 * Math.cos((minuteAngle * Math.PI) / 180)}
        stroke="#6b7280" strokeWidth="0.5" strokeLinecap="round"
      />
      {/* Hour markers */}
      {[0, 90, 180, 270].map((angle) => (
        <circle
          key={angle}
          cx={x + 5.5 * Math.sin((angle * Math.PI) / 180)}
          cy={y - 5.5 * Math.cos((angle * Math.PI) / 180)}
          r="0.5" fill="#9ca3af"
        />
      ))}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Room SVG decoration — enhanced
// ---------------------------------------------------------------------------

function RoomFurniture({ room }: { room: Room }) {
  switch (room.id) {
    case "ceo-office":
      return (
        <g>
          <Desk x={room.x + 60} y={room.y + 50} />
          <Chair x={room.x + 65} y={room.y + 65} />
          <Plant x={room.x + 160} y={room.y + 20} />
          <Whiteboard x={room.x + 30} y={room.y + 15} w={60} />
          <WallClock x={room.x + 170} y={room.y + 14} />
        </g>
      );
    case "dev-floor":
      return (
        <g>
          <Desk x={room.x + 25} y={room.y + 35} />
          <Desk x={room.x + 95} y={room.y + 35} />
          <Desk x={room.x + 165} y={room.y + 35} />
          <Desk x={room.x + 235} y={room.y + 35} />
          <Desk x={room.x + 25} y={room.y + 85} />
          <Desk x={room.x + 95} y={room.y + 85} />
          <Desk x={room.x + 165} y={room.y + 85} />
          <Desk x={room.x + 235} y={room.y + 85} />
          <Plant x={room.x + 310} y={room.y + 20} />
          <WallClock x={room.x + 310} y={room.y + 14} />
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
          <WallClock x={room.x + 170} y={room.y + 14} />
        </g>
      );
    case "break-room":
      return (
        <g>
          <CoffeeMachine x={room.x + 160} y={room.y + 20} />
          <MeetingTable x={room.x + 80} y={room.y + 80} />
          <Plant x={room.x + 15} y={room.y + 15} />
          <WallClock x={room.x + 140} y={room.y + 14} />
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

function computePositions(agents: Agent[], tasks: Task[]): AgentPosition[] {
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
      direction: slotIdx % 2 === 0 ? ("right" as const) : ("left" as const),
      task: currentTask,
    };
  });
}

// ---------------------------------------------------------------------------
// Agent Detail Panel — click to inspect
// ---------------------------------------------------------------------------

function AgentDetailPanel({
  agent,
  task,
  room,
  onClose,
  isDark,
}: {
  agent: Agent;
  task: Task | undefined;
  room: Room | undefined;
  onClose: () => void;
  isDark: boolean;
}) {
  const cs = agentStyle(agent.role, 0);
  const tStyle = task ? taskStyle(task.status) : null;

  return (
    <div
      className={`rounded-xl border p-4 shadow-lg ${
        isDark ? "bg-gray-900 border-gray-700" : "bg-white border-gray-200"
      }`}
      style={{ animation: "panelSlideIn 0.25s ease-out", minWidth: 280 }}
    >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="flex-shrink-0">
            <PixelCharacter style={cs} status={agent.status} direction="right" walking={false} size={1.5} />
          </div>
          <div>
            <p className={`font-semibold text-sm ${isDark ? "text-white" : "text-gray-900"}`}>{agent.name}</p>
            <p className="text-xs text-gray-500">{agent.role}</p>
          </div>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors p-1">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Status + Location */}
      <div className="flex items-center gap-2 mb-3">
        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
          agent.status === "active" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" :
          agent.status === "on_break" ? "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400" :
          agent.status === "error" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" :
          "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
        }`}>
          {agent.status === "active" ? "Working" : agent.status === "on_break" ? "On Break" : agent.status === "error" ? "Error" : "Idle"}
        </span>
        {room && (
          <span className="text-[10px] px-2 py-0.5 rounded-full border" style={{ color: room.color, borderColor: room.color + "40" }}>
            {room.label}
          </span>
        )}
      </div>

      {/* Current Task */}
      {task && tStyle && (
        <div className={`rounded-lg border p-3 ${isDark ? "border-gray-700 bg-gray-800" : "border-gray-100 bg-gray-50"}`}>
          <div className="flex items-center justify-between mb-1">
            <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Current Task</span>
            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${tStyle.bg} ${tStyle.text}`}>
              {tStyle.label}
            </span>
          </div>
          <p className={`text-xs font-medium ${isDark ? "text-gray-200" : "text-gray-800"}`}>
            {task.title || task.id}
          </p>
          {task.description && (
            <p className="text-[10px] text-gray-400 mt-1 line-clamp-2">{task.description}</p>
          )}
        </div>
      )}

      {!task && (
        <p className="text-xs text-gray-400 italic">No active task assigned</p>
      )}

      {/* Channels */}
      {agent.channels && agent.channels.length > 0 && (
        <div className="mt-3">
          <span className="text-[10px] font-medium text-gray-500 uppercase tracking-wide">Channels</span>
          <div className="flex flex-wrap gap-1 mt-1">
            {agent.channels.map((ch) => (
              <span key={ch} className={`text-[10px] px-1.5 py-0.5 rounded ${isDark ? "bg-gray-800 text-gray-400" : "bg-gray-100 text-gray-500"}`}>
                #{ch}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
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
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [prevPositions, setPrevPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [emotes, setEmotes] = useState<Record<string, string>>({});
  const [clockTick, setClockTick] = useState(0);

  useEffect(() => {
    fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
    fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});

    const interval = setInterval(() => {
      fetchAgents().then((d) => { if (Array.isArray(d)) setAgents(d); }).catch(() => {});
      fetchTasks().then((d) => { if (Array.isArray(d)) setTasks(d); }).catch(() => {});
    }, 4000);
    return () => clearInterval(interval);
  }, []);

  // Clock update every minute
  useEffect(() => {
    const t = setInterval(() => setClockTick((c) => c + 1), 60000);
    return () => clearInterval(t);
  }, []);

  // Random emotes
  useEffect(() => {
    if (agents.length === 0) return;
    const interval = setInterval(() => {
      // Pick a random active agent
      const candidates = agents.filter((a) => a.status === "active" || a.status === "on_break");
      if (candidates.length === 0) return;
      const agent = candidates[Math.floor(Math.random() * candidates.length)];
      const pool = getEmotesForAgent(agent);
      const emote = pool[Math.floor(Math.random() * pool.length)];
      setEmotes((prev) => ({ ...prev, [agent.id]: emote }));
    }, 3000);
    return () => clearInterval(interval);
  }, [agents]);

  const removeEmote = useCallback((agentId: string) => {
    setEmotes((prev) => {
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
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
  const selectedAgentData = selectedAgent ? getAgent(selectedAgent) : null;
  const selectedPos = selectedAgent ? positions.find((p) => p.agentId === selectedAgent) : null;
  const selectedRoom = selectedPos ? ROOMS.find((r) => r.id === selectedPos.roomId) : undefined;

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

      <div className="flex gap-4">
        {/* Main office view */}
        <div className="flex-1 bg-white dark:bg-gray-900 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-800 p-4 overflow-x-auto transition-colors duration-300">
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
                  <text
                    x={room.x + 10}
                    y={room.y + 14}
                    fill={room.color}
                    fontSize="9"
                    fontWeight="600"
                    fontFamily="system-ui, sans-serif"
                    opacity="0.7"
                  >
                    {room.label}
                  </text>
                  <RoomFurniture room={room} />
                </g>
              ))}
            </svg>

            {/* Agent characters */}
            {positions.map((pos, idx) => {
              const agent = getAgent(pos.agentId);
              if (!agent) return null;
              const cs = agentStyle(agent.role, idx);
              const prev = prevPositions[pos.agentId];
              const isWalking = prev && (Math.abs(prev.x - pos.x) > 5 || Math.abs(prev.y - pos.y) > 5);
              const isHovered = hoveredAgent === pos.agentId;
              const isSelected = selectedAgent === pos.agentId;
              const emote = emotes[pos.agentId];
              const isWorking = agent.status === "active" && pos.task;

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
                    zIndex: isHovered || isSelected ? 30 : 10,
                  }}
                  onMouseEnter={() => setHoveredAgent(pos.agentId)}
                  onMouseLeave={() => setHoveredAgent(null)}
                  onClick={() => setSelectedAgent(isSelected ? null : pos.agentId)}
                >
                  {/* Floating emote */}
                  {emote && (
                    <FloatingEmote emote={emote} onDone={() => removeEmote(pos.agentId)} />
                  )}

                  {/* Typing sparkles for working agents */}
                  {isWorking && !isWalking && <TypingSparkles />}

                  {/* Speech bubble — shown on hover */}
                  {isHovered && pos.task && (
                    <SpeechBubble text={pos.task.title || pos.task.id} dark={isDark} />
                  )}

                  {/* Hover name label */}
                  {isHovered && !pos.task && (
                    <div
                      className="absolute -top-9 left-1/2 -translate-x-1/2 whitespace-nowrap pointer-events-none"
                      style={{ animation: "bubbleFadeIn 0.15s ease-out" }}
                    >
                      <div className={`text-[10px] px-2 py-0.5 rounded font-semibold shadow-lg ${
                        isDark ? "bg-gray-700 text-white" : "bg-gray-900 text-white"
                      }`}>
                        {agent.name}
                      </div>
                    </div>
                  )}

                  {/* Selection ring */}
                  {isSelected && (
                    <div
                      className="absolute inset-[-4px] rounded-full border-2 border-blue-400 dark:border-blue-500"
                      style={{ animation: "statusGlow 1.5s ease-in-out infinite" }}
                    />
                  )}

                  <PixelCharacter
                    style={cs}
                    status={agent.status}
                    direction={pos.direction}
                    walking={!!isWalking}
                  />
                </div>
              );
            })}
          </div>
        </div>

        {/* Detail Panel — shows when an agent is selected */}
        {selectedAgentData && (
          <div className="flex-shrink-0 w-[300px]">
            <AgentDetailPanel
              agent={selectedAgentData}
              task={selectedPos?.task}
              room={selectedRoom}
              onClose={() => setSelectedAgent(null)}
              isDark={isDark}
            />
          </div>
        )}
      </div>

      {/* Agent roster below the office */}
      <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
        {agents.map((agent, idx) => {
          const pos = positions.find((p) => p.agentId === agent.id);
          const room = pos ? ROOMS.find((r) => r.id === pos.roomId) : null;
          const cs = agentStyle(agent.role, idx);
          const isSelected = selectedAgent === agent.id;

          return (
            <div
              key={agent.id}
              className={`bg-white dark:bg-gray-900 rounded-lg border p-2.5 cursor-pointer transition-all text-center ${
                isSelected
                  ? "border-blue-400 shadow-md ring-2 ring-blue-100 dark:ring-blue-900/50"
                  : hoveredAgent === agent.id
                  ? "border-blue-300 shadow-md ring-2 ring-blue-100 dark:ring-blue-900/50"
                  : "border-gray-100 dark:border-gray-800 hover:border-gray-200 dark:hover:border-gray-700 hover:shadow-sm"
              }`}
              onClick={() => setSelectedAgent(isSelected ? null : agent.id)}
              onMouseEnter={() => setHoveredAgent(agent.id)}
              onMouseLeave={() => setHoveredAgent(null)}
            >
              <div className="flex justify-center mb-1.5">
                <PixelCharacter
                  style={cs}
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

"use client";

import type { WSEvent } from "@/lib/ws-client";

interface ActivityFeedProps {
  events: WSEvent[];
  maxItems?: number;
}

function formatEvent(event: WSEvent): { icon: string; text: string; color: string } {
  switch (event.type) {
    case "message:new":
      return {
        icon: "chat",
        text: `${event.data.agentId}: ${(event.data.content || "").slice(0, 100)}`,
        color: "text-blue-500",
      };
    case "task:update":
      return {
        icon: "task",
        text: `Task ${event.data.status}: ${event.data.taskId?.slice(0, 8)}`,
        color: event.data.status === "done" ? "text-green-500" : "text-yellow-500",
      };
    case "approval:new":
      return {
        icon: "alert",
        text: `Approval needed: ${event.data.title}`,
        color: "text-purple-500",
      };
    case "break:start":
      return {
        icon: "coffee",
        text: `${event.data.agentId} is on break`,
        color: "text-orange-400",
      };
    case "break:end":
      return {
        icon: "play",
        text: `${event.data.agentId} is back`,
        color: "text-green-500",
      };
    default:
      return {
        icon: "info",
        text: JSON.stringify(event.data).slice(0, 100),
        color: "text-gray-400",
      };
  }
}

export function ActivityFeed({ events, maxItems = 20 }: ActivityFeedProps) {
  const recent = events.slice(-maxItems).reverse();

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100">
        <h3 className="font-semibold text-gray-900">Activity Feed</h3>
      </div>
      <div className="divide-y divide-gray-50 max-h-96 overflow-y-auto">
        {recent.length === 0 ? (
          <div className="px-6 py-8 text-center text-gray-400 text-sm">
            No activity yet. Submit an idea to get started.
          </div>
        ) : (
          recent.map((event, i) => {
            const { text, color } = formatEvent(event);
            const time = new Date(event.timestamp).toLocaleTimeString();
            return (
              <div key={i} className="px-6 py-3 flex items-start gap-3">
                <div className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${color.replace("text-", "bg-")}`} />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 truncate">{text}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{time}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

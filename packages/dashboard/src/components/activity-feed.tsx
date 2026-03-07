"use client";

import type { WSEvent } from "@/lib/ws-client";
import { SkeletonActivityItem } from "@/components/skeleton";
import { EmptyState } from "@/components/empty-state";

interface ActivityFeedProps {
  events: WSEvent[];
  maxItems?: number;
  loading?: boolean;
}

const EVENT_ICONS: Record<string, { path: string; color: string; bg: string }> = {
  "message:new": {
    path: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z",
    color: "text-blue-600",
    bg: "bg-blue-100",
  },
  "task:update": {
    path: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4",
    color: "text-amber-600",
    bg: "bg-amber-100",
  },
  "approval:new": {
    path: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z",
    color: "text-purple-600",
    bg: "bg-purple-100",
  },
  "approval:resolved": {
    path: "M5 13l4 4L19 7",
    color: "text-green-600",
    bg: "bg-green-100",
  },
  "break:start": {
    path: "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z",
    color: "text-orange-500",
    bg: "bg-orange-100",
  },
  "break:end": {
    path: "M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z",
    color: "text-green-500",
    bg: "bg-green-100",
  },
};

const DEFAULT_ICON = {
  path: "M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
  color: "text-gray-400",
  bg: "bg-gray-100",
};

function formatEvent(event: WSEvent): string {
  switch (event.type) {
    case "message:new":
      return `${event.data.agentId}: ${(event.data.content || "").slice(0, 80)}`;
    case "task:update":
      return `Task ${event.data.status}: ${event.data.title || event.data.taskId?.slice(0, 8)}`;
    case "approval:new":
      return `Approval needed: ${event.data.title}`;
    case "approval:resolved":
      return `Approval resolved: ${event.data.title || event.data.approvalId?.slice(0, 8)}`;
    case "break:start":
      return `${event.data.agentId} is on break`;
    case "break:end":
      return `${event.data.agentId} is back`;
    default:
      return JSON.stringify(event.data).slice(0, 80);
  }
}

function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export function ActivityFeed({ events, maxItems = 20, loading = false }: ActivityFeedProps) {
  const recent = events.slice(-maxItems).reverse();

  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl shadow-sm border border-gray-100 dark:border-gray-800 overflow-hidden transition-colors duration-300">
      <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
        <h3 className="font-semibold text-gray-900 dark:text-gray-100 text-sm">Activity Feed</h3>
        {recent.length > 0 && (
          <span className="text-xs text-gray-400">{recent.length} events</span>
        )}
      </div>
      <div className="divide-y divide-gray-50 dark:divide-gray-800 max-h-[28rem] overflow-y-auto">
        {loading ? (
          <>
            <SkeletonActivityItem />
            <SkeletonActivityItem />
            <SkeletonActivityItem />
            <SkeletonActivityItem />
          </>
        ) : recent.length === 0 ? (
          <EmptyState
            icon="inbox"
            title="No activity yet"
            description="Events will appear here as agents work on tasks."
          />
        ) : (
          recent.map((event, i) => {
            const text = formatEvent(event);
            const iconInfo = EVENT_ICONS[event.type] ?? DEFAULT_ICON;
            const ago = timeAgo(event.timestamp);

            return (
              <div
                key={`${event.timestamp}-${i}`}
                className="px-5 py-2.5 flex items-start gap-3 hover:bg-gray-50/50 dark:hover:bg-gray-800/50 transition-colors duration-150"
                style={{
                  animation: i < 3 ? `fadeSlideIn 0.3s ease-out ${i * 0.05}s both` : undefined,
                }}
              >
                <div className={`mt-0.5 w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center ${iconInfo.bg}`}>
                  <svg className={`w-3 h-3 ${iconInfo.color}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={iconInfo.path} />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 dark:text-gray-300 leading-snug line-clamp-2">{text}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{ago}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

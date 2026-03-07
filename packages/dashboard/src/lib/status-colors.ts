// Centralized status colors for consistent styling across the dashboard.

export type TaskStatus = "backlog" | "assigned" | "in_progress" | "review" | "done" | "blocked";
export type AgentStatus = "active" | "idle" | "paused" | "on_break" | "error";
export type ProjectStatus = "active" | "paused" | "completed" | "archived";

// Task status → visual style
export const TASK_STATUS = {
  backlog:     { bg: "bg-gray-100",    text: "text-gray-600",    border: "border-gray-300",  dot: "bg-gray-400",    label: "Backlog" },
  assigned:    { bg: "bg-amber-50",    text: "text-amber-700",   border: "border-amber-300", dot: "bg-amber-400",   label: "Assigned" },
  in_progress: { bg: "bg-blue-50",     text: "text-blue-700",    border: "border-blue-300",  dot: "bg-blue-500",    label: "In Progress" },
  review:      { bg: "bg-purple-50",   text: "text-purple-700",  border: "border-purple-300",dot: "bg-purple-500",  label: "Review" },
  done:        { bg: "bg-emerald-50",  text: "text-emerald-700", border: "border-emerald-300",dot: "bg-emerald-500",label: "Done" },
  blocked:     { bg: "bg-red-50",      text: "text-red-700",     border: "border-red-300",   dot: "bg-red-500",     label: "Blocked" },
} as const;

// Agent status → visual style
export const AGENT_STATUS = {
  active:   { dot: "bg-green-500",  label: "Working",  bg: "bg-green-50",  text: "text-green-700" },
  idle:     { dot: "bg-gray-400",   label: "Idle",     bg: "bg-gray-50",   text: "text-gray-500" },
  paused:   { dot: "bg-yellow-500", label: "Paused",   bg: "bg-yellow-50", text: "text-yellow-700" },
  on_break: { dot: "bg-orange-400", label: "On Break", bg: "bg-orange-50", text: "text-orange-700" },
  error:    { dot: "bg-red-500",    label: "Error",    bg: "bg-red-50",    text: "text-red-700" },
} as const;

// Project status → visual style
export const PROJECT_STATUS = {
  active:    { bg: "bg-green-50",  text: "text-green-700",  dot: "bg-green-500",  label: "Active" },
  paused:    { bg: "bg-yellow-50", text: "text-yellow-700", dot: "bg-yellow-500", label: "Paused" },
  completed: { bg: "bg-blue-50",   text: "text-blue-700",   dot: "bg-blue-500",   label: "Completed" },
  archived:  { bg: "bg-gray-100",  text: "text-gray-500",   dot: "bg-gray-400",   label: "Archived" },
} as const;

/** Get task status style with fallback */
export function taskStyle(status: string) {
  return TASK_STATUS[status as TaskStatus] ?? TASK_STATUS.backlog;
}

/** Get agent status style with fallback */
export function agentStyle(status: string) {
  return AGENT_STATUS[status as AgentStatus] ?? AGENT_STATUS.idle;
}

/** Get project status style with fallback */
export function projectStyle(status: string) {
  return PROJECT_STATUS[status as ProjectStatus] ?? PROJECT_STATUS.active;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";
const API_KEY = process.env.NEXT_PUBLIC_API_KEY || "";

/** Build headers with optional auth */
function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  if (API_KEY) headers["Authorization"] = `Bearer ${API_KEY}`;
  return headers;
}

/** Fetch wrapper that includes auth headers */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = authHeaders(
    init?.headers ? Object.fromEntries(
      Object.entries(init.headers as Record<string, string>)
    ) : undefined
  );
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

// --- Types ---

export type TaskStatus = "backlog" | "queued" | "assigned" | "in_progress" | "verifying" | "review" | "done" | "blocked" | "cancelled";
export type ProjectStatus = "created" | "active" | "paused" | "completed" | "cancelled" | "archived";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  projectId: string | null;
  assignedTo: string | null;
  createdBy: string;
  parentTaskId: string | null;
  dependsOn: string | null;
  priority: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectRepository {
  id: string;
  projectId: string;
  repoUrl: string;
  repoName: string;
  localPath: string;
  defaultBranch: string;
  currentBranch: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  slackChannel: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  repositories?: ProjectRepository[];
  tasks?: Task[];
  taskCount?: number;
  taskCounts?: {
    backlog: number;
    assigned: number;
    in_progress: number;
    review: number;
    done: number;
    blocked: number;
  };
}

export interface Agent {
  id: string;
  blueprintId: string;
  name: string;
  role: string;
  status: string;
  avatar?: string | null;
  gender?: string | null;
  currentTaskId?: string | null;
  channels?: string[];
  reportsTo?: string | null;
  lastActiveAt?: string;
}

export interface Approval {
  id: string;
  title: string;
  description: string;
  requestedBy: string;
  requested_by?: string;
  status: "pending" | "approved" | "rejected" | "modified";
  projectId: string | null;
  createdAt?: string;
  created_at?: string;
}

// --- API functions ---

export async function fetchAgents(): Promise<Agent[]> {
  const res = await apiFetch(`/api/agents`);
  return res.json();
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await apiFetch(`/api/projects`);
  return res.json();
}

export async function fetchProject(id: string): Promise<Project> {
  const res = await apiFetch(`/api/projects/${id}`);
  return res.json();
}

export async function fetchProjectRepositories(projectId: string): Promise<ProjectRepository[]> {
  const res = await apiFetch(`/api/projects/${projectId}/repositories`);
  return res.json();
}

export async function fetchTasks(projectId?: string): Promise<Task[]> {
  const path = projectId
    ? `/api/tasks?projectId=${projectId}`
    : `/api/tasks`;
  const res = await apiFetch(path);
  const data = await res.json();
  // Support both old (array) and new (paginated envelope) response shapes
  return Array.isArray(data) ? data : (data.tasks ?? []);
}

// --- Timeline types & API ---

export interface TimelineTask {
  id: string;
  title: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

export interface AgentTimeline {
  agentId: string;
  agentName: string;
  role: string;
  avatar: string | null;
  tasks: TimelineTask[];
}

export async function fetchTimeline(hours = 72): Promise<AgentTimeline[]> {
  const res = await apiFetch(`/api/timeline?hours=${hours}`);
  return res.json();
}

export async function fetchApprovals(): Promise<Approval[]> {
  const res = await apiFetch(`/api/approvals`);
  return res.json();
}

export async function submitIdea(title: string, description: string) {
  const res = await apiFetch(`/api/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description }),
  });
  return res.json();
}

export async function fetchUsage() {
  const res = await apiFetch(`/api/usage`);
  return res.json();
}

export async function resolveApproval(
  id: string,
  status: "approved" | "rejected",
  feedback?: string
) {
  const res = await apiFetch(`/api/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, feedback }),
  });
  return res.json();
}

export async function fetchSettings(): Promise<Record<string, string>> {
  const res = await apiFetch(`/api/settings`);
  return res.json();
}

export async function fetchMemories(scope?: string) {
  const path = scope
    ? `/api/memories?scope=${scope}`
    : `/api/memories`;
  const res = await apiFetch(path);
  return res.json();
}

// --- Agent management ---

export async function pauseAgent(agentId: string) {
  const res = await apiFetch(`/api/agents/${agentId}/pause`, { method: "POST" });
  return res.json();
}

export async function resumeAgent(agentId: string) {
  const res = await apiFetch(`/api/agents/${agentId}/resume`, { method: "POST" });
  return res.json();
}

export async function retireAgent(agentId: string) {
  const res = await apiFetch(`/api/agency/retire`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  return res.json();
}

// --- Task management ---

export async function cancelTask(taskId: string) {
  const res = await apiFetch(`/api/tasks/${taskId}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cancelledBy: "investor" }),
  });
  return res.json();
}

// --- Emergency controls ---

export async function emergencyPause() {
  const res = await apiFetch(`/api/emergency/pause`, { method: "POST" });
  return res.json();
}

export async function emergencyResume() {
  const res = await apiFetch(`/api/emergency/resume`, { method: "POST" });
  return res.json();
}

export async function fetchEmergencyStatus(): Promise<{ paused: boolean }> {
  const res = await apiFetch(`/api/emergency/status`);
  return res.json();
}

// --- Performance ---

export async function fetchPerformance() {
  const res = await apiFetch(`/api/performance`);
  return res.json();
}

// --- Direct task/chat ---

export async function directTask(agentId: string, message: string, asTask = false, projectId?: string) {
  const res = await apiFetch(`/api/agency/direct`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId, message, asTask, projectId }),
  });
  return res.json();
}

// --- Audit log ---

export interface AuditEntry {
  id: string;
  channel: string;
  agentId: string | null;
  message: string;
  createdAt: string;
}

export async function fetchAuditLog(channel = "ceo-investor", limit = 50): Promise<AuditEntry[]> {
  const res = await apiFetch(`/api/audit?channel=${encodeURIComponent(channel)}&limit=${limit}`);
  return res.json();
}

// --- Task notes ---

export interface TaskNote {
  id: string;
  taskId: string;
  agentId: string;
  content: string;
  createdAt: string;
}

export async function fetchTaskNotes(taskId: string): Promise<TaskNote[]> {
  const res = await apiFetch(`/api/tasks/${taskId}/notes`);
  return res.json();
}

export async function fetchActivityFeed(limit = 30) {
  const res = await apiFetch(`/api/activity-feed?limit=${limit}`);
  return res.json();
}

// --- Task details ---

export async function fetchTask(taskId: string): Promise<Task> {
  const res = await apiFetch(`/api/tasks?limit=200`);
  const data = await res.json();
  const tasks: Task[] = Array.isArray(data) ? data : (data.tasks ?? []);
  const task = tasks.find(t => t.id === taskId);
  if (!task) throw new Error("Task not found");
  return task;
}

export async function reassignTask(taskId: string, agentId: string) {
  const res = await apiFetch(`/api/tasks/${taskId}/reassign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agentId }),
  });
  return res.json();
}

export async function setTaskDeadline(taskId: string, deadline: string) {
  const res = await apiFetch(`/api/tasks/${taskId}/deadline`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deadline }),
  });
  return res.json();
}

// --- Workload ---

export async function fetchWorkload() {
  const res = await apiFetch(`/api/workload`);
  return res.json();
}

// --- Agent Scoring ---

export interface AgentScore {
  agentId: string;
  name: string;
  efficiency: number;
  completionRate: number;
  avgCostPerTask: number;
  avgDurationMs: number;
  tasksCompleted: number;
  reworkRate: number;
  skillMatch: number;
  routingScore: number;
}

export async function fetchScores(): Promise<AgentScore[]> {
  const res = await apiFetch(`/api/scores`);
  return res.json();
}

// --- Task Estimation ---

export interface TaskEstimate {
  estimatedMs: number;
  lowerBoundMs: number;
  upperBoundMs: number;
  confidence: "none" | "low" | "medium" | "high";
  sampleCount: number;
  basis: string;
  estimatedCostUsd: number | null;
}

export interface ProjectEstimate {
  projectId: string;
  totalRemainingMs: number;
  estimatedCompletionAt: string | null;
  tasks: Array<{
    taskId: string;
    title: string;
    assignedTo: string | null;
    estimate: TaskEstimate;
  }>;
  confidence: string;
  parallelism: number;
}

export async function fetchTaskEstimate(agentId: string, title: string): Promise<TaskEstimate> {
  const res = await apiFetch(`/api/estimates/${agentId}?title=${encodeURIComponent(title)}`);
  return res.json();
}

export async function fetchProjectEstimate(projectId: string): Promise<ProjectEstimate> {
  const res = await apiFetch(`/api/projects/${projectId}/estimate`);
  return res.json();
}

// --- System Health ---

export interface AgentHealth {
  agentId: string;
  successRate: number;
  avgDurationMs: number;
  avgCostPerTask: number;
  totalTasks: number;
  errorCount: number;
  last7dCost: number;
  last7dTasks: number;
  cacheHitRate: number;
}

export async function fetchHealth(): Promise<AgentHealth[]> {
  const res = await apiFetch(`/api/health`);
  return res.json();
}

export async function fetchOverdueTasks() {
  const res = await apiFetch(`/api/tasks/overdue`);
  return res.json();
}

export async function fetchDeadlocks() {
  const res = await apiFetch(`/api/deadlocks`);
  return res.json();
}

export async function routeTask(title: string, description: string, exclude: string[] = []): Promise<AgentScore[]> {
  const res = await apiFetch(`/api/route-task`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description, exclude }),
  });
  return res.json();
}

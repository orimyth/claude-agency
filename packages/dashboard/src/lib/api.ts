const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

// --- Types ---

export type TaskStatus = "backlog" | "assigned" | "in_progress" | "review" | "done" | "blocked";
export type ProjectStatus = "active" | "paused" | "completed" | "archived";

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
  const res = await fetch(`${API_BASE}/api/agents`);
  return res.json();
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await fetch(`${API_BASE}/api/projects`);
  return res.json();
}

export async function fetchProject(id: string): Promise<Project> {
  const res = await fetch(`${API_BASE}/api/projects/${id}`);
  return res.json();
}

export async function fetchProjectRepositories(projectId: string): Promise<ProjectRepository[]> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/repositories`);
  return res.json();
}

export async function fetchTasks(projectId?: string): Promise<Task[]> {
  const url = projectId
    ? `${API_BASE}/api/tasks?projectId=${projectId}`
    : `${API_BASE}/api/tasks`;
  const res = await fetch(url);
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
  const res = await fetch(`${API_BASE}/api/timeline?hours=${hours}`);
  return res.json();
}

export async function fetchApprovals(): Promise<Approval[]> {
  const res = await fetch(`${API_BASE}/api/approvals`);
  return res.json();
}

export async function submitIdea(title: string, description: string) {
  const res = await fetch(`${API_BASE}/api/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, description }),
  });
  return res.json();
}

export async function fetchUsage() {
  const res = await fetch(`${API_BASE}/api/usage`);
  return res.json();
}

export async function resolveApproval(
  id: string,
  status: "approved" | "rejected",
  feedback?: string
) {
  const res = await fetch(`${API_BASE}/api/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status, feedback }),
  });
  return res.json();
}

export async function fetchSettings(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/settings`);
  return res.json();
}

export async function fetchMemories(scope?: string) {
  const url = scope
    ? `${API_BASE}/api/memories?scope=${scope}`
    : `${API_BASE}/api/memories`;
  const res = await fetch(url);
  return res.json();
}

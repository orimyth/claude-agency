const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

export async function fetchAgents() {
  const res = await fetch(`${API_BASE}/api/agents`);
  return res.json();
}

export async function fetchProjects() {
  const res = await fetch(`${API_BASE}/api/projects`);
  return res.json();
}

export async function fetchTasks(projectId?: string) {
  const url = projectId
    ? `${API_BASE}/api/tasks?projectId=${projectId}`
    : `${API_BASE}/api/tasks`;
  const res = await fetch(url);
  return res.json();
}

export async function fetchApprovals() {
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

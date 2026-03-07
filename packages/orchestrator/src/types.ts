export type AgentStatus = 'active' | 'idle' | 'paused' | 'on_break' | 'error';
export type TaskStatus = 'backlog' | 'assigned' | 'in_progress' | 'review' | 'done' | 'blocked';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'modified';

export interface AgentBlueprint {
  id: string;
  role: string;
  name: string;
  gender: 'male' | 'female';
  avatar: string;
  systemPrompt: string;
  skills: string[];
  filePatterns: string[];
  slackChannels: string[];
  kpis: KPIDefinition[];
  reportsTo: string | null;
  canCollabWith: string[];
  blacklistOverrides: PermissionRule[];
}

export interface AgentState {
  id: string;
  blueprintId: string;
  status: AgentStatus;
  currentTaskId: string | null;
  lastActiveAt: Date;
  breakUntil: Date | null;
  sessionId: string | null;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  projectId: string | null;
  assignedTo: string | null;
  createdBy: string;
  parentTaskId: string | null;
  dependsOn: string | null;  // task ID this task waits for
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  slackChannel: string | null;
  createdAt: Date;
  updatedAt: Date;
  status: 'active' | 'paused' | 'completed' | 'archived';
}

export interface ProjectRepository {
  id: string;
  projectId: string;
  repoUrl: string;
  repoName: string;
  localPath: string;
  defaultBranch: string;
  currentBranch: string | null;
  lastSyncedAt: Date | null;
  createdAt: Date;
}

export interface Message {
  id: string;
  fromAgentId: string;
  toAgentId: string | null;
  channel: string;
  content: string;
  timestamp: Date;
}

export interface Approval {
  id: string;
  title: string;
  description: string;
  requestedBy: string;
  status: ApprovalStatus;
  projectId: string | null;
  response: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
}

export interface KPIDefinition {
  name: string;
  metric: string;
  target: number;
}

export interface PermissionRule {
  type: 'block' | 'allow';
  pattern: string;
  scope: 'command' | 'path' | 'tool';
}

export interface BlacklistConfig {
  global: {
    blockedCommands: string[];
    blockedPatterns: string[];
    blockedPaths: string[];
  };
  roles: Record<string, {
    blockedCommands: string[];
    blockedPaths: string[];
    allowedPaths: string[];
  }>;
  overrides: {
    taskId: string;
    agentId: string;
    allowedAction: string;
    grantedBy: string;
    expiresAt: Date;
  }[];
}

export interface AgencyConfig {
  workspace: string;
  maxConcurrency: number;
  mysql: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  slack: {
    botToken: string;
    signingSecret: string;
    appToken: string;
  };
  dashboardPort: number;
  wsPort: number;
  /** Max cost in USD per single task execution. Agent is aborted if exceeded. Default: 2.00 */
  maxCostPerTask: number;
  /** Emergency pause — when true, no new tasks are started. Default: false */
  emergencyPause: boolean;
}

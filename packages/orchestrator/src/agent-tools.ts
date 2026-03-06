import { execSync } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { resolve, basename } from 'path';
import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { Task, Project, ProjectRepository } from './types.js';

/**
 * Tools that agents can call during task execution.
 * These are intercepted by the agent-manager and executed server-side.
 *
 * Instead of parsing JSON from agent output, agents call these tools directly.
 */

export interface AgentToolResult {
  success: boolean;
  data?: any;
  error?: string;
}

export class AgentToolHandler {
  private store: StateStore;
  private agentManager: AgentManager;
  private workspaceRoot: string;

  constructor(store: StateStore, agentManager: AgentManager, workspaceRoot: string) {
    this.store = store;
    this.agentManager = agentManager;
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Handle a tool call from an agent.
   */
  async handleToolCall(agentId: string, toolName: string, input: Record<string, any>): Promise<AgentToolResult> {
    try {
      switch (toolName) {
        case 'agency_create_project':
          return await this.createProject(agentId, input);
        case 'agency_list_projects':
          return await this.listProjects();
        case 'agency_get_project':
          return await this.getProject(input);
        case 'agency_add_repository':
          return await this.addRepository(agentId, input);
        case 'agency_list_repositories':
          return await this.listRepositories(input);
        case 'agency_clone_repository':
          return await this.cloneRepository(input);
        case 'agency_create_task':
          return await this.createTask(agentId, input);
        case 'agency_list_tasks':
          return await this.listTasks(input);
        case 'agency_assign_task':
          return await this.assignTask(input);
        case 'agency_update_task_status':
          return await this.updateTaskStatus(input);
        case 'agency_git_push':
          return await this.gitPush(input);
        case 'agency_list_agents':
          return await this.listAgents();
        default:
          return { success: false, error: `Unknown agency tool: ${toolName}` };
      }
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  private async createProject(agentId: string, input: Record<string, any>): Promise<AgentToolResult> {
    const { name, description } = input;
    if (!name) return { success: false, error: 'name is required' };

    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const slackChannel = `agency-project-${id}`;

    await this.store.createProject({
      id,
      name,
      description: description ?? '',
      slackChannel,
      status: 'active',
    });

    return {
      success: true,
      data: { projectId: id, name, slackChannel },
    };
  }

  private async listProjects(): Promise<AgentToolResult> {
    const projects = await this.store.getAllProjects();
    return {
      success: true,
      data: projects.map(p => ({
        id: p.id, name: p.name, description: p.description,
        status: p.status, slackChannel: p.slackChannel,
      })),
    };
  }

  private async getProject(input: Record<string, any>): Promise<AgentToolResult> {
    const { projectId } = input;
    if (!projectId) return { success: false, error: 'projectId is required' };

    const project = await this.store.getProject(projectId);
    if (!project) return { success: false, error: `Project '${projectId}' not found` };

    const repos = await this.store.getProjectRepositories(projectId);
    const tasks = await this.store.getTasksByProject(projectId);

    return {
      success: true,
      data: {
        ...project,
        repositories: repos.map(r => ({
          id: r.id, repoUrl: r.repoUrl, repoName: r.repoName,
          localPath: r.localPath, defaultBranch: r.defaultBranch,
          currentBranch: r.currentBranch, lastSyncedAt: r.lastSyncedAt,
        })),
        tasks: tasks.map(t => ({
          id: t.id, title: t.title, status: t.status,
          assignedTo: t.assignedTo, priority: t.priority,
        })),
      },
    };
  }

  private async addRepository(_agentId: string, input: Record<string, any>): Promise<AgentToolResult> {
    const { projectId, repoUrl, defaultBranch } = input;
    if (!projectId || !repoUrl) return { success: false, error: 'projectId and repoUrl are required' };

    const project = await this.store.getProject(projectId);
    if (!project) return { success: false, error: `Project '${projectId}' not found` };

    // Derive repo name from URL
    const repoName = basename(repoUrl, '.git').replace(/\.git$/, '');
    const localPath = resolve(this.workspaceRoot, projectId, repoName);
    const id = crypto.randomUUID();

    await this.store.addRepository({
      id,
      projectId,
      repoUrl,
      repoName,
      localPath,
      defaultBranch: defaultBranch ?? 'main',
      currentBranch: null,
      lastSyncedAt: null,
    });

    return {
      success: true,
      data: { repositoryId: id, repoName, localPath, message: `Repository added. Use agency_clone_repository to clone it.` },
    };
  }

  private async listRepositories(input: Record<string, any>): Promise<AgentToolResult> {
    const { projectId } = input;
    if (!projectId) return { success: false, error: 'projectId is required' };

    const repos = await this.store.getProjectRepositories(projectId);
    return {
      success: true,
      data: repos.map(r => ({
        id: r.id, repoUrl: r.repoUrl, repoName: r.repoName,
        localPath: r.localPath, defaultBranch: r.defaultBranch,
        currentBranch: r.currentBranch, lastSyncedAt: r.lastSyncedAt,
      })),
    };
  }

  private async cloneRepository(input: Record<string, any>): Promise<AgentToolResult> {
    const { repositoryId } = input;
    if (!repositoryId) return { success: false, error: 'repositoryId is required' };

    const repo = await this.store.getRepository(repositoryId);
    if (!repo) return { success: false, error: `Repository '${repositoryId}' not found` };

    // Ensure parent directory exists
    const parentDir = resolve(repo.localPath, '..');
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    if (existsSync(repo.localPath)) {
      // Already cloned — pull instead
      try {
        execSync(`git -C "${repo.localPath}" pull --ff-only`, { timeout: 60000 });
        await this.store.updateRepositorySync(repo.id, repo.defaultBranch);
        return { success: true, data: { localPath: repo.localPath, action: 'pulled' } };
      } catch (err: any) {
        return { success: false, error: `Git pull failed: ${err.message}` };
      }
    }

    try {
      execSync(`git clone "${repo.repoUrl}" "${repo.localPath}"`, { timeout: 120000 });
      await this.store.updateRepositorySync(repo.id, repo.defaultBranch);
      return { success: true, data: { localPath: repo.localPath, action: 'cloned' } };
    } catch (err: any) {
      return { success: false, error: `Git clone failed: ${err.message}` };
    }
  }

  private async createTask(agentId: string, input: Record<string, any>): Promise<AgentToolResult> {
    const { projectId, title, description, assignTo, priority } = input;
    if (!title) return { success: false, error: 'title is required' };

    const id = crypto.randomUUID();
    const task: Task = {
      id,
      title,
      description: description ?? '',
      status: assignTo ? 'assigned' : 'backlog',
      projectId: projectId ?? null,
      assignedTo: assignTo ?? null,
      createdBy: agentId,
      parentTaskId: input.parentTaskId ?? null,
      priority: priority ?? 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);

    // If assigned, kick off the agent
    if (assignTo && this.agentManager.getBlueprint(assignTo)) {
      // Don't await — let it run in the background
      this.agentManager.assignTask(assignTo, task).catch(err => {
        console.error(`[AgentTools] Failed to assign task to ${assignTo}: ${err.message}`);
      });
    }

    return {
      success: true,
      data: { taskId: id, title, status: task.status, assignedTo: assignTo ?? null },
    };
  }

  private async listTasks(input: Record<string, any>): Promise<AgentToolResult> {
    const { projectId, status, assignedTo } = input;
    let tasks: Task[];

    if (projectId) {
      tasks = await this.store.getTasksByProject(projectId);
    } else if (assignedTo) {
      tasks = await this.store.getTasksByAgent(assignedTo);
    } else {
      tasks = await this.store.getAllTasks(50);
    }

    if (status) {
      tasks = tasks.filter(t => t.status === status);
    }

    return {
      success: true,
      data: tasks.map(t => ({
        id: t.id, title: t.title, description: t.description?.slice(0, 200),
        status: t.status, assignedTo: t.assignedTo, projectId: t.projectId,
        priority: t.priority, createdBy: t.createdBy,
      })),
    };
  }

  private async assignTask(input: Record<string, any>): Promise<AgentToolResult> {
    const { taskId, assignTo } = input;
    if (!taskId || !assignTo) return { success: false, error: 'taskId and assignTo are required' };

    const task = await this.store.getTask(taskId);
    if (!task) return { success: false, error: `Task '${taskId}' not found` };

    if (!this.agentManager.getBlueprint(assignTo)) {
      return { success: false, error: `Agent '${assignTo}' not found` };
    }

    await this.store.updateTaskStatus(taskId, 'assigned', assignTo);
    const updated = await this.store.getTask(taskId);
    if (updated) {
      this.agentManager.assignTask(assignTo, updated).catch(err => {
        console.error(`[AgentTools] Failed to assign task: ${err.message}`);
      });
    }

    return { success: true, data: { taskId, assignedTo: assignTo, status: 'assigned' } };
  }

  private async updateTaskStatus(input: Record<string, any>): Promise<AgentToolResult> {
    const { taskId, status } = input;
    if (!taskId || !status) return { success: false, error: 'taskId and status are required' };

    await this.store.updateTaskStatus(taskId, status);
    return { success: true, data: { taskId, status } };
  }

  private async gitPush(input: Record<string, any>): Promise<AgentToolResult> {
    const { repositoryId, branch, commitMessage } = input;
    if (!repositoryId) return { success: false, error: 'repositoryId is required' };

    const repo = await this.store.getRepository(repositoryId);
    if (!repo) return { success: false, error: `Repository '${repositoryId}' not found` };

    if (!existsSync(repo.localPath)) {
      return { success: false, error: `Repository not cloned at ${repo.localPath}` };
    }

    try {
      const cwd = repo.localPath;
      // Stage all changes
      execSync(`git -C "${cwd}" add -A`, { timeout: 30000 });

      // Check if there are changes to commit
      const status = execSync(`git -C "${cwd}" status --porcelain`, { timeout: 10000 }).toString().trim();
      if (!status) {
        return { success: true, data: { message: 'No changes to push' } };
      }

      // Commit
      const msg = commitMessage ?? 'Agent update';
      execSync(`git -C "${cwd}" commit -m "${msg.replace(/"/g, '\\"')}"`, { timeout: 30000 });

      // Push
      const targetBranch = branch ?? repo.currentBranch ?? repo.defaultBranch;
      execSync(`git -C "${cwd}" push origin ${targetBranch}`, { timeout: 60000 });

      await this.store.updateRepositorySync(repo.id, targetBranch);

      return { success: true, data: { branch: targetBranch, message: 'Pushed successfully' } };
    } catch (err: any) {
      return { success: false, error: `Git push failed: ${err.message}` };
    }
  }

  private async listAgents(): Promise<AgentToolResult> {
    const blueprints = this.agentManager.getAllBlueprints();
    const agents = await this.store.getAllAgents();

    return {
      success: true,
      data: blueprints.map(bp => {
        const state = agents.find(a => a.id === bp.id);
        return {
          id: bp.id, name: bp.name, role: bp.role,
          status: state?.status ?? 'idle',
          currentTaskId: state?.currentTaskId ?? null,
        };
      }),
    };
  }
}

/**
 * Tool definitions for the Claude Code SDK.
 * These get passed as allowedTools to agent sessions.
 */
export const AGENCY_TOOL_DEFINITIONS = [
  {
    name: 'agency_create_project',
    description: 'Create a new project in the agency. Use this when the investor or CEO wants to start a new initiative.',
    input_schema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Project name (e.g. "Recipe Sharing App")' },
        description: { type: 'string', description: 'Brief project description' },
      },
      required: ['name'],
    },
  },
  {
    name: 'agency_list_projects',
    description: 'List all projects in the agency with their status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
  {
    name: 'agency_get_project',
    description: 'Get detailed info about a project including its repositories and tasks.',
    input_schema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'The project ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'agency_add_repository',
    description: 'Add a GitHub repository to a project. The investor will provide the repo URL.',
    input_schema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'The project ID to add the repo to' },
        repoUrl: { type: 'string', description: 'GitHub repository URL (e.g. https://github.com/user/repo.git)' },
        defaultBranch: { type: 'string', description: 'Default branch name (defaults to "main")' },
      },
      required: ['projectId', 'repoUrl'],
    },
  },
  {
    name: 'agency_list_repositories',
    description: 'List all repositories for a project.',
    input_schema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'The project ID' },
      },
      required: ['projectId'],
    },
  },
  {
    name: 'agency_clone_repository',
    description: 'Clone or pull a repository to the local workspace so agents can work on it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repositoryId: { type: 'string', description: 'The repository ID (from agency_list_repositories)' },
      },
      required: ['repositoryId'],
    },
  },
  {
    name: 'agency_create_task',
    description: 'Create a task and optionally assign it to an agent. The agent will start working on it immediately.',
    input_schema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Project this task belongs to (optional)' },
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed task description with requirements' },
        assignTo: { type: 'string', description: 'Agent ID to assign to (e.g. "developer", "designer", "architect")' },
        parentTaskId: { type: 'string', description: 'Parent task ID if this is a subtask' },
        priority: { type: 'number', description: 'Priority 1-10 (10 = highest)' },
      },
      required: ['title'],
    },
  },
  {
    name: 'agency_list_tasks',
    description: 'List tasks, optionally filtered by project, status, or assigned agent.',
    input_schema: {
      type: 'object' as const,
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID' },
        status: { type: 'string', description: 'Filter by status (backlog, assigned, in_progress, review, done, blocked)' },
        assignedTo: { type: 'string', description: 'Filter by assigned agent ID' },
      },
    },
  },
  {
    name: 'agency_assign_task',
    description: 'Assign an existing task to an agent. The agent will start working on it.',
    input_schema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'The task ID to assign' },
        assignTo: { type: 'string', description: 'Agent ID to assign to' },
      },
      required: ['taskId', 'assignTo'],
    },
  },
  {
    name: 'agency_update_task_status',
    description: 'Update the status of a task.',
    input_schema: {
      type: 'object' as const,
      properties: {
        taskId: { type: 'string', description: 'The task ID' },
        status: { type: 'string', description: 'New status: backlog, assigned, in_progress, review, done, blocked' },
      },
      required: ['taskId', 'status'],
    },
  },
  {
    name: 'agency_git_push',
    description: 'Stage, commit, and push all changes in a repository.',
    input_schema: {
      type: 'object' as const,
      properties: {
        repositoryId: { type: 'string', description: 'The repository ID' },
        branch: { type: 'string', description: 'Branch to push to (defaults to current branch)' },
        commitMessage: { type: 'string', description: 'Commit message' },
      },
      required: ['repositoryId'],
    },
  },
  {
    name: 'agency_list_agents',
    description: 'List all agents in the agency with their current status.',
    input_schema: {
      type: 'object' as const,
      properties: {},
    },
  },
];

/**
 * Names of all agency tools — used to filter tool calls in the SDK stream.
 */
export const AGENCY_TOOL_NAMES = AGENCY_TOOL_DEFINITIONS.map(t => t.name);

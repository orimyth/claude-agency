import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { TaskRouter } from './task-router.js';
import type { TaskBoard } from './task-board.js';
import type { MemoryManager } from './memory-manager.js';
import type { AgentToolHandler } from './agent-tools.js';

/**
 * Simple HTTP API for the dashboard.
 * Runs on the same port as the WebSocket server + 1 (e.g., 3002).
 */
export class APIServer {
  private store: StateStore;
  private agentManager: AgentManager;
  private taskRouter: TaskRouter;
  private taskBoard: TaskBoard;
  private memoryManager: MemoryManager | null = null;
  private toolHandler: AgentToolHandler | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private onSettingsChanged: (() => Promise<void>) | null = null;

  constructor(store: StateStore, agentManager: AgentManager, taskRouter: TaskRouter, taskBoard: TaskBoard) {
    this.store = store;
    this.agentManager = agentManager;
    this.taskRouter = taskRouter;
    this.taskBoard = taskBoard;
  }

  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  setToolHandler(handler: AgentToolHandler): void {
    this.toolHandler = handler;
  }

  setOnSettingsChanged(cb: () => Promise<void>): void {
    this.onSettingsChanged = cb;
  }

  start(port: number): void {
    this.server = createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await this.route(req, res);
      } catch (err: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });

    this.server.listen(port, () => {
      console.log(`API server running on port ${port}`);
    });
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/api/agents') {
      const agents = await this.store.getAllAgents();
      const blueprints = this.agentManager.getAllBlueprints();
      const result = agents.map(a => {
        const bp = blueprints.find(b => b.id === a.blueprintId);
        return {
          ...a,
          name: bp?.name ?? a.id,
          role: bp?.role ?? 'Unknown',
          avatar: bp?.avatar ?? null,
          gender: bp?.gender ?? null,
          channels: bp?.slackChannels ?? [],
          reportsTo: bp?.reportsTo ?? null,
        };
      });
      this.json(res, result);
      return;
    }

    // Blueprint management
    if (req.method === 'GET' && path === '/api/blueprints') {
      const blueprints = await this.store.getAllBlueprints();
      this.json(res, blueprints);
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/blueprints\/[^/]+$/)) {
      const id = path.split('/').pop()!;
      const bp = await this.store.getBlueprint(id);
      if (!bp) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Blueprint not found' }));
        return;
      }
      this.json(res, bp);
      return;
    }

    if (req.method === 'PUT' && path.match(/^\/api\/blueprints\/[^/]+$/)) {
      const id = path.split('/').pop()!;
      const body = JSON.parse(await this.readBody(req));
      const existing = await this.store.getBlueprint(id);
      if (!existing) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Blueprint not found' }));
        return;
      }
      const updated = { ...existing, ...body, id };
      await this.store.updateBlueprint(id, updated);
      this.agentManager.registerBlueprint(updated); // hot-reload
      this.json(res, updated);
      return;
    }

    if (req.method === 'GET' && path === '/api/projects') {
      const projects = await this.store.getAllProjects();
      const enriched = await Promise.all(projects.map(async p => {
        const tasks = await this.store.getTasksByProject(p.id);
        const repos = await this.store.getProjectRepositories(p.id);
        return {
          ...p,
          repositories: repos,
          taskCount: tasks.length,
          taskCounts: {
            backlog: tasks.filter(t => t.status === 'backlog').length,
            assigned: tasks.filter(t => t.status === 'assigned').length,
            in_progress: tasks.filter(t => t.status === 'in_progress').length,
            review: tasks.filter(t => t.status === 'review').length,
            done: tasks.filter(t => t.status === 'done').length,
            blocked: tasks.filter(t => t.status === 'blocked').length,
          },
        };
      }));
      this.json(res, enriched);
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/projects\/[^/]+$/)) {
      const projectId = path.split('/').pop()!;
      const project = await this.store.getProject(projectId);
      if (!project) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Project not found' }));
        return;
      }
      const repos = await this.store.getProjectRepositories(projectId);
      const tasks = await this.store.getTasksByProject(projectId);
      this.json(res, { ...project, repositories: repos, tasks });
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/projects\/[^/]+\/repositories$/)) {
      const projectId = path.split('/')[3];
      const repos = await this.store.getProjectRepositories(projectId);
      this.json(res, repos);
      return;
    }

    if (req.method === 'GET' && path === '/api/tasks') {
      const projectId = url.searchParams.get('projectId');
      if (projectId) {
        const tasks = await this.store.getTasksByProject(projectId);
        this.json(res, tasks);
      } else {
        const tasks = await this.store.getAllTasks();
        this.json(res, tasks);
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/approvals') {
      const approvals = await this.store.getPendingApprovals();
      this.json(res, approvals);
      return;
    }

    if (req.method === 'POST' && path === '/api/submit') {
      const body = await this.readBody(req);
      const { title, description } = JSON.parse(body);
      const result = await this.taskRouter.submitIdea(title, description);
      this.json(res, result);
      return;
    }

    if (req.method === 'GET' && path === '/api/settings') {
      const settings = await this.store.getAllSettings();
      this.json(res, settings);
      return;
    }

    if (req.method === 'GET' && path === '/api/usage') {
      const summary = await this.store.getUsageSummary();
      const recent = await this.store.getRecentUsage(30);
      this.json(res, { ...summary, recent });
      return;
    }

    if (req.method === 'POST' && path === '/api/settings') {
      const body = await this.readBody(req);
      const entries = JSON.parse(body) as Record<string, string>;
      for (const [key, value] of Object.entries(entries)) {
        await this.store.setSetting(key, value);
      }
      if (this.onSettingsChanged) await this.onSettingsChanged();
      this.json(res, { ok: true });
      return;
    }

    if (req.method === 'GET' && path === '/api/memories') {
      const scope = url.searchParams.get('scope') ?? undefined;
      if (this.memoryManager) {
        const memories = await this.memoryManager.getAll(scope);
        this.json(res, memories);
      } else {
        this.json(res, []);
      }
      return;
    }

    // --- Agency action endpoints (called by agents via curl) ---

    if (req.method === 'POST' && path === '/api/agency/projects' && this.toolHandler) {
      const body = JSON.parse(await this.readBody(req));
      const result = await this.toolHandler.handleToolCall(body.agentId ?? 'system', 'agency_create_project', body);
      this.json(res, result);
      return;
    }

    if (req.method === 'POST' && path === '/api/agency/repositories' && this.toolHandler) {
      const body = JSON.parse(await this.readBody(req));
      const result = await this.toolHandler.handleToolCall(body.agentId ?? 'system', 'agency_add_repository', body);
      this.json(res, result);
      return;
    }

    if (req.method === 'POST' && path.match(/^\/api\/agency\/repositories\/[^/]+\/clone$/) && this.toolHandler) {
      const repositoryId = path.split('/')[4];
      const result = await this.toolHandler.handleToolCall('system', 'agency_clone_repository', { repositoryId });
      this.json(res, result);
      return;
    }

    if (req.method === 'POST' && path.match(/^\/api\/agency\/repositories\/[^/]+\/push$/) && this.toolHandler) {
      const repositoryId = path.split('/')[4];
      const body = JSON.parse(await this.readBody(req));
      const result = await this.toolHandler.handleToolCall('system', 'agency_git_push', { repositoryId, ...body });
      this.json(res, result);
      return;
    }

    if (req.method === 'POST' && path === '/api/agency/hire' && this.toolHandler) {
      // Quick hire by forking an existing blueprint
      const body = JSON.parse(await this.readBody(req));
      const { sourceRole, name, id, gender, customPrompt } = body;
      if (!sourceRole || !name) {
        this.json(res, { success: false, error: 'sourceRole and name are required' });
        return;
      }
      // Find a blueprint with this role to fork from
      const blueprints = this.agentManager.getAllBlueprints();
      const source = blueprints.find(b => b.role.toLowerCase().includes(sourceRole.toLowerCase()) || b.id === sourceRole);
      if (!source) {
        this.json(res, { success: false, error: `No blueprint found for role '${sourceRole}'` });
        return;
      }
      const agentId = id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      this.json(res, {
        success: true,
        data: { message: `Fork ${source.id} as ${agentId}. Use PUT /api/blueprints/${agentId} to finalize.`, sourceId: source.id, agentId },
      });
      return;
    }

    if (req.method === 'POST' && path === '/api/agency/tasks' && this.toolHandler) {
      const body = JSON.parse(await this.readBody(req));
      const result = await this.toolHandler.handleToolCall(body.agentId ?? 'system', 'agency_create_task', body);
      this.json(res, result);
      return;
    }

    if (req.method === 'POST' && path.startsWith('/api/approvals/')) {
      const approvalId = path.split('/').pop();
      const body = await this.readBody(req);
      const { status, feedback } = JSON.parse(body);
      if (approvalId) {
        await this.store.resolveApproval(approvalId, status, feedback);
      }
      this.json(res, { ok: true });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private json(res: ServerResponse, data: any): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  close(): void {
    this.server?.close();
  }
}

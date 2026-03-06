import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { TaskRouter } from './task-router.js';
import type { TaskBoard } from './task-board.js';

/**
 * Simple HTTP API for the dashboard.
 * Runs on the same port as the WebSocket server + 1 (e.g., 3002).
 */
export class APIServer {
  private store: StateStore;
  private agentManager: AgentManager;
  private taskRouter: TaskRouter;
  private taskBoard: TaskBoard;
  private server: ReturnType<typeof createServer> | null = null;

  constructor(store: StateStore, agentManager: AgentManager, taskRouter: TaskRouter, taskBoard: TaskBoard) {
    this.store = store;
    this.agentManager = agentManager;
    this.taskRouter = taskRouter;
    this.taskBoard = taskBoard;
  }

  start(port: number): void {
    this.server = createServer(async (req, res) => {
      // CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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
          channels: bp?.slackChannels ?? [],
          reportsTo: bp?.reportsTo ?? null,
        };
      });
      this.json(res, result);
      return;
    }

    if (req.method === 'GET' && path === '/api/projects') {
      const projects = await this.store.getAllProjects();
      const enriched = await Promise.all(projects.map(async p => {
        const tasks = await this.store.getTasksByProject(p.id);
        return {
          ...p,
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

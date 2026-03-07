import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import crypto from 'crypto';
import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { TaskRouter } from './task-router.js';
import type { TaskBoard } from './task-board.js';
import type { MemoryManager } from './memory-manager.js';
import type { AgentToolHandler } from './agent-tools.js';
import type { DashboardWSServer } from './ws-server.js';
import { getSDKMetrics } from './sdk-util.js';
import { Logger } from './logger.js';
import { AgentScoringEngine } from './agent-scoring.js';
import { TaskEstimator } from './task-estimator.js';

const log = new Logger({ component: 'api-server' });

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Validates a value is a non-empty string. */
function requireString(val: unknown, name: string): string {
  if (typeof val !== 'string' || val.trim().length === 0) {
    throw new ValidationError(`${name} is required and must be a non-empty string`);
  }
  return val.trim();
}

/** Validates a value is a positive integer (or returns a default). */
function optionalInt(val: unknown, defaultVal: number, min = 1, max = 1000): number {
  if (val === undefined || val === null || val === '') return defaultVal;
  const n = typeof val === 'string' ? parseInt(val, 10) : Number(val);
  if (!Number.isFinite(n) || n < min) return min;
  return Math.min(n, max);
}

class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// Simple in-memory rate limiter (per-IP, sliding window)
// ---------------------------------------------------------------------------

interface RateBucket {
  count: number;
  resetAt: number;
}

class RateLimiter {
  private buckets: Map<string, RateBucket> = new Map();
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /** Returns true if the request should be allowed, false if rate limited. */
  allow(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      this.buckets.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.maxRequests) return false;
    bucket.count++;
    return true;
  }

  /** Periodic cleanup of expired buckets. */
  cleanup(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (now > bucket.resetAt) this.buckets.delete(key);
    }
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max request body size: 256 KB. */
const MAX_BODY_SIZE = 256 * 1024;

/**
 * Simple HTTP API for the dashboard.
 * Runs on the same port as the WebSocket server + 1 (e.g., 3002).
 */
export interface APIServerOptions {
  /** API key for authentication. If set, all requests must include Bearer token. */
  apiKey?: string;
  /** Allowed CORS origins. Defaults to '*'. Use comma-separated list for multiple. */
  corsOrigins?: string;
}

export class APIServer {
  private store: StateStore;
  private agentManager: AgentManager;
  private taskRouter: TaskRouter;
  private taskBoard: TaskBoard;
  private memoryManager: MemoryManager | null = null;
  private toolHandler: AgentToolHandler | null = null;
  private wsServer: DashboardWSServer | null = null;
  private server: ReturnType<typeof createServer> | null = null;
  private onSettingsChanged: (() => Promise<void>) | null = null;

  // Security
  private apiKeyHash: string | null = null;
  private corsOrigins: string;
  private scoringEngine: AgentScoringEngine;
  private taskEstimator: TaskEstimator;

  // Rate limiters: mutation endpoints are stricter
  private mutationLimiter = new RateLimiter(30, 60_000);   // 30 req/min
  private readLimiter = new RateLimiter(120, 60_000);       // 120 req/min
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    store: StateStore,
    agentManager: AgentManager,
    taskRouter: TaskRouter,
    taskBoard: TaskBoard,
    options: APIServerOptions = {},
  ) {
    this.store = store;
    this.agentManager = agentManager;
    this.taskRouter = taskRouter;
    this.taskBoard = taskBoard;
    this.scoringEngine = new AgentScoringEngine(store);
    this.taskEstimator = new TaskEstimator(store);

    // API key auth — store hash to avoid keeping key in memory
    const key = options.apiKey ?? process.env.AGENCY_API_KEY;
    if (key) {
      this.apiKeyHash = crypto.createHash('sha256').update(key).digest('hex');
      log.info('API key authentication enabled');
    }

    this.corsOrigins = options.corsOrigins ?? process.env.AGENCY_CORS_ORIGINS ?? '*';

    // Clean up rate limiter buckets every 5 min
    this.cleanupTimer = setInterval(() => {
      this.mutationLimiter.cleanup();
      this.readLimiter.cleanup();
    }, 5 * 60_000);
  }

  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  setToolHandler(handler: AgentToolHandler): void {
    this.toolHandler = handler;
  }

  setWSServer(ws: DashboardWSServer): void {
    this.wsServer = ws;
  }

  setOnSettingsChanged(cb: () => Promise<void>): void {
    this.onSettingsChanged = cb;
  }

  start(port: number): void {
    this.server = createServer(async (req, res) => {
      const startMs = Date.now();
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      // CORS — configurable origins
      const origin = req.headers.origin ?? '*';
      if (this.corsOrigins === '*') {
        res.setHeader('Access-Control-Allow-Origin', '*');
      } else {
        const allowed = this.corsOrigins.split(',').map(s => s.trim());
        if (allowed.includes(origin)) {
          res.setHeader('Access-Control-Allow-Origin', origin);
          res.setHeader('Vary', 'Origin');
        }
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        // API key authentication
        if (this.apiKeyHash) {
          const authHeader = req.headers.authorization;
          if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
            return;
          }
          const token = authHeader.slice(7);
          const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
          if (!crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(this.apiKeyHash))) {
            log.warn('Authentication failed', { ip: req.socket.remoteAddress, path: url.pathname });
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid API key' }));
            return;
          }
        }

        // Rate limiting
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        const isMutation = req.method === 'POST' || req.method === 'PUT';
        const limiter = isMutation ? this.mutationLimiter : this.readLimiter;
        if (!limiter.allow(clientIp)) {
          log.warn('Rate limited', { ip: clientIp, path: url.pathname });
          res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '60' });
          res.end(JSON.stringify({ error: 'Too many requests' }));
          return;
        }

        await this.route(req, res);

        // Audit trail for mutations
        if (isMutation) {
          const durationMs = Date.now() - startMs;
          log.info('API mutation', {
            method: req.method,
            path: url.pathname,
            ip: clientIp,
            status: res.statusCode,
            durationMs,
          });
        }
      } catch (err: any) {
        const durationMs = Date.now() - startMs;
        if (err instanceof ValidationError) {
          log.warn('Validation error', { path: url.pathname, error: err.message, durationMs });
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        } else {
          log.error('Request error', { path: url.pathname, error: err.message, durationMs });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
    });

    this.server.listen(port, () => {
      log.info('API server started', { port, auth: !!this.apiKeyHash, cors: this.corsOrigins });
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
      if (!bp) return this.notFound(res, 'Blueprint not found');
      this.json(res, bp);
      return;
    }

    if (req.method === 'PUT' && path.match(/^\/api\/blueprints\/[^/]+$/)) {
      const id = path.split('/').pop()!;
      const body = await this.parseBody(req);
      const existing = await this.store.getBlueprint(id);
      if (!existing) return this.notFound(res, 'Blueprint not found');
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
      if (!project) return this.notFound(res, 'Project not found');
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

    // Tasks with pagination & filtering
    if (req.method === 'GET' && path === '/api/tasks') {
      const projectId = url.searchParams.get('projectId');
      const status = url.searchParams.get('status');
      const agentId = url.searchParams.get('agentId');
      const limit = optionalInt(url.searchParams.get('limit'), 100, 1, 500);
      const offset = optionalInt(url.searchParams.get('offset'), 0, 0, 100_000);

      if (projectId) {
        const tasks = await this.store.getTasksByProject(projectId);
        const filtered = this.filterTasks(tasks, status, agentId);
        this.json(res, { tasks: filtered.slice(offset, offset + limit), total: filtered.length });
      } else {
        const tasks = await this.store.getAllTasks(limit + offset);
        const filtered = this.filterTasks(tasks, status, agentId);
        this.json(res, { tasks: filtered.slice(offset, offset + limit), total: filtered.length });
      }
      return;
    }

    if (req.method === 'GET' && path === '/api/approvals') {
      const approvals = await this.store.getPendingApprovals();
      this.json(res, approvals);
      return;
    }

    if (req.method === 'POST' && path === '/api/submit') {
      const body = await this.parseBody(req);
      const title = requireString(body.title, 'title');
      const description = requireString(body.description, 'description');
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
      const byProject = await this.store.getCostByProject();
      this.json(res, { ...summary, recent, byProject });
      return;
    }

    if (req.method === 'POST' && path === '/api/settings') {
      const entries = await this.parseBody(req) as Record<string, string>;
      if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) {
        throw new ValidationError('Body must be a JSON object of key/value pairs');
      }
      for (const [key, value] of Object.entries(entries)) {
        if (typeof key !== 'string' || typeof value !== 'string') continue;
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
      const body = await this.parseBody(req);
      const result = await this.toolHandler.handleToolCall(body.agentId ?? 'system', 'agency_create_project', body);
      this.json(res, result);
      return;
    }

    if (req.method === 'POST' && path === '/api/agency/repositories' && this.toolHandler) {
      const body = await this.parseBody(req);
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
      const body = await this.parseBody(req);
      const result = await this.toolHandler.handleToolCall('system', 'agency_git_push', { repositoryId, ...body });
      this.json(res, result);
      return;
    }

    if (req.method === 'POST' && path.match(/^\/api\/agency\/repositories\/[^/]+\/merge$/) && this.toolHandler) {
      const repositoryId = path.split('/')[4];
      const body = await this.parseBody(req);
      const result = await this.toolHandler.handleToolCall('system', 'agency_git_merge', { repositoryId, ...body });
      this.json(res, result);
      return;
    }

    if (req.method === 'POST' && path === '/api/agency/hire' && this.toolHandler) {
      const body = await this.parseBody(req);
      const sourceRole = requireString(body.sourceRole, 'sourceRole');
      const name = requireString(body.name, 'name');
      const blueprints = this.agentManager.getAllBlueprints();
      const source = blueprints.find(b => b.role.toLowerCase().includes(sourceRole.toLowerCase()) || b.id === sourceRole);
      if (!source) {
        this.json(res, { success: false, error: `No blueprint found for role '${sourceRole}'` });
        return;
      }
      const agentId = body.id ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      this.json(res, {
        success: true,
        data: { message: `Fork ${source.id} as ${agentId}. Use PUT /api/blueprints/${agentId} to finalize.`, sourceId: source.id, agentId },
      });
      return;
    }

    // Retire an agent — pause it and mark as retired
    if (req.method === 'POST' && path === '/api/agency/retire') {
      const body = await this.parseBody(req);
      const agentId = requireString(body.agentId, 'agentId');
      const blueprint = this.agentManager.getBlueprint(agentId);
      if (!blueprint) {
        this.json(res, { success: false, error: `Agent '${agentId}' not found` });
        return;
      }
      // Pause the agent to stop active work
      await this.agentManager.pauseAgent(agentId);
      // Reassign any active tasks back to backlog
      const tasks = await this.store.getTasksByAgent(agentId);
      let reassigned = 0;
      for (const task of tasks) {
        if (['queued', 'assigned', 'in_progress'].includes(task.status)) {
          await this.store.updateTaskStatus(task.id, 'backlog');
          reassigned++;
        }
      }
      this.json(res, {
        success: true,
        data: { agentId, status: 'retired', tasksReassigned: reassigned },
      });
      return;
    }

    // Direct task — send a message/task directly to an agent (investor override)
    if (req.method === 'POST' && path === '/api/agency/direct') {
      const body = await this.parseBody(req);
      const agentId = requireString(body.agentId, 'agentId');
      const message = requireString(body.message, 'message');
      const blueprint = this.agentManager.getBlueprint(agentId);
      if (!blueprint) {
        this.json(res, { success: false, error: `Agent '${agentId}' not found` });
        return;
      }
      if (body.asTask) {
        // Create and assign as a task
        const taskId = crypto.randomUUID();
        const task = {
          id: taskId,
          title: message.slice(0, 100),
          description: message,
          status: 'assigned' as const,
          projectId: body.projectId ?? null,
          assignedTo: agentId,
          createdBy: 'investor',
          parentTaskId: null,
          dependsOn: null,
          priority: body.priority ?? 8,
          deadline: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await this.store.createTask(task);
        await this.agentManager.assignTask(agentId, task);
        this.json(res, { success: true, data: { taskId, agentId, mode: 'task' } });
      } else {
        // Chat mode — get a response
        const response = await this.agentManager.chat(agentId, message);
        this.json(res, { success: true, data: { agentId, response, mode: 'chat' } });
      }
      return;
    }

    // Cancel a task
    if (req.method === 'POST' && path.match(/^\/api\/tasks\/[^/]+\/cancel$/)) {
      const taskId = path.split('/')[3];
      const body = await this.parseBody(req);
      const cancelledBy = body.cancelledBy ?? 'investor';
      await this.store.cancelTask(taskId, cancelledBy);
      this.json(res, { success: true, data: { taskId, status: 'cancelled' } });
      return;
    }

    if (req.method === 'POST' && path === '/api/agency/tasks' && this.toolHandler) {
      const body = await this.parseBody(req);
      // Support batch task creation: { tasks: [...] } — limit to 20 per request
      if (Array.isArray(body.tasks)) {
        if (body.tasks.length > 20) {
          throw new ValidationError('Batch task creation limited to 20 tasks per request');
        }
        const results = [];
        for (const taskInput of body.tasks) {
          const result = await this.toolHandler.handleToolCall(taskInput.agentId ?? body.agentId ?? 'system', 'agency_create_task', taskInput);
          results.push(result);
        }
        this.json(res, { success: true, data: results });
        return;
      }
      const result = await this.toolHandler.handleToolCall(body.agentId ?? 'system', 'agency_create_task', body);
      this.json(res, result);
      return;
    }

    // --- Performance scoring ---
    if (req.method === 'GET' && path === '/api/performance') {
      const performance = await this.store.getAllAgentPerformance();
      this.json(res, performance);
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/performance\/[^/]+$/)) {
      const agentId = path.split('/').pop()!;
      const perf = await this.store.getAgentPerformance(agentId);
      this.json(res, { agentId, ...perf });
      return;
    }

    // --- Agent Scoring ---
    if (req.method === 'GET' && path === '/api/scores') {
      const blueprints = this.agentManager.getAllBlueprints();
      const scores = await this.scoringEngine.scoreAll(blueprints);
      this.json(res, scores);
      return;
    }

    if (req.method === 'POST' && path === '/api/route-task') {
      const body = await this.parseBody(req);
      const title = requireString(body.title, 'title');
      const description = typeof body.description === 'string' ? body.description : '';
      const exclude = Array.isArray(body.exclude) ? body.exclude : [];
      const blueprints = this.agentManager.getAllBlueprints();
      const ranked = await this.scoringEngine.routeTask(blueprints, title, description, exclude);
      this.json(res, ranked);
      return;
    }

    // --- Deadlock detection ---
    if (req.method === 'GET' && path === '/api/deadlocks') {
      const cycles = await this.store.detectDeadlocks();
      this.json(res, { deadlocks: cycles, count: cycles.length });
      return;
    }

    // --- Task templates ---
    if (req.method === 'GET' && path === '/api/templates') {
      const templates = await this.store.getAllTaskTemplates();
      this.json(res, templates);
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/templates\/[^/]+$/)) {
      const id = path.split('/').pop()!;
      const template = await this.store.getTaskTemplate(id);
      if (!template) return this.notFound(res, 'Template not found');
      this.json(res, template);
      return;
    }

    // Instantiate a template → creates tasks from it
    if (req.method === 'POST' && path.match(/^\/api\/templates\/[^/]+\/instantiate$/) && this.toolHandler) {
      const templateId = path.split('/')[3];
      const template = await this.store.getTaskTemplate(templateId);
      if (!template) return this.notFound(res, 'Template not found');
      const body = await this.parseBody(req);
      const name = requireString(body.name, 'name');
      const projectId = body.projectId ?? null;

      // Create tasks from template steps, substituting {name}
      const createdTasks: any[] = [];
      const stepTaskIds: string[] = [];
      for (let i = 0; i < template.steps.length; i++) {
        const step = template.steps[i];
        const taskId = crypto.randomUUID();
        stepTaskIds.push(taskId);

        const dependsOn = step.dependsOnStep !== undefined ? stepTaskIds[step.dependsOnStep] : null;
        const task = {
          id: taskId,
          title: step.title.replace(/\{name\}/g, name),
          description: step.description.replace(/\{name\}/g, name),
          status: (step.assignTo && !dependsOn) ? 'assigned' as const : 'backlog' as const,
          projectId,
          assignedTo: step.assignTo ?? null,
          createdBy: body.agentId ?? 'system',
          parentTaskId: null,
          dependsOn,
          priority: body.priority ?? 7,
          deadline: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        await this.store.createTask(task);
        createdTasks.push({ taskId, title: task.title, assignedTo: task.assignedTo, dependsOn });

        // Start tasks that have no dependencies
        if (step.assignTo && !dependsOn && this.agentManager.getBlueprint(step.assignTo)) {
          this.agentManager.assignTask(step.assignTo, task).catch(() => {});
        }
      }

      this.json(res, { success: true, data: { templateId, tasks: createdTasks } });
      return;
    }

    // --- Emergency pause ---
    if (req.method === 'POST' && path === '/api/emergency/pause') {
      const aborted = await this.agentManager.pauseAll();
      this.json(res, { success: true, paused: true, abortedAgents: aborted });
      return;
    }

    if (req.method === 'POST' && path === '/api/emergency/resume') {
      await this.agentManager.resumeAll();
      this.json(res, { success: true, paused: false });
      return;
    }

    if (req.method === 'GET' && path === '/api/emergency/status') {
      this.json(res, { paused: this.agentManager.isEmergencyPaused() });
      return;
    }

    // --- Task priority rebalancing ---
    if (req.method === 'POST' && path === '/api/tasks/rebalance') {
      const body = await this.parseBody(req);
      const { updates } = body;
      if (!Array.isArray(updates)) {
        throw new ValidationError('updates array is required');
      }
      if (updates.length > 50) {
        throw new ValidationError('Maximum 50 priority updates per request');
      }
      await this.store.rebalancePriorities(updates);
      this.json(res, { success: true, updated: updates.length });
      return;
    }

    // --- Task duration estimates (enhanced with confidence intervals) ---
    if (req.method === 'GET' && path === '/api/estimates') {
      const estimates = await this.store.getTaskDurationEstimates();
      this.json(res, estimates);
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/estimates\/[^/]+$/)) {
      const agentId = path.split('/')[3];
      const taskTitle = url.searchParams.get('title') ?? '';
      const estimate = await this.taskEstimator.estimate(agentId, taskTitle);
      this.json(res, estimate);
      return;
    }

    // Estimate entire project completion
    if (req.method === 'GET' && path.match(/^\/api\/projects\/[^/]+\/estimate$/)) {
      const projectId = path.split('/')[3];
      const estimate = await this.taskEstimator.estimateProject(projectId);
      this.json(res, estimate);
      return;
    }

    // Bulk estimate for multiple tasks
    if (req.method === 'POST' && path === '/api/estimates/bulk') {
      const body = await this.parseBody(req);
      if (!Array.isArray(body.tasks)) {
        throw new ValidationError('tasks array is required');
      }
      if (body.tasks.length > 50) {
        throw new ValidationError('Maximum 50 tasks per bulk estimate');
      }
      const results = await Promise.all(
        body.tasks.map(async (t: { agentId?: string; title: string }) => ({
          title: t.title,
          agentId: t.agentId ?? null,
          estimate: await this.taskEstimator.estimate(t.agentId ?? null, t.title),
        }))
      );
      this.json(res, results);
      return;
    }

    // --- Skill matching ---
    if (req.method === 'POST' && path === '/api/skill-match') {
      const body = await this.parseBody(req);
      const title = requireString(body.title, 'title');
      const description = typeof body.description === 'string' ? body.description : '';
      const exclude = Array.isArray(body.exclude) ? body.exclude : [];
      const blueprints = this.agentManager.getAllBlueprints();
      const matches = this.store.findBestAgent(blueprints, title, description, exclude);
      this.json(res, matches);
      return;
    }

    // --- Audit log with pagination ---
    if (req.method === 'GET' && path === '/api/audit') {
      const channel = url.searchParams.get('channel') ?? 'ceo-investor';
      const limit = optionalInt(url.searchParams.get('limit'), 50, 1, 200);
      const entries = await this.store.getAuditLog(channel, limit);
      this.json(res, entries);
      return;
    }

    // --- Webhook management ---
    if (req.method === 'GET' && path === '/api/webhooks') {
      const hooks = (this.agentManager as any).config?.webhooks ?? [];
      this.json(res, hooks.map((h: any) => ({ url: h.url, events: h.events, hasSecret: !!h.secret })));
      return;
    }

    if (req.method === 'POST' && path === '/api/webhooks') {
      const body = await this.parseBody(req);
      const hookUrl = requireString(body.url, 'url');
      if (!Array.isArray(body.events) || body.events.length === 0) {
        throw new ValidationError('events array is required and must not be empty');
      }
      const config = (this.agentManager as any).config;
      if (config?.webhooks) {
        config.webhooks.push({ url: hookUrl, events: body.events, secret: body.secret });
      }
      this.json(res, { success: true });
      return;
    }

    // --- Investor request tracking ---
    if (req.method === 'GET' && path === '/api/investor-requests') {
      const requests = await this.store.getInvestorRequests();
      const enriched = await Promise.all(requests.map(async r => {
        let tasks: any[] = [];
        if (r.rootTaskId) {
          tasks = await this.store.getInvestorRequestTasks(r.rootTaskId);
        }
        const taskSummary = {
          total: tasks.length,
          done: tasks.filter(t => t.status === 'done').length,
          inProgress: tasks.filter(t => t.status === 'in_progress').length,
          blocked: tasks.filter(t => t.status === 'blocked').length,
        };
        return { ...r, taskSummary, tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status, assignedTo: t.assignedTo })) };
      }));
      this.json(res, enriched);
      return;
    }

    if (req.method === 'POST' && path.startsWith('/api/approvals/')) {
      const approvalId = path.split('/').pop();
      const body = await this.parseBody(req);
      const status = requireString(body.status, 'status');
      if (!['approved', 'rejected'].includes(status)) {
        throw new ValidationError('status must be "approved" or "rejected"');
      }
      if (approvalId) {
        await this.store.resolveApproval(approvalId, status as 'approved' | 'rejected', body.feedback);
      }
      this.json(res, { ok: true });
      return;
    }

    // --- Agent Health Metrics ---
    if (req.method === 'GET' && path === '/api/health') {
      const metrics = await this.store.getAllAgentHealthMetrics();
      this.json(res, metrics);
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/health\/[^/]+$/)) {
      const agentId = path.split('/').pop()!;
      const metrics = await this.store.getAgentHealthMetrics(agentId);
      this.json(res, { agentId, ...metrics });
      return;
    }

    // --- Task Deadline / SLA ---
    if (req.method === 'POST' && path.match(/^\/api\/tasks\/[^/]+\/deadline$/)) {
      const taskId = path.split('/')[3];
      const body = await this.parseBody(req);
      const deadlineStr = requireString(body.deadline, 'deadline');
      const deadline = new Date(deadlineStr);
      if (isNaN(deadline.getTime())) {
        throw new ValidationError('deadline must be a valid ISO date string');
      }
      await this.store.setTaskDeadline(taskId, deadline);
      this.json(res, { success: true, taskId, deadline: deadline.toISOString() });
      return;
    }

    if (req.method === 'GET' && path === '/api/tasks/overdue') {
      const overdue = await this.store.getOverdueTasks();
      this.json(res, overdue);
      return;
    }

    if (req.method === 'GET' && path === '/api/tasks/near-deadline') {
      const hours = optionalInt(url.searchParams.get('hours'), 2, 1, 168);
      const tasks = await this.store.getTasksNearDeadline(hours);
      this.json(res, tasks);
      return;
    }

    // --- Daily Cost Digest ---
    if (req.method === 'GET' && path === '/api/cost-digest') {
      const hours = optionalInt(url.searchParams.get('hours'), 24, 1, 720);
      const digest = await this.store.getCostDigest(hours);
      this.json(res, digest);
      return;
    }

    // --- Agent Timeline (swimlane visualization) ---
    if (req.method === 'GET' && path === '/api/timeline') {
      const hours = optionalInt(url.searchParams.get('hours'), 72, 1, 720);
      const timeline = await this.store.getAgentTimeline(hours);
      // Enrich with agent names
      const blueprints = this.agentManager.getAllBlueprints();
      const enriched = timeline.map(t => {
        const bp = blueprints.find(b => b.id === t.agentId);
        return { ...t, agentName: bp?.name ?? t.agentId, role: bp?.role ?? 'Unknown', avatar: bp?.avatar ?? null };
      });
      this.json(res, enriched);
      return;
    }

    // --- SDK Metrics (in-process quickQuery stats) ---
    if (req.method === 'GET' && path === '/api/sdk-metrics') {
      this.json(res, getSDKMetrics());
      return;
    }

    // --- WebSocket connection stats ---
    if (req.method === 'GET' && path === '/api/ws-stats') {
      this.json(res, this.wsServer ? this.wsServer.getStats() : { error: 'WS server not configured' });
      return;
    }

    // --- Cascade Task Operations ---
    if (req.method === 'POST' && path.match(/^\/api\/tasks\/[^/]+\/cancel$/)) {
      const taskId = path.split('/')[3];
      const cancelled = await this.store.cascadeCancelTask(taskId);
      this.json(res, { success: true, cancelled, count: cancelled.length });
      return;
    }

    if (req.method === 'POST' && path.match(/^\/api\/tasks\/[^/]+\/reassign$/)) {
      const taskId = path.split('/')[3];
      const body = await this.parseBody(req);
      const agentId = requireString(body.agentId, 'agentId');
      // Validate target agent exists
      const targetBp = this.agentManager.getBlueprint(agentId);
      if (!targetBp) {
        throw new ValidationError(`Agent '${agentId}' not found`);
      }
      const reassigned = await this.store.cascadeReassignTask(taskId, agentId, body.cascade ?? false);
      this.json(res, { success: true, reassigned, count: reassigned.length });
      return;
    }

    // --- Agent Workload Balancing ---
    if (req.method === 'GET' && path === '/api/workload') {
      const workloads = await this.store.getAgentWorkloads();
      this.json(res, workloads);
      return;
    }

    if (req.method === 'POST' && path === '/api/workload/rebalance') {
      const body = await this.parseBody(req);
      const fromAgent = requireString(body.fromAgent, 'fromAgent');
      const toAgent = requireString(body.toAgent, 'toAgent');
      const count = optionalInt(body.count, 1, 1, 10);
      const candidates = await this.store.getRebalanceCandidates(fromAgent, count);
      const moved: string[] = [];
      for (const task of candidates) {
        await this.store.cascadeReassignTask(task.id, toAgent, false);
        moved.push(task.id);
      }
      this.json(res, { success: true, moved, count: moved.length });
      return;
    }

    // --- Task Progress Notes ---
    if (req.method === 'POST' && path.match(/^\/api\/tasks\/[^/]+\/notes$/)) {
      const taskId = path.split('/')[3];
      const body = await this.parseBody(req);
      const agentIdVal = requireString(body.agentId, 'agentId');
      const content = requireString(body.content, 'content');
      const noteId = await this.store.addTaskNote(taskId, agentIdVal, content);
      this.json(res, { success: true, noteId });
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/tasks\/[^/]+\/notes$/)) {
      const taskId = path.split('/')[3];
      const notes = await this.store.getTaskNotes(taskId);
      this.json(res, notes);
      return;
    }

    if (req.method === 'GET' && path === '/api/activity-feed') {
      const limit = optionalInt(url.searchParams.get('limit'), 20, 1, 100);
      const feed = await this.store.getRecentTaskNotes(limit);
      this.json(res, feed);
      return;
    }

    this.notFound(res, 'Not found');
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private filterTasks(tasks: any[], status: string | null, agentId: string | null): any[] {
    let result = tasks;
    if (status) result = result.filter(t => t.status === status);
    if (agentId) result = result.filter(t => t.assignedTo === agentId);
    return result;
  }

  private json(res: ServerResponse, data: any): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private notFound(res: ServerResponse, message: string): void {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
  }

  /** Read and parse JSON body with size limit and safe parsing. */
  private async parseBody(req: IncomingMessage): Promise<any> {
    const raw = await this.readBody(req);
    try {
      return JSON.parse(raw);
    } catch {
      throw new ValidationError('Invalid JSON in request body');
    }
  }

  /** Read raw request body with size limit. */
  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      let size = 0;
      req.on('data', (chunk: Buffer | string) => {
        size += typeof chunk === 'string' ? chunk.length : chunk.byteLength;
        if (size > MAX_BODY_SIZE) {
          req.destroy();
          reject(new ValidationError(`Request body exceeds maximum size of ${MAX_BODY_SIZE / 1024}KB`));
          return;
        }
        body += chunk;
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.server?.close();
  }
}

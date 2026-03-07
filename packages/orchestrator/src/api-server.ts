import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { TaskRouter } from './task-router.js';
import type { TaskBoard } from './task-board.js';
import type { MemoryManager } from './memory-manager.js';
import type { AgentToolHandler } from './agent-tools.js';
import { getSDKMetrics } from './sdk-util.js';

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
      const byProject = await this.store.getCostByProject();
      this.json(res, { ...summary, recent, byProject });
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

    if (req.method === 'POST' && path.match(/^\/api\/agency\/repositories\/[^/]+\/merge$/) && this.toolHandler) {
      const repositoryId = path.split('/')[4];
      const body = JSON.parse(await this.readBody(req));
      const result = await this.toolHandler.handleToolCall('system', 'agency_git_merge', { repositoryId, ...body });
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
      // Support batch task creation: { tasks: [...] }
      if (Array.isArray(body.tasks)) {
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
      if (!template) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Template not found' }));
        return;
      }
      this.json(res, template);
      return;
    }

    // Instantiate a template → creates tasks from it
    if (req.method === 'POST' && path.match(/^\/api\/templates\/[^/]+\/instantiate$/) && this.toolHandler) {
      const templateId = path.split('/')[3];
      const template = await this.store.getTaskTemplate(templateId);
      if (!template) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Template not found' }));
        return;
      }
      const body = JSON.parse(await this.readBody(req));
      const { name, projectId } = body;
      if (!name) {
        this.json(res, { success: false, error: 'name is required' });
        return;
      }

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
          projectId: projectId ?? null,
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
      const body = JSON.parse(await this.readBody(req));
      const { updates } = body; // Array of { taskId, priority }
      if (!Array.isArray(updates)) {
        this.json(res, { success: false, error: 'updates array is required' });
        return;
      }
      await this.store.rebalancePriorities(updates);
      this.json(res, { success: true, updated: updates.length });
      return;
    }

    // --- Task duration estimates ---
    if (req.method === 'GET' && path === '/api/estimates') {
      const estimates = await this.store.getTaskDurationEstimates();
      this.json(res, estimates);
      return;
    }

    if (req.method === 'GET' && path.match(/^\/api\/estimates\/[^/]+$/)) {
      const agentId = path.split('/')[3];
      const taskTitle = url.searchParams.get('title') ?? '';
      const estimate = await this.store.estimateTaskDuration(agentId, taskTitle);
      this.json(res, estimate ?? { estimatedMs: null, confidence: 'none' });
      return;
    }

    // --- Skill matching ---
    if (req.method === 'POST' && path === '/api/skill-match') {
      const body = JSON.parse(await this.readBody(req));
      const { title, description, exclude } = body;
      if (!title) {
        this.json(res, { success: false, error: 'title is required' });
        return;
      }
      const blueprints = this.agentManager.getAllBlueprints();
      const matches = this.store.findBestAgent(blueprints, title, description ?? '', exclude ?? []);
      this.json(res, matches);
      return;
    }

    // --- Audit log ---
    if (req.method === 'GET' && path === '/api/audit') {
      const channel = url.searchParams.get('channel') ?? 'ceo-investor';
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);
      const entries = await this.store.getAuditLog(channel, limit);
      this.json(res, entries);
      return;
    }

    // --- Webhook management ---
    if (req.method === 'GET' && path === '/api/webhooks') {
      // Return configured webhooks (mask secrets)
      const hooks = (this.agentManager as any).config?.webhooks ?? [];
      this.json(res, hooks.map((h: any) => ({ url: h.url, events: h.events, hasSecret: !!h.secret })));
      return;
    }

    if (req.method === 'POST' && path === '/api/webhooks') {
      const body = JSON.parse(await this.readBody(req));
      const { url: hookUrl, events, secret } = body;
      if (!hookUrl || !events) {
        this.json(res, { success: false, error: 'url and events are required' });
        return;
      }
      const config = (this.agentManager as any).config;
      if (config?.webhooks) {
        config.webhooks.push({ url: hookUrl, events, secret });
      }
      this.json(res, { success: true });
      return;
    }

    // --- Investor request tracking ---
    if (req.method === 'GET' && path === '/api/investor-requests') {
      const requests = await this.store.getInvestorRequests();
      // Enrich with task progress
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
      const body = await this.readBody(req);
      const { status, feedback } = JSON.parse(body);
      if (approvalId) {
        await this.store.resolveApproval(approvalId, status, feedback);
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
      const body = JSON.parse(await this.readBody(req));
      if (!body.deadline) {
        this.json(res, { success: false, error: 'deadline (ISO string) is required' });
        return;
      }
      await this.store.setTaskDeadline(taskId, new Date(body.deadline));
      this.json(res, { success: true, taskId, deadline: body.deadline });
      return;
    }

    if (req.method === 'GET' && path === '/api/tasks/overdue') {
      const overdue = await this.store.getOverdueTasks();
      this.json(res, overdue);
      return;
    }

    if (req.method === 'GET' && path === '/api/tasks/near-deadline') {
      const hours = parseInt(url.searchParams.get('hours') ?? '2', 10);
      const tasks = await this.store.getTasksNearDeadline(hours);
      this.json(res, tasks);
      return;
    }

    // --- Daily Cost Digest ---
    if (req.method === 'GET' && path === '/api/cost-digest') {
      const hours = parseInt(url.searchParams.get('hours') ?? '24', 10);
      const digest = await this.store.getCostDigest(hours);
      this.json(res, digest);
      return;
    }

    // --- SDK Metrics (in-process quickQuery stats) ---
    if (req.method === 'GET' && path === '/api/sdk-metrics') {
      this.json(res, getSDKMetrics());
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
      const body = JSON.parse(await this.readBody(req));
      if (!body.agentId) {
        this.json(res, { success: false, error: 'agentId is required' });
        return;
      }
      const reassigned = await this.store.cascadeReassignTask(taskId, body.agentId, body.cascade ?? false);
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
      const body = JSON.parse(await this.readBody(req));
      const { fromAgent, toAgent, count } = body;
      if (!fromAgent || !toAgent) {
        this.json(res, { success: false, error: 'fromAgent and toAgent are required' });
        return;
      }
      const candidates = await this.store.getRebalanceCandidates(fromAgent, count ?? 1);
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
      const body = JSON.parse(await this.readBody(req));
      if (!body.agentId || !body.content) {
        this.json(res, { success: false, error: 'agentId and content are required' });
        return;
      }
      const noteId = await this.store.addTaskNote(taskId, body.agentId, body.content);
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
      const limit = parseInt(url.searchParams.get('limit') ?? '20', 10);
      const feed = await this.store.getRecentTaskNotes(limit);
      this.json(res, feed);
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

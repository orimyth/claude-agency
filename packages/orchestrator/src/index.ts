import { agencyConfig } from './config/agency.config.js';
import { defaultBlacklist } from './config/blacklist.js';
import { defaultBlueprints } from './config/blueprints/index.js';
import { StateStore } from './state-store.js';
import { PermissionEngine } from './permission-engine.js';
import { AgentManager } from './agent-manager.js';
import { Scheduler } from './scheduler.js';
import { TaskRouter } from './task-router.js';
import { TaskBoard } from './task-board.js';
import { HRManager } from './hr-manager.js';
import { WorkflowEngine } from './workflow-engine.js';
import { DashboardWSServer } from './ws-server.js';
import { MemoryManager } from './memory-manager.js';
import { AgentToolHandler } from './agent-tools.js';
import { APIServer } from './api-server.js';
import { SlackBridge, type InvestorMessage } from 'slack-bridge';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { quickQuery } from './sdk-util.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Lightweight model for utility tasks (intent classification). */
const UTILITY_MODEL = 'claude-haiku-4-5-20251001';

export class Agency {
  private store: StateStore;
  private permissions: PermissionEngine;
  private agentManager: AgentManager;
  private scheduler: Scheduler;
  private taskRouter: TaskRouter;
  private taskBoard: TaskBoard;
  private hrManager!: HRManager;
  private workflowEngine!: WorkflowEngine;
  private wsServer: DashboardWSServer;
  private memoryManager: MemoryManager;
  private toolHandler: AgentToolHandler;
  private apiServer: APIServer;
  private slack: SlackBridge | null = null;
  /** Maps "channel:taskTitle" → Slack thread_ts for threaded replies */
  private taskThreads: Map<string, string> = new Map();

  constructor() {
    this.store = new StateStore(agencyConfig.mysql);
    this.permissions = new PermissionEngine(defaultBlacklist);
    this.agentManager = new AgentManager(this.store, this.permissions, agencyConfig);
    this.memoryManager = new MemoryManager(this.store);
    this.toolHandler = new AgentToolHandler(this.store, this.agentManager, agencyConfig.workspace);
    this.agentManager.setMemoryManager(this.memoryManager);
    this.agentManager.setToolHandler(this.toolHandler);
    this.scheduler = new Scheduler(this.store, this.agentManager);
    this.taskRouter = new TaskRouter(this.store, this.agentManager);
    this.taskBoard = new TaskBoard(this.store);
    this.wsServer = new DashboardWSServer(agencyConfig.wsPort);
    this.apiServer = new APIServer(this.store, this.agentManager, this.taskRouter, this.taskBoard);
  }

  async start(): Promise<void> {
    console.log('Starting Claude Agency...');

    // Initialize database
    await this.store.initialize();
    console.log('Database initialized');

    // Seed default blueprints into MySQL (only inserts if not already there)
    for (const blueprint of defaultBlueprints) {
      await this.store.saveBlueprint(blueprint, true);
    }
    console.log(`  Seeded ${defaultBlueprints.length} default blueprints`);

    // Load ALL active blueprints from MySQL (defaults + hired)
    const allBlueprints = await this.store.getAllBlueprints();
    for (const blueprint of allBlueprints) {
      this.agentManager.registerBlueprint(blueprint);
      await this.agentManager.initializeAgent(blueprint);
      console.log(`  Agent registered: ${blueprint.name} (${blueprint.role})`);
    }

    // Initialize HR manager
    this.hrManager = new HRManager(this.agentManager, this.store);

    // Initialize workflow engine
    this.workflowEngine = new WorkflowEngine(
      this.agentManager, this.store, this.taskBoard, this.hrManager, agencyConfig,
    );
    this.setupWorkflowEvents();

    // Initialize Slack if configured
    if (agencyConfig.slack.botToken && agencyConfig.slack.appToken) {
      try {
        this.slack = new SlackBridge({
          botToken: agencyConfig.slack.botToken,
          signingSecret: agencyConfig.slack.signingSecret,
          appToken: agencyConfig.slack.appToken,
        });
        await this.slack.start();
        // Register agent names for mention detection
        this.slack.setAgentNames(
          this.agentManager.getAllBlueprints().map(b => ({ id: b.id, name: b.name }))
        );
        this.setupSlackBridge();
        console.log('Slack bridge connected');
      } catch (err: any) {
        console.warn(`Slack connection failed: ${err.message}. Running without Slack.`);
        this.slack = null;
      }
    } else {
      console.log('Slack not configured. Run `pnpm setup:slack` to enable.');
    }

    // Load saved settings
    await this.loadSettings();

    // Wire up agent events
    this.setupAgentEvents();

    // Start the scheduler and wire up status reports
    this.scheduler.start();
    this.setupSchedulerEvents();
    console.log('Scheduler started');

    // Prune stale memories every 6 hours
    setInterval(() => {
      this.memoryManager.prune().catch(err => {
        console.error('[Memory prune error]', err.message);
      });
    }, 6 * 60 * 60_000);

    // Deadlock detection every 5 minutes
    setInterval(async () => {
      try {
        const cycles = await this.store.detectDeadlocks();
        for (const cycle of cycles) {
          console.warn(`[Deadlock] Circular dependency detected: ${cycle.join(' → ')}`);
          // Auto-resolve by breaking the cycle: unblock the first task
          const firstTaskId = cycle[0];
          const firstTask = await this.store.getTask(firstTaskId);
          if (firstTask) {
            await this.store.updateTaskStatus(firstTaskId, 'assigned');
            // Clear the dependency to break the cycle
            await this.store.updateTaskDescription(firstTaskId,
              (firstTask.description ?? '') + '\n\n[Deadlock auto-resolved: dependency cycle broken by system]');
            const channel = firstTask.projectId ? `project-${firstTask.projectId}` : 'leadership';
            this.agentManager.notify('pm', channel,
              `broke a deadlock cycle: "${firstTask.title}" was in a circular dependency. unblocked it`);
          }
        }
      } catch (err: any) {
        console.error('[Deadlock detection error]', err.message);
      }
    }, 5 * 60_000);

    // Seed default task templates
    await this.seedTaskTemplates();

    // Wire project creation → Slack channel creation
    this.toolHandler.setOnProjectCreated(async (projectId: string, projectName: string) => {
      if (this.slack) {
        await this.slack.createProjectChannel(projectName);
        console.log(`Created Slack channel for project: ${projectName}`);
      }
    });

    // Start API server
    this.apiServer.setMemoryManager(this.memoryManager);
    this.apiServer.setToolHandler(this.toolHandler);
    this.apiServer.setOnSettingsChanged(() => this.loadSettings());
    this.apiServer.start(agencyConfig.wsPort + 1);

    console.log(`WebSocket server running on port ${agencyConfig.wsPort}`);
    console.log(`API server running on port ${agencyConfig.wsPort + 1}`);
    console.log('Claude Agency is running. Waiting for tasks...\n');
  }

  private setupAgentEvents(): void {
    this.agentManager.on('message', async (agentId: string, channel: string, content: string) => {
      this.wsServer.broadcast('message:new', { agentId, channel, content });

      await this.store.saveMessage({
        id: crypto.randomUUID(),
        fromAgentId: agentId,
        toAgentId: null,
        channel,
        content,
        timestamp: new Date(),
      });

      // Forward to Slack with threading support
      if (this.slack) {
        const blueprint = this.agentManager.getBlueprint(agentId);
        if (blueprint) {
          const slackChannel = this.mapToSlackChannel(channel);
          // Check if there's an existing thread for this channel+agent combo
          const threadKey = `${channel}:${agentId}`;
          const threadTs = this.taskThreads.get(threadKey);
          const messageTs = await this.slack.sendAgentMessage(slackChannel, blueprint.name, blueprint.role, content, blueprint.avatar, threadTs);
          // If this is a new message (no thread yet), start a thread for follow-ups
          if (!threadTs && messageTs && content.includes('picking up')) {
            this.taskThreads.set(threadKey, messageTs);
          }
        }
      }

      // Check if HR agent output contains a new blueprint
      if (agentId === 'hr') {
        await this.tryHireFromOutput(content);
      }
    });

    this.agentManager.on('taskComplete', async (agentId: string, taskId: string, resultText?: string) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'review' });

      const task = await this.store.getTask(taskId);
      if (!task) return;

      const cleanTitle = task.title.replace('[Investor Idea] ', '');
      const WORKER_ROLES = new Set(['developer', 'frontend-developer', 'backend-developer', 'designer', 'researcher', 'devops', 'security']);

      // Chain of command for task completion:
      // Worker (dev/designer/etc.) → auto QA review → PM Diana
      // PM Diana → reports to CEO Alice
      // CEO Alice → reports to investor (if noteworthy)

      if (agentId === 'pm') {
        // PM done → CEO gets a simple notification (no Claude call needed)
        this.agentManager.notify('pm', 'leadership',
          `done with "${cleanTitle}". team delivered, everything's in good shape`);
      } else if (agentId === 'ceo') {
        // CEO completed something — no further escalation needed
      } else if (agentId === 'qa') {
        // QA finished review → check if bugs were found
        const notifyChannel = task.projectId ? `project-${task.projectId}` : 'leadership';
        const qaResult = (resultText ?? '').toLowerCase();
        const hasBugs = qaResult.includes('bug') || qaResult.includes('fail') || qaResult.includes('error') ||
          qaResult.includes('broken') || qaResult.includes('crash') || qaResult.includes('not work') ||
          qaResult.includes('critical') || qaResult.includes('needs fix');
        const isPass = qaResult.includes('good to ship') || qaResult.includes('all tests pass') ||
          qaResult.includes('ready to ship') || qaResult.includes('works as expected');

        if (hasBugs && !isPass) {
          // QA found bugs → auto-create fix task, but cap the loop
          try {
            const originalTaskId = task.dependsOn;
            const originalTask = originalTaskId ? await this.store.getTask(originalTaskId) : null;
            const originalDev = originalTask?.assignedTo ?? 'developer';

            // Cap QA→fix cycles at 3 to prevent infinite loops
            const fixCycles = await this.store.countFixCycles(taskId);
            if (fixCycles >= 3) {
              const notifyChannel2 = task.projectId ? `project-${task.projectId}` : 'leadership';
              this.agentManager.notify('qa', notifyChannel2,
                `3 fix cycles on "${cleanTitle.replace('QA Review: ', '')}" — escalating to Diana for manual review`);
              this.agentManager.notify('qa', 'leadership',
                `repeated QA failures on "${cleanTitle.replace('QA Review: ', '')}". needs human or PM intervention`);
              return;
            }

            const fixTaskId = crypto.randomUUID();
            const fixTask = {
              id: fixTaskId,
              title: `Fix bugs: ${cleanTitle.replace('QA Review: ', '')}`,
              description: [
                `QA (Nina) found issues in your previous work. Fix the bugs listed below.`,
                ``,
                `QA Report:`,
                resultText?.slice(0, 1000) ?? 'See QA review for details',
                ``,
                `Fix all reported issues, then verify: build, run, test.`,
              ].join('\n'),
              status: 'assigned' as const,
              projectId: task.projectId,
              assignedTo: originalDev,
              createdBy: 'qa',
              parentTaskId: task.parentTaskId,
              dependsOn: null as string | null,
              priority: Math.min(task.priority + 1, 10), // bump priority for fixes
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            await this.store.createTask(fixTask);
            if (this.agentManager.getBlueprint(originalDev)) {
              this.agentManager.assignTask(originalDev, fixTask).catch(err => {
                console.error(`[QA Fix] Failed to assign fix task: ${err.message}`);
              });
            }

            const devName = this.agentManager.getBlueprint(originalDev)?.name ?? originalDev;
            this.agentManager.emit('message', 'qa', notifyChannel,
              `found bugs, created fix task for ${devName}`);
          } catch (err: any) {
            console.error(`[QA Fix Loop] Error: ${err.message}`);
          }
        } else {
          // QA passed → create architect code review before final merge
          this.agentManager.notify('qa', notifyChannel,
            `QA passed for "${cleanTitle.replace('QA Review: ', '')}". sending to Charlie for code review`);

          try {
            const originalTaskId = task.dependsOn;
            const originalTask = originalTaskId ? await this.store.getTask(originalTaskId) : null;

            const reviewTaskId = crypto.randomUUID();
            const reviewTask = {
              id: reviewTaskId,
              title: `Code Review: ${cleanTitle.replace('QA Review: ', '')}`,
              description: [
                `QA passed. Review the code changes for architecture, patterns, and quality.`,
                ``,
                originalTask ? `Original task: "${originalTask.title}" by ${originalTask.assignedTo}` : '',
                resultText ? `## QA Report\n${resultText.slice(0, 400)}` : '',
                ``,
                `Check:`,
                `1. Code follows established patterns and architecture`,
                `2. No unnecessary complexity or over-engineering`,
                `3. Proper error handling at system boundaries`,
                `4. No security issues (injection, XSS, etc.)`,
                `5. Good naming, clear intent`,
                ``,
                `If approved, mark as done. If changes needed, list them specifically.`,
              ].filter(Boolean).join('\n'),
              status: 'assigned' as const,
              projectId: task.projectId,
              assignedTo: 'architect',
              createdBy: 'system',
              parentTaskId: task.parentTaskId,
              dependsOn: taskId,
              priority: task.priority,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            await this.store.createTask(reviewTask);
            await this.agentManager.assignTask('architect', reviewTask);
          } catch (err: any) {
            console.error(`[Code Review] Failed to create review task: ${err.message}`);
            // Fallback: mark original task as done directly
            try {
              if (task.dependsOn) {
                await this.store.updateTaskStatus(task.dependsOn, 'done');
              }
            } catch { /* non-critical */ }
          }
        }
      } else if (agentId === 'architect' && cleanTitle.startsWith('Code Review: ')) {
        // Architect finished code review → check if approved
        const reviewResult = (resultText ?? '').toLowerCase();
        const approved = reviewResult.includes('approved') || reviewResult.includes('lgtm') ||
          reviewResult.includes('looks good') || reviewResult.includes('good to merge') ||
          reviewResult.includes('no issues');

        const notifyChannel2 = task.projectId ? `project-${task.projectId}` : 'leadership';
        if (approved) {
          this.agentManager.notify('architect', notifyChannel2,
            `code review approved: "${cleanTitle.replace('Code Review: ', '')}". merging`);
          // Walk the dependency chain back to mark the original dev task as done
          try {
            let depId = task.dependsOn; // QA task
            if (depId) {
              const qaTask = await this.store.getTask(depId);
              if (qaTask?.dependsOn) {
                await this.store.updateTaskStatus(qaTask.dependsOn, 'done');
              }
              await this.store.updateTaskStatus(depId, 'done');
            }
          } catch { /* non-critical */ }
        } else {
          // Architect wants changes → send back to original dev
          this.agentManager.notify('architect', notifyChannel2,
            `code review needs changes: "${cleanTitle.replace('Code Review: ', '')}"`);
          try {
            const qaTaskId = task.dependsOn;
            const qaTask = qaTaskId ? await this.store.getTask(qaTaskId) : null;
            const originalTaskId = qaTask?.dependsOn;
            const originalTask = originalTaskId ? await this.store.getTask(originalTaskId) : null;
            if (originalTask?.assignedTo) {
              const fixTaskId = crypto.randomUUID();
              await this.store.createTask({
                id: fixTaskId,
                title: `Code review fixes: ${cleanTitle.replace('Code Review: ', '')}`,
                description: [
                  `Architect review requested changes:`,
                  ``,
                  resultText?.slice(0, 800) ?? 'See review feedback',
                  ``,
                  `Apply the requested changes, then verify build/test.`,
                ].join('\n'),
                status: 'assigned' as const,
                projectId: task.projectId,
                assignedTo: originalTask.assignedTo,
                createdBy: 'architect',
                parentTaskId: task.parentTaskId,
                dependsOn: null,
                priority: Math.min(task.priority + 1, 10),
                createdAt: new Date(),
                updatedAt: new Date(),
              });
              this.agentManager.assignTask(originalTask.assignedTo, await this.store.getTask(fixTaskId) as any).catch(() => {});
            }
          } catch (err: any) {
            console.error(`[Code Review] Failed to create fix task: ${err.message}`);
          }
        }
      } else if (WORKER_ROLES.has(agentId) || WORKER_ROLES.has(agentId.replace(/-\d+$/, ''))) {
        // Worker done → auto-create QA review task
        const notifyChannel = task.projectId ? `project-${task.projectId}` : 'leadership';
        try {
          const qaTaskId = crypto.randomUUID();
          const qaTask = {
            id: qaTaskId,
            title: `QA Review: ${cleanTitle}`,
            description: [
              `Review and verify the work done by ${this.agentManager.getBlueprint(agentId)?.name ?? agentId} on "${cleanTitle}".`,
              ``,
              `Original task description: ${task.description?.slice(0, 500) ?? 'N/A'}`,
              ``,
              // Include the developer's own summary so QA knows what was actually done
              resultText ? `## Developer's Summary\n${resultText.slice(0, 400)}\n` : '',
              `Your job:`,
              `1. Check the code that was written/changed`,
              `2. Try to build/run the project — does it start without errors?`,
              `3. Test the feature — does it actually work?`,
              `4. Check for obvious bugs, missing error handling, security issues`,
              `5. If there are tests, run them`,
              `6. Report your findings clearly: what works, what doesn't, what needs fixing`,
              ``,
              `If you find bugs, be specific: file, line, what's wrong, how to reproduce.`,
              `If everything is good, confirm it's ready to ship.`,
            ].filter(Boolean).join('\n'),
            status: 'assigned' as const,
            projectId: task.projectId,
            assignedTo: 'qa',
            createdBy: 'system',
            parentTaskId: task.parentTaskId,
            dependsOn: taskId,
            priority: task.priority,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
          await this.store.createTask(qaTask);
          await this.agentManager.assignTask('qa', qaTask);

          // Simple notification to PM (no Claude call needed for status updates)
          this.agentManager.notify(agentId, notifyChannel,
            `finished "${cleanTitle}", sent to Nina for QA review`);
        } catch (err: any) {
          console.error(`[Auto QA] Failed to create QA task: ${err.message}`);
          // Fallback: simple notification
          const notifChannel = task.projectId ? `project-${task.projectId}` : 'leadership';
          this.agentManager.notify(agentId, notifChannel,
            `finished "${cleanTitle}", ready for review`);
        }
      } else {
        // Any other agent → simple notification to PM
        const notifyChannel = task.projectId ? `project-${task.projectId}` : 'leadership';
        this.agentManager.notify(agentId, notifyChannel,
          `finished "${cleanTitle}", ready for review`);
      }

      // Unblock dependent tasks now that this one is done.
      // Inject predecessor's result summary so the next agent has context.
      try {
        const unblockedTasks = await this.store.getUnblockedTasks(taskId);
        for (const depTask of unblockedTasks) {
          if (depTask.assignedTo && this.agentManager.getBlueprint(depTask.assignedTo)) {
            // Enrich dependent task with predecessor context
            if (resultText) {
              const predecessorSummary = `\n\n## Predecessor Task Result\n**"${cleanTitle}"** completed by ${this.agentManager.getBlueprint(agentId)?.name ?? agentId}:\n${resultText.slice(0, 400)}`;
              depTask.description = (depTask.description ?? '') + predecessorSummary;
              await this.store.updateTaskDescription(depTask.id, depTask.description);
            }

            const depChannel = depTask.projectId ? `project-${depTask.projectId}` : 'general';
            this.agentManager.notify(depTask.assignedTo, depChannel,
              `dependency "${cleanTitle}" is done, starting on "${depTask.title}"`);
            this.agentManager.assignTask(depTask.assignedTo, depTask).catch(err => {
              console.error(`[Unblock] Failed to assign ${depTask.id}: ${err.message}`);
            });
          }
        }
      } catch (err: any) {
        console.error(`[Unblock] Error checking dependent tasks: ${err.message}`);
      }
    });

    this.agentManager.on('taskFailed', async (agentId: string, taskId: string, error: string) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'blocked', error });

      const task = await this.store.getTask(taskId);
      const blueprint = this.agentManager.getBlueprint(agentId);
      if (task && blueprint) {
        const blockMsg = `blocked on "${task.title.replace('[Investor Idea] ', '')}": ${error.slice(0, 100)}`;
        this.agentManager.emit('message', agentId, 'general', blockMsg);

        // --- Agent Handoff Protocol ---
        // If a worker is blocked, try to find a relevant agent to help
        const errorLower = error.toLowerCase();
        let handoffTo: string | null = null;

        if (errorLower.includes('api') || errorLower.includes('backend') || errorLower.includes('endpoint')) {
          if (agentId !== 'backend-developer') handoffTo = 'backend-developer';
        } else if (errorLower.includes('frontend') || errorLower.includes('ui') || errorLower.includes('component')) {
          if (agentId !== 'frontend-developer') handoffTo = 'frontend-developer';
        } else if (errorLower.includes('design') || errorLower.includes('layout') || errorLower.includes('css')) {
          if (agentId !== 'designer') handoffTo = 'designer';
        } else if (errorLower.includes('deploy') || errorLower.includes('docker') || errorLower.includes('ci')) {
          handoffTo = 'devops';
        } else if (errorLower.includes('security') || errorLower.includes('auth') || errorLower.includes('permission')) {
          handoffTo = 'security';
        } else if (errorLower.includes('architecture') || errorLower.includes('design decision')) {
          handoffTo = 'architect';
        }

        if (handoffTo && this.agentManager.getBlueprint(handoffTo)) {
          const channel = task.projectId ? `project-${task.projectId}` : 'general';
          const handoffName = this.agentManager.getBlueprint(handoffTo)?.name ?? handoffTo;
          this.agentManager.notify(agentId, channel,
            `need help from ${handoffName} — ${error.slice(0, 80)}`);

          // Create a handoff task for the helper agent
          const handoffTaskId = crypto.randomUUID();
          await this.store.createTask({
            id: handoffTaskId,
            title: `Help ${blueprint.name}: ${task.title.slice(0, 80)}`,
            description: [
              `${blueprint.name} (${blueprint.role}) is blocked on "${task.title}" and needs your help.`,
              ``,
              `Error: ${error.slice(0, 500)}`,
              ``,
              `Original task: ${task.description?.slice(0, 300) ?? 'N/A'}`,
              ``,
              `Help resolve the blocker. Focus only on what's needed to unblock them.`,
            ].join('\n'),
            status: 'assigned',
            projectId: task.projectId,
            assignedTo: handoffTo,
            createdBy: agentId,
            parentTaskId: task.id,
            dependsOn: null,
            priority: Math.min(task.priority + 1, 10),
            createdAt: new Date(),
            updatedAt: new Date(),
          });

          this.agentManager.assignTask(handoffTo, await this.store.getTask(handoffTaskId) as any).catch(err => {
            console.error(`[Handoff] Failed to assign help task: ${err.message}`);
          });
        }
      }
    });

    this.agentManager.on('breakStarted', (agentId: string, reason: string, until: Date) => {
      this.wsServer.broadcast('break:start', { agentId, reason, until: until.toISOString() });
    });

    this.agentManager.on('breakEnded', (agentId: string) => {
      this.wsServer.broadcast('break:end', { agentId });
    });

    this.agentManager.on('error', (agentId: string, error: Error) => {
      console.error(`[Agent ${agentId}] Error:`, error.message);
      this.wsServer.broadcast('agent:status', { agentId, status: 'error', error: error.message });
    });

    // Real-time cost broadcasting to dashboard
    this.agentManager.on('usageUpdate', (snapshot: any) => {
      this.wsServer.broadcast('usage:update', snapshot);
    });
  }

  private setupWorkflowEvents(): void {
    this.workflowEngine.on('message', async (agentId: string, channel: string, content: string) => {
      this.wsServer.broadcast('message:new', { agentId, channel, content });

      await this.store.saveMessage({
        id: crypto.randomUUID(),
        fromAgentId: agentId,
        toAgentId: null,
        channel,
        content,
        timestamp: new Date(),
      });

      if (this.slack) {
        const blueprint = this.agentManager.getBlueprint(agentId);
        if (blueprint) {
          const slackChannel = this.mapToSlackChannel(channel);
          await this.slack.sendAgentMessage(slackChannel, blueprint.name, blueprint.role, content, blueprint.avatar);
        }
      }
    });

    this.workflowEngine.on('approval:request', async (data: { taskId: string; title: string; description: string }) => {
      this.wsServer.broadcast('approval:new', data);
      if (this.slack) {
        await this.slack.sendApprovalRequest(data.taskId, data.title, data.description, 'Alice');
      }
    });

    this.workflowEngine.on('error', (agentId: string, error: Error) => {
      console.error(`[Workflow ${agentId}] Error:`, error.message);
    });
  }

  private setupSchedulerEvents(): void {
    this.scheduler.on('statusReport', async (data: any) => {
      const { summary, activeDetails, blockedTasks } = data;

      // Template-based status report — eliminates a Sonnet call every ~15 min
      try {
        const parts: string[] = [];
        const working = activeDetails.map((a: any) => a.name).join(', ');
        if (summary.activeAgents > 0) {
          parts.push(`${working} ${summary.activeAgents === 1 ? 'is' : 'are'} on it`);
        } else {
          parts.push(`team is idle right now`);
        }
        parts.push(`${summary.tasksInProgress} in progress, ${summary.tasksCompleted} done, ${summary.tasksPending} queued`);
        if (summary.tasksBlocked > 0) {
          const blocked = blockedTasks.map((t: any) => t.title).join(', ');
          parts.push(`heads up: ${summary.tasksBlocked} blocked — ${blocked}`);
        }
        const report = parts.join('. ');
        if (this.slack) {
          const ceoBp = this.agentManager.getBlueprint('ceo');
          await this.slack.sendAgentMessage('agency-general', 'Alice', 'CEO', report, ceoBp?.avatar);
        }

        await this.store.saveMessage({
          id: crypto.randomUUID(), fromAgentId: 'ceo', toAgentId: null,
          channel: 'general', content: report, timestamp: new Date(),
        });

        this.wsServer.broadcast('message:new', { agentId: 'ceo', channel: 'general', content: report });
      } catch (err: any) {
        console.error('[Status report error]', err.message);
      }
    });
  }

  private setupSlackBridge(): void {
    if (!this.slack) return;

    // --- CEO-Investor DM channel ---
    this.slack.on('investor:message', async (msg: InvestorMessage) => {
      console.log(`[Slack] Investor → CEO: ${msg.text}`);

      try {
        // Save investor message
        await this.store.saveMessage({
          id: crypto.randomUUID(), fromAgentId: 'investor', toAgentId: 'ceo',
          channel: 'ceo-investor', content: msg.text, timestamp: new Date(),
        });

        // Build conversation history for context (limit to 5 for efficiency)
        const recentMessages = await this.store.getChannelMessages('ceo-investor', 3);
        const history = recentMessages
          .map(m => `${m.fromAgentId === 'investor' ? 'Investor' : 'Alice'}: ${m.content}`)
          .join('\n');

        // Combined call: Alice responds AND classifies intent in one query.
        // Saves a full model call per investor message.
        const combinedContext = [
          history ? `Recent conversation:\n${history}\n` : '',
          `Investor says: "${msg.text}"`,
          ``,
          `Respond naturally as Alice the CEO. If they're giving you a task or project idea, acknowledge it and say you'll hand it to Diana (PM) and the team. If it's casual chat, just be friendly. Keep it short — 1-3 sentences, like a real Slack message.`,
          ``,
          `IMPORTANT: After your response, add a newline then a JSON line classifying the intent:`,
          `{"intent":"<project_idea|simple_task|hire_request|question|chat>","summary":"<1 sentence>"}`,
          `The JSON must be on its own line at the very end.`,
        ].filter(Boolean).join('\n');

        const rawResponse = await this.agentManager.chat('ceo', msg.text, combinedContext, 'ceo-investor');

        // Parse combined response: split chat response from intent JSON
        const jsonMatch = rawResponse.match(/\{[^{}]*"intent"\s*:\s*"[^"]*"[^{}]*\}\s*$/);
        const response = jsonMatch
          ? rawResponse.slice(0, rawResponse.lastIndexOf(jsonMatch[0])).trim()
          : rawResponse.trim();

        let intent: { type: string; summary: string } = { type: 'chat', summary: msg.text.slice(0, 100) };
        if (jsonMatch) {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            if (parsed.intent) intent = { type: parsed.intent, summary: parsed.summary ?? msg.text.slice(0, 100) };
          } catch { /* fallback to default */ }
        }

        const ceoBp = this.agentManager.getBlueprint('ceo');
        await this.slack!.sendAgentMessage('agency-ceo-investor', 'Alice', 'CEO', response, ceoBp?.avatar);

        await this.store.saveMessage({
          id: crypto.randomUUID(), fromAgentId: 'ceo', toAgentId: 'investor',
          channel: 'ceo-investor', content: response, timestamp: new Date(),
        });

        console.log(`[Intent] "${msg.text.slice(0, 50)}..." → ${intent.type}`);

        switch (intent.type) {
          case 'project_idea':
            // Big project → Alice delegates to PM Diana
            await this.delegateTopm(msg.text, intent.summary);
            break;

          case 'simple_task':
            // Simple actionable request → Alice creates a task for PM to handle
            await this.delegateSimpleTask(msg.text, intent.summary);
            break;

          case 'hire_request':
            // HR request → route to Bob
            await this.routeToHr(msg.text, response);
            break;

          case 'question':
          case 'chat':
            // Pure conversation — Alice already responded, nothing more to do
            break;
        }
      } catch (err: any) {
        console.error('[CEO chat error]', err.message);
        const ceoBpFallback = this.agentManager.getBlueprint('ceo');
        await this.slack!.sendAgentMessage('agency-ceo-investor', 'Alice', 'CEO',
          `hey, give me a sec — something glitched on my end`, ceoBpFallback?.avatar);
      }
    });

    // --- Approval responses ---
    this.slack.on('approval:resolve', async (data: { approvalId: string; status: string }) => {
      if (data.approvalId) {
        const status = data.status as 'approved' | 'rejected';
        await this.store.resolveApproval(data.approvalId, status);
        await this.workflowEngine.handleApprovalResponse(data.approvalId, status);
        this.wsServer.broadcast('approval:resolved', { approvalId: data.approvalId, status });
      }
    });

    // --- Other channel messages ---
    this.slack.on('channel:message', async (msg: InvestorMessage) => {
      console.log(`[Slack] ${msg.channelName}: ${msg.text}`);

      await this.store.saveMessage({
        id: crypto.randomUUID(), fromAgentId: 'investor', toAgentId: null,
        channel: msg.channelName, content: msg.text, timestamp: new Date(),
      });

      // Determine who should respond:
      // 1. If someone is explicitly @mentioned, only they respond
      // 2. Check recent conversation context to see if the user is talking to a specific agent
      // 3. Otherwise, pick at most 1 relevant agent (not everyone)
      let respondingAgents: string[] = [];
      if (msg.mentionedAgents && msg.mentionedAgents.length > 0) {
        respondingAgents = msg.mentionedAgents;
      } else {
        // Check recent messages: if the investor was just talking to one agent, continue that conversation
        const recentMsgs = await this.store.getChannelMessages(msg.channelName, 3);
        const recentAgentReplies = recentMsgs
          .filter(m => m.fromAgentId && m.fromAgentId !== 'investor')
          .map(m => m.fromAgentId!);

        if (recentAgentReplies.length > 0) {
          // Continue conversation with the most recent agent
          respondingAgents = [recentAgentReplies[0]];
        } else {
          // No recent context — pick the single most relevant agent
          const relevant = this.pickRelevantAgents(msg.text);
          respondingAgents = relevant.slice(0, 1); // max 1 agent
        }
      }

      // Build chat history (limit to 3 messages for token efficiency)
      const slackChannel = msg.channelName;
      const recentMessages = await this.store.getChannelMessages(slackChannel, 3);
      const history = recentMessages
        .map(m => {
          const sender = m.fromAgentId === 'investor' ? 'Investor' : (this.agentManager.getBlueprint(m.fromAgentId ?? '')?.name ?? m.fromAgentId);
          return `${sender}: ${m.content}`;
        })
        .join('\n');

      // Responding agent(s) chat
      const chatPromises = respondingAgents.map(async (agentId) => {
        const blueprint = this.agentManager.getBlueprint(agentId);
        if (!blueprint) return;

        try {
          const context = [
            `You are ${blueprint.name} (${blueprint.role}) in the #${slackChannel} Slack channel.`,
            ``,
            `Recent messages:`,
            history,
            ``,
            `Investor says: "${msg.text}"`,
            ``,
            `Respond naturally as ${blueprint.name}. Keep it short — 1-2 sentences, like a real Slack message.`,
            `If this message isn't relevant to your role, say nothing useful — just a brief acknowledgment if directly addressed.`,
            `Only respond with your message, nothing else. No markdown, no bold, plain text only.`,
          ].join('\n');

          const chatResponse = await this.agentManager.chat(agentId, msg.text, context, slackChannel);
          await this.slack!.sendAgentMessage(slackChannel, blueprint.name, blueprint.role, chatResponse, blueprint.avatar);

          await this.store.saveMessage({
            id: crypto.randomUUID(), fromAgentId: agentId, toAgentId: 'investor',
            channel: slackChannel, content: chatResponse, timestamp: new Date(),
          });

          if (agentId === 'hr') {
            await this.tryHireFromOutput(chatResponse);
          }
        } catch (err: any) {
          console.error(`[${blueprint.name} chat error]`, err.message);
        }
      });

      await Promise.allSettled(chatPromises);

      // Only classify intent for messages in CEO-related or general channels
      // Don't create tasks from casual conversations with specific agents
      if (respondingAgents.length <= 1 && respondingAgents[0] !== 'ceo') {
        // Likely a conversation with a specific agent — don't auto-delegate
        return;
      }

      // Classify intent — if actionable, delegate through proper chain
      const intent = await this.classifyIntent(msg.text);
      if (intent.type === 'project_idea') {
        await this.delegateTopm(msg.text, intent.summary);
      } else if (intent.type === 'simple_task') {
        await this.delegateSimpleTask(msg.text, intent.summary);
      } else if (intent.type === 'hire_request') {
        await this.routeToHr(msg.text, '');
      }
    });
  }

  // --- Intent Classification (replaces keyword matching) ---

  /**
   * Use a quick Claude call to classify investor intent.
   * Costs ~100 tokens per call but eliminates all misrouting.
   */
  private async classifyIntent(text: string): Promise<{
    type: 'project_idea' | 'simple_task' | 'hire_request' | 'question' | 'chat';
    summary: string;
  }> {
    const lower = text.toLowerCase().trim();

    // Zero-cost heuristic for obvious cases — no model call needed
    const CHAT_PATTERNS = /^(hey|hi|hello|thanks|thank you|good morning|good evening|gm|ok|okay|cool|nice|great|lol|haha|sure|np|bye|cheers|yo)\b/i;
    if (lower.length < 20 && CHAT_PATTERNS.test(lower)) {
      return { type: 'chat', summary: text };
    }

    const QUESTION_PATTERNS = /^(how|what|when|where|why|who|is |are |can |could |do |does |did |will |would |should |status|update)\b/i;
    if (QUESTION_PATTERNS.test(lower) && lower.endsWith('?')) {
      return { type: 'question', summary: text.slice(0, 100) };
    }

    const HIRE_PATTERNS = /\b(hire|recruit|need a |add a |find a |new role|new position|team member)\b/i;
    if (HIRE_PATTERNS.test(lower)) {
      return { type: 'hire_request', summary: text.slice(0, 100) };
    }

    // Only call Claude for genuinely ambiguous messages
    try {
      const prompt = [
        `Classify this investor message. Respond with ONLY JSON, nothing else.`,
        `Message: "${text}"`,
        `Categories: "project_idea" (new app/product/initiative), "simple_task" (quick fix/change), "question", "chat"`,
        `{"type":"<category>","summary":"<1 sentence>"}`,
      ].join('\n');

      const result = await quickQuery(prompt, UTILITY_MODEL);

      const match = result.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed.type && parsed.summary) return parsed;
      }
    } catch {
      // Fallback to heuristic
    }

    if (text.length < 30) return { type: 'chat', summary: text };
    return { type: 'simple_task', summary: text.slice(0, 100) };
  }

  // --- Delegation Chain ---

  /**
   * CEO delegates a project idea to Diana (PM).
   * Diana will evaluate complexity, involve architect if needed,
   * and create subtasks assigned to the right agents.
   */
  private async delegateTopm(investorMessage: string, summary: string): Promise<void> {
    // One-way announcement — no model call needed (Diana gets the full context in her task)
    this.agentManager.notify('ceo', 'leadership',
      `new project from the investor: "${summary}". passing to diana`);

    const agents = this.agentManager.getAllBlueprints();
    const agentList = agents.filter(a => !['ceo', 'hr'].includes(a.id))
      .map(a => `- ${a.id}: ${a.name} (${a.role})`).join('\n');

    // API instructions are already in PM's system prompt (cached).
    // Only include task-specific context here to minimize input tokens.
    const task = {
      id: crypto.randomUUID(),
      title: `Plan & execute: ${summary.slice(0, 100)}`,
      description: [
        `The investor wants: "${investorMessage}"`,
        ``,
        `Your job:`,
        `1. Evaluate complexity`,
        `2. Complex project → create project via API, consult Charlie (architect) first`,
        `3. Straightforward → break into tasks and assign directly`,
        `4. If repos are needed, create them via API`,
        ``,
        `## Available Team`,
        agentList,
        ``,
        `## Rules`,
        `- Each task → exactly ONE agent. Frontend → Maya, Backend → Eve/Alex, Design → Frank.`,
        `- Design + frontend: create design task first, chain frontend with "dependsOn".`,
        `- QA is automatic — don't create QA tasks manually.`,
        `- Task descriptions must be specific: WHAT, HOW, WHERE, ACCEPTANCE CRITERIA.`,
        `- Use the Agency API (in your system prompt) to create projects, repos, and tasks.`,
        ``,
        `Take action now.`,
      ].join('\n'),
      status: 'assigned' as const,
      projectId: null,
      assignedTo: 'pm',
      createdBy: 'ceo',
      parentTaskId: null,
      dependsOn: null,
      priority: 8,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);
    await this.agentManager.assignTask('pm', task);

    // Track investor request
    await this.store.saveInvestorRequest({
      id: crypto.randomUUID(),
      investorMessage,
      intent: 'project_idea',
      summary,
      rootTaskId: task.id,
    });
  }

  /**
   * Simple task — PM gets it and decides who does it.
   * For very simple things PM might just assign to one developer directly.
   */
  private async delegateSimpleTask(investorMessage: string, summary: string): Promise<void> {
    const agents = this.agentManager.getAllBlueprints();
    const agentList = agents.filter(a => !['ceo', 'hr'].includes(a.id))
      .map(a => `- ${a.id}: ${a.name} (${a.role})`).join('\n');

    // API instructions are already in PM's system prompt (cached).
    const task = {
      id: crypto.randomUUID(),
      title: summary.slice(0, 120),
      description: [
        `Investor request: "${investorMessage}"`,
        ``,
        `Simple/direct request. Figure out who should do it and assign via the Agency API.`,
        `Frontend → Maya, Backend → Eve/Alex, Design → Frank. QA is automatic.`,
        ``,
        `Team: ${agentList}`,
      ].join('\n'),
      status: 'assigned' as const,
      projectId: null,
      assignedTo: 'pm',
      createdBy: 'ceo',
      parentTaskId: null,
      dependsOn: null,
      priority: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);
    await this.agentManager.assignTask('pm', task);

    // Track investor request
    await this.store.saveInvestorRequest({
      id: crypto.randomUUID(),
      investorMessage,
      intent: 'simple_task',
      summary,
      rootTaskId: task.id,
    });
  }

  /**
   * Route HR requests to Bob.
   */
  private async routeToHr(investorMessage: string, ceoResponse: string): Promise<void> {
    try {
      const hrResponse = await this.agentManager.chat('hr', investorMessage,
        `You are Bob (HR Manager). The investor asked: "${investorMessage}"\n\nAlice (CEO) responded: "${ceoResponse}"\n\nIf this is a hiring request, create the blueprint JSON immediately. Include all required fields: id, role, name, gender, systemPrompt. Respond with your message and the JSON blueprint if applicable.`,
        'leadership'
      );
      if (this.slack) {
        const hrBp = this.agentManager.getBlueprint('hr');
        await this.slack.sendAgentMessage('agency-ceo-investor', 'Bob', 'HR Manager', hrResponse, hrBp?.avatar);
      }
      await this.store.saveMessage({
        id: crypto.randomUUID(), fromAgentId: 'hr', toAgentId: 'investor',
        channel: 'ceo-investor', content: hrResponse, timestamp: new Date(),
      });
      await this.tryHireFromOutput(hrResponse);
    } catch (err: any) {
      console.error('[HR routing error]', err.message);
    }
  }

  /**
   * Pick which agents respond to a channel message (for chat only).
   * Still uses keyword matching for chat routing — this is fine since
   * actual task delegation goes through classifyIntent → PM.
   */
  private pickRelevantAgents(text: string): string[] {
    const lower = text.toLowerCase();

    const everyonePatterns = [
      'everyone', 'everybody', 'all of you', 'team', 'guys', 'folks',
      'whoever', 'anyone', 'wer ist', 'alle', 'jeder', 'bitte alle',
      'introduce', 'vorstell', 'wer noch', 'online', 'verfügbar', 'available',
      'hello guys', 'hey guys', 'hey team', 'hey everyone', 'hey all',
      'hallo zusammen', 'hallo leute', 'hi zusammen', 'moin',
    ];
    if (everyonePatterns.some(p => lower.includes(p))) {
      return this.agentManager.getAllBlueprints().map(b => b.id);
    }

    const topicMap: Record<string, string[]> = {
      'architect|architecture|system design|tech stack|database|infrastructure|architektur': ['architect'],
      'design|ui|ux|layout|component|css|style|figma|gestaltung': ['designer'],
      'code|bug|fix|implement|function|api|backend|frontend|programmier|entwickl': ['developer'],
      'research|compare|analyze|benchmark|evaluate|docs|documentation|forschung|recherche': ['researcher'],
      'sprint|task|deadline|progress|assign|priority|timeline|aufgabe|planung': ['pm'],
      'hire|new role|new agent|team|onboard|einstell|rekrutier': ['hr'],
      'plan|strategy|budget|kpi|status|report|strategie|bericht': ['ceo'],
      'security|vulnerability|penetration|owasp|xss|injection|auth|sicherheit|pentest|cve|exploit': ['security'],
      'deploy|docker|ci|cd|pipeline|server|infra|devops|kubernetes|nginx|monitoring': ['devops'],
      'test|qa|quality|regression|coverage|e2e|integration test|testen|qualität': ['qa'],
    };

    const matched: string[] = [];
    for (const [keywords, agents] of Object.entries(topicMap)) {
      if (keywords.split('|').some(k => lower.includes(k))) {
        matched.push(...agents);
      }
    }

    const unique = [...new Set(matched)];
    return unique.length > 0 ? unique : ['ceo'];
  }

  /**
   * Try to parse and hire a new agent from HR output (works from both task and chat flows).
   */
  private async tryHireFromOutput(output: string): Promise<void> {
    const blueprint = HRManager.parseBlueprint(output);
    if (!blueprint) return;

    try {
      const hired = await this.hrManager.hire(blueprint);
      console.log(`[HR] Hired new agent: ${hired.name} (${hired.role})`);

      // Announce in Slack
      if (this.slack) {
        const hrBp2 = this.agentManager.getBlueprint('hr');
        await this.slack.sendAgentMessage('agency-hr-hiring', 'Bob', 'HR Manager',
          `hired ${hired.name} as ${hired.role}. they're ready to go`, hrBp2?.avatar);

        // Create Slack channels from the blueprint
        for (const ch of hired.slackChannels) {
          const channelName = ch.startsWith('#') ? ch.slice(1) : ch;
          // Skip wildcard patterns like project-*
          if (channelName.includes('*')) continue;
          const slackName = channelName.startsWith('agency-') ? channelName : `agency-${channelName}`;
          try {
            await this.slack.getChannelManager().ensureChannel(slackName, `${hired.role} channel`);
            console.log(`[HR] Created/verified Slack channel: ${slackName}`);
          } catch (err: any) {
            console.warn(`[HR] Failed to create channel ${slackName}: ${err.message}`);
          }
        }

        // Re-register agent names for mention detection
        this.slack.setAgentNames(
          this.agentManager.getAllBlueprints().map(b => ({ id: b.id, name: b.name }))
        );
      }

      // Broadcast to dashboard
      this.wsServer.broadcast('agent:new', {
        id: hired.id,
        name: hired.name,
        role: hired.role,
        avatar: hired.avatar,
        status: 'idle',
      });
    } catch (err: any) {
      console.error(`[HR] Hire failed: ${err.message}`);
      if (this.slack) {
        const hrBp3 = this.agentManager.getBlueprint('hr');
        await this.slack.sendAgentMessage('agency-hr-hiring', 'Bob', 'HR Manager',
          `couldn't hire: ${err.message}`, hrBp3?.avatar);
      }
    }
  }

  private mapToSlackChannel(internalChannel: string): string {
    if (internalChannel === 'general') return 'agency-general';
    if (internalChannel === 'leadership') return 'agency-leadership';
    if (internalChannel === 'approvals') return 'agency-approvals';
    if (internalChannel === 'hr-hiring') return 'agency-hr-hiring';
    if (internalChannel === 'ceo-investor') return 'agency-ceo-investor';
    if (internalChannel.startsWith('project-')) return `agency-${internalChannel}`;
    return `agency-${internalChannel}`;
  }

  private async loadSettings(): Promise<void> {
    try {
      const lang = await this.store.getSetting('language');
      if (lang) this.agentManager.setLanguage(lang);

      const concurrency = await this.store.getSetting('maxConcurrency');
      if (concurrency) {
        const val = parseInt(concurrency, 10);
        if (val > 0) agencyConfig.maxConcurrency = val;
      }
    } catch { /* settings table may not exist yet on first run */ }
  }

  /**
   * Seed default task templates — reusable patterns for common workflows.
   */
  private async seedTaskTemplates(): Promise<void> {
    const templates = [
      {
        id: 'new-feature',
        name: 'New Feature',
        description: 'Full feature workflow: design → frontend → backend → QA',
        steps: [
          { title: 'Design: {name}', description: 'Create UI/UX design for {name}. Include wireframes, component structure, and visual specs.', assignTo: 'designer' },
          { title: 'Frontend: {name}', description: 'Implement the frontend for {name} based on the design. Build components, pages, and client-side logic.', assignTo: 'frontend-developer', dependsOnStep: 0 },
          { title: 'Backend: {name}', description: 'Implement backend API and logic for {name}. Create endpoints, database models, and business logic.', assignTo: 'backend-developer' },
        ],
        createdBy: 'system',
      },
      {
        id: 'bug-fix',
        name: 'Bug Fix',
        description: 'Fix → QA verification workflow',
        steps: [
          { title: 'Fix: {name}', description: 'Investigate and fix the bug: {name}. Write a test to prevent regression.', assignTo: 'developer' },
        ],
        createdBy: 'system',
      },
      {
        id: 'security-audit',
        name: 'Security Audit',
        description: 'Security review → fix → re-audit workflow',
        steps: [
          { title: 'Security Audit: {name}', description: 'Perform a security audit on {name}. Check for OWASP top 10, auth issues, injection, XSS.', assignTo: 'security' },
          { title: 'Fix Security Issues: {name}', description: 'Fix security issues found in the audit for {name}.', assignTo: 'developer', dependsOnStep: 0 },
        ],
        createdBy: 'system',
      },
      {
        id: 'full-stack-feature',
        name: 'Full-Stack Feature with Architecture Review',
        description: 'Architecture → design → frontend + backend (parallel) → integration',
        steps: [
          { title: 'Architecture: {name}', description: 'Design the architecture for {name}. Define data models, API contracts, component structure.', assignTo: 'architect' },
          { title: 'Design: {name}', description: 'Create UI/UX design based on architecture. Follow the defined component structure.', assignTo: 'designer', dependsOnStep: 0 },
          { title: 'Frontend: {name}', description: 'Implement frontend based on design and architecture specs.', assignTo: 'frontend-developer', dependsOnStep: 1 },
          { title: 'Backend: {name}', description: 'Implement backend API following the architecture spec. Create endpoints and data layer.', assignTo: 'backend-developer', dependsOnStep: 0 },
        ],
        createdBy: 'system',
      },
    ];

    for (const t of templates) {
      try {
        await this.store.saveTaskTemplate(t);
      } catch { /* may already exist */ }
    }
    console.log(`  Seeded ${templates.length} task templates`);
  }

  async submitIdea(title: string, description: string) {
    return this.taskRouter.submitIdea(title, description);
  }

  getStore(): StateStore { return this.store; }
  getAgentManager(): AgentManager { return this.agentManager; }
  getTaskBoard(): TaskBoard { return this.taskBoard; }
  getHRManager(): HRManager { return this.hrManager; }
  getWorkflowEngine(): WorkflowEngine { return this.workflowEngine; }
  getMemoryManager(): MemoryManager { return this.memoryManager; }
  getSlack(): SlackBridge | null { return this.slack; }

  async shutdown(): Promise<void> {
    console.log('Shutting down...');
    this.scheduler.stop();
    this.apiServer.close();
    this.wsServer.close();
    if (this.slack) await this.slack.stop();
    await this.store.close();
    console.log('Claude Agency stopped.');
  }
}

// Start the agency when run directly
const agency = new Agency();

process.on('SIGINT', async () => {
  await agency.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await agency.shutdown();
  process.exit(0);
});

agency.start().catch(err => {
  console.error('Failed to start agency:', err);
  process.exit(1);
});

export { agency };

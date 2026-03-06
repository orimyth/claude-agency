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
import { APIServer } from './api-server.js';
import { SlackBridge, type InvestorMessage } from 'slack-bridge';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
  private apiServer: APIServer;
  private slack: SlackBridge | null = null;

  constructor() {
    this.store = new StateStore(agencyConfig.mysql);
    this.permissions = new PermissionEngine(defaultBlacklist);
    this.agentManager = new AgentManager(this.store, this.permissions, agencyConfig);
    this.memoryManager = new MemoryManager(resolve(__dirname, '../../..'));
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

    // Register all default blueprints
    for (const blueprint of defaultBlueprints) {
      this.agentManager.registerBlueprint(blueprint);
      await this.agentManager.initializeAgent(blueprint);
      console.log(`  Agent registered: ${blueprint.name} (${blueprint.role})`);
    }

    // Initialize HR manager (loads custom blueprints from disk)
    this.hrManager = new HRManager(this.agentManager, this.store);
    const customAgents = this.hrManager.getCustomBlueprints();
    if (customAgents.length > 0) {
      console.log(`  Loaded ${customAgents.length} custom agent(s) from HR`);
    }

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

    // Wire up agent events
    this.setupAgentEvents();

    // Start the scheduler and wire up status reports
    this.scheduler.start();
    this.setupSchedulerEvents();
    console.log('Scheduler started');

    // Start API server
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

      // Forward to Slack
      if (this.slack) {
        const blueprint = this.agentManager.getBlueprint(agentId);
        if (blueprint) {
          const slackChannel = this.mapToSlackChannel(channel);
          await this.slack.sendAgentMessage(slackChannel, blueprint.name, blueprint.role, content);
        }
      }

      // Check if HR agent output contains a new blueprint
      if (agentId === 'hr') {
        await this.workflowEngine.processHROutput(content);
      }
    });

    this.agentManager.on('taskComplete', async (agentId: string, taskId: string) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'review' });

      const task = await this.store.getTask(taskId);
      if (!task) return;

      // If CEO completed an evaluation, run the workflow
      if (agentId === 'ceo' && task.title.startsWith('[Investor Idea]')) {
        await this.workflowEngine.evaluateIdea(task);
        return;
      }

      // Auto-handoff: developer done → PM reviews
      if (agentId === 'developer' || agentId === 'designer') {
        try {
          await this.agentManager.agentToAgentChat(
            agentId, 'pm',
            `finished "${task.title.replace('[Investor Idea] ', '')}", ready for review`,
            'leadership'
          );
        } catch { /* non-critical */ }
      }

      // Auto-handoff: PM done → CEO gets status
      if (agentId === 'pm') {
        try {
          await this.agentManager.agentToAgentChat(
            agentId, 'ceo',
            `sprint update: "${task.title.replace('[Investor Idea] ', '')}" is done`,
            'leadership'
          );
        } catch { /* non-critical */ }
      }
    });

    this.agentManager.on('taskFailed', async (agentId: string, taskId: string, error: string) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'blocked', error });

      // Notify PM and CEO when a task is blocked
      const task = await this.store.getTask(taskId);
      const blueprint = this.agentManager.getBlueprint(agentId);
      if (task && blueprint) {
        const blockMsg = `blocked on "${task.title.replace('[Investor Idea] ', '')}": ${error.slice(0, 100)}`;
        this.agentManager.emit('message', agentId, 'general', blockMsg);
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
          await this.slack.sendAgentMessage(slackChannel, blueprint.name, blueprint.role, content);
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

      // Have the CEO generate a natural status report
      try {
        const context = [
          `You are Alice, the CEO. Generate a brief team status update for the #agency-general Slack channel.`,
          ``,
          `Current status:`,
          `- ${summary.activeAgents} agents working, ${summary.idleAgents} idle, ${summary.onBreakAgents} on break`,
          `- ${summary.tasksInProgress} tasks in progress, ${summary.tasksCompleted} completed, ${summary.tasksPending} pending`,
          summary.tasksBlocked > 0 ? `- ${summary.tasksBlocked} BLOCKED tasks that need attention` : '',
          activeDetails.length > 0 ? `- Currently working: ${activeDetails.map((a: any) => a.name).join(', ')}` : '- Nobody working right now',
          blockedTasks.length > 0 ? `- Blocked: ${blockedTasks.map((t: any) => t.title).join(', ')}` : '',
          ``,
          `Write a casual 2-4 sentence Slack update. Be like a real CEO checking in. If everything is quiet, keep it very short. If there are blocked tasks, flag them. Only output the message itself, nothing else.`,
        ].filter(Boolean).join('\n');

        const report = await this.agentManager.chat('ceo', '', context);
        if (this.slack) {
          await this.slack.sendAgentMessage('agency-general', 'Alice', 'CEO', report);
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

    this.slack.on('investor:message', async (msg: InvestorMessage) => {
      console.log(`[Slack] Investor: ${msg.text}`);

      // Have the CEO respond conversationally first
      try {
        const recentMessages = await this.store.getChannelMessages('ceo-investor', 10);
        const history = recentMessages
          .map(m => `${m.fromAgentId === 'investor' ? 'Investor' : 'Alice'}: ${m.content}`)
          .join('\n');

        const context = history
          ? `Recent conversation:\n${history}\n\nInvestor says: "${msg.text}"\n\nRespond naturally as Alice the CEO. If they're giving you a task or project idea, acknowledge it and say you'll get the team on it. If it's casual chat, just be friendly. Keep it short — 1-3 sentences, like a real Slack message. Only respond with your message, nothing else.`
          : undefined;

        const response = await this.agentManager.chat('ceo', msg.text, context);
        await this.slack!.sendAgentMessage('agency-ceo-investor', 'Alice', 'CEO', response);

        // Save both messages to history
        await this.store.saveMessage({
          id: crypto.randomUUID(), fromAgentId: 'investor', toAgentId: 'ceo',
          channel: 'ceo-investor', content: msg.text, timestamp: new Date(),
        });
        await this.store.saveMessage({
          id: crypto.randomUUID(), fromAgentId: 'ceo', toAgentId: 'investor',
          channel: 'ceo-investor', content: response, timestamp: new Date(),
        });

        // Check if the message is an actionable task/idea (not just casual chat)
        const isTask = this.looksLikeTask(msg.text);
        if (isTask) {
          await this.taskRouter.submitIdea(msg.text.slice(0, 100), msg.text);
        }
      } catch (err: any) {
        console.error('[CEO chat error]', err.message);
        await this.slack!.sendAgentMessage('agency-ceo-investor', 'Alice', 'CEO', `hey, give me a sec — something glitched on my end`);
      }
    });

    this.slack.on('approval:resolve', async (data: { approvalId: string; status: string }) => {
      if (data.approvalId) {
        const status = data.status as 'approved' | 'rejected';
        await this.store.resolveApproval(data.approvalId, status);
        await this.workflowEngine.handleApprovalResponse(data.approvalId, status);
        this.wsServer.broadcast('approval:resolved', { approvalId: data.approvalId, status });
      }
    });

    this.slack.on('channel:message', async (msg: InvestorMessage) => {
      console.log(`[Slack] ${msg.channelName}: ${msg.text}`);

      // Save investor message
      await this.store.saveMessage({
        id: crypto.randomUUID(),
        fromAgentId: 'investor',
        toAgentId: null,
        channel: msg.channelName,
        content: msg.text,
        timestamp: new Date(),
      });

      // Determine which agents should respond
      let respondingAgents: string[] = [];

      if (msg.mentionedAgents && msg.mentionedAgents.length > 0) {
        // Specific agents were mentioned — only they respond
        respondingAgents = msg.mentionedAgents;
      } else {
        // No specific mention — pick the most relevant agent based on keywords
        respondingAgents = this.pickRelevantAgents(msg.text);
      }

      // Have each agent respond (in parallel for speed)
      const slackChannel = msg.channelName;
      const recentMessages = await this.store.getChannelMessages(slackChannel, 10);
      const history = recentMessages
        .map(m => {
          const sender = m.fromAgentId === 'investor' ? 'Investor' : (this.agentManager.getBlueprint(m.fromAgentId ?? '')?.name ?? m.fromAgentId);
          return `${sender}: ${m.content}`;
        })
        .join('\n');

      const chatPromises = respondingAgents.map(async (agentId) => {
        const blueprint = this.agentManager.getBlueprint(agentId);
        if (!blueprint) return;

        try {
          const context = `You are ${blueprint.name} (${blueprint.role}) in the #${slackChannel} Slack channel.\n\nRecent messages:\n${history}\n\nInvestor says: "${msg.text}"\n\nRespond naturally as ${blueprint.name}. Keep it short — 1-2 sentences, like a real Slack message. Only respond with your message, nothing else.`;

          const response = await this.agentManager.chat(agentId, msg.text, context);
          await this.slack!.sendAgentMessage(slackChannel, blueprint.name, blueprint.role, response);

          await this.store.saveMessage({
            id: crypto.randomUUID(), fromAgentId: agentId, toAgentId: 'investor',
            channel: slackChannel, content: response, timestamp: new Date(),
          });
        } catch (err: any) {
          console.error(`[${blueprint.name} chat error]`, err.message);
        }
      });

      await Promise.allSettled(chatPromises);
    });
  }

  private pickRelevantAgents(text: string): string[] {
    const lower = text.toLowerCase();

    // Detect "everyone" / "all" / group address patterns (EN + DE)
    const everyonePatterns = [
      'everyone', 'everybody', 'all of you', 'team', 'guys', 'folks',
      'whoever', 'anyone', 'wer ist', 'alle', 'jeder', 'bitte alle',
      'introduce', 'vorstell', 'wer noch', 'online', 'verfügbar', 'available',
      'hello guys', 'hey guys', 'hey team', 'hey everyone', 'hey all',
      'hallo zusammen', 'hallo leute', 'hi zusammen', 'moin',
    ];
    const isEveryone = everyonePatterns.some(p => lower.includes(p));

    if (isEveryone) {
      // All agents respond
      return this.agentManager.getAllBlueprints().map(b => b.id);
    }

    // Keyword → agent mapping for topic-based routing
    const topicMap: Record<string, string[]> = {
      'architect|architecture|system design|tech stack|database|infrastructure|architektur': ['architect'],
      'design|ui|ux|layout|component|css|style|figma|gestaltung': ['designer'],
      'code|bug|fix|implement|function|api|backend|frontend|test|programmier|entwickl': ['developer'],
      'research|compare|analyze|benchmark|evaluate|docs|documentation|forschung|recherche': ['researcher'],
      'sprint|task|deadline|progress|assign|priority|timeline|aufgabe|planung': ['pm'],
      'hire|new role|new agent|team|onboard|einstell|rekrutier': ['hr'],
      'plan|strategy|budget|kpi|status|report|strategie|bericht': ['ceo'],
    };

    const matched: string[] = [];
    for (const [keywords, agents] of Object.entries(topicMap)) {
      if (keywords.split('|').some(k => lower.includes(k))) {
        matched.push(...agents);
      }
    }

    const unique = [...new Set(matched)];

    // If no specific topic matched, default to CEO
    return unique.length > 0 ? unique : ['ceo'];
  }

  private looksLikeTask(text: string): boolean {
    const lower = text.toLowerCase();
    const taskIndicators = [
      'build', 'create', 'make', 'implement', 'add', 'fix', 'deploy',
      'set up', 'setup', 'design', 'develop', 'write', 'refactor',
      'update', 'change', 'remove', 'delete', 'migrate', 'integrate',
      'i want', 'i need', 'can you', 'could you', 'please',
      'we need', 'we should', 'let\'s',
    ];
    // Must be more than just a greeting and contain an action word
    return text.length > 20 && taskIndicators.some(ind => lower.includes(ind));
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

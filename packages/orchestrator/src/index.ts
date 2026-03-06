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
import { query, type SDKResultMessage } from '@anthropic-ai/claude-code';
import { SlackBridge, type InvestorMessage } from 'slack-bridge';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

// PATH fix for SDK calls in this module
const _nodeDir = dirname(process.execPath);
const _classifyEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) _classifyEnv[k] = v;
}
if (!_classifyEnv.PATH?.includes(_nodeDir)) {
  _classifyEnv.PATH = `${_nodeDir}:${_classifyEnv.PATH || ''}`;
}

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
  private toolHandler: AgentToolHandler;
  private apiServer: APIServer;
  private slack: SlackBridge | null = null;

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

      // Forward to Slack
      if (this.slack) {
        const blueprint = this.agentManager.getBlueprint(agentId);
        if (blueprint) {
          const slackChannel = this.mapToSlackChannel(channel);
          await this.slack.sendAgentMessage(slackChannel, blueprint.name, blueprint.role, content, blueprint.avatar);
        }
      }

      // Check if HR agent output contains a new blueprint
      if (agentId === 'hr') {
        await this.tryHireFromOutput(content);
      }
    });

    this.agentManager.on('taskComplete', async (agentId: string, taskId: string) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'review' });

      const task = await this.store.getTask(taskId);
      if (!task) return;

      const cleanTitle = task.title.replace('[Investor Idea] ', '');

      // Chain of command for task completion:
      // Worker (dev/designer/etc.) → reports to PM Diana
      // PM Diana → reports to CEO Alice
      // CEO Alice → reports to investor (if noteworthy)

      if (agentId === 'pm') {
        // PM done → CEO gets status update
        try {
          await this.agentManager.agentToAgentChat(
            agentId, 'ceo',
            `done with "${cleanTitle}". team delivered, everything's in good shape`,
            'leadership'
          );
        } catch { /* non-critical */ }
      } else if (agentId === 'ceo') {
        // CEO completed something — no further escalation needed
      } else {
        // Any worker done → PM gets notified
        try {
          await this.agentManager.agentToAgentChat(
            agentId, 'pm',
            `finished "${cleanTitle}", ready for review`,
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

        // Build conversation history for context
        const recentMessages = await this.store.getChannelMessages('ceo-investor', 10);
        const history = recentMessages
          .map(m => `${m.fromAgentId === 'investor' ? 'Investor' : 'Alice'}: ${m.content}`)
          .join('\n');

        // Alice always responds conversationally first
        const chatContext = history
          ? `Recent conversation:\n${history}\n\nInvestor says: "${msg.text}"\n\nRespond naturally as Alice the CEO. If they're giving you a task or project idea, acknowledge it and say you'll hand it to Diana (PM) and the team. If it's casual chat, just be friendly. Keep it short — 1-3 sentences, like a real Slack message. Only respond with your message, nothing else.`
          : undefined;

        const response = await this.agentManager.chat('ceo', msg.text, chatContext);
        const ceoBp = this.agentManager.getBlueprint('ceo');
        await this.slack!.sendAgentMessage('agency-ceo-investor', 'Alice', 'CEO', response, ceoBp?.avatar);

        await this.store.saveMessage({
          id: crypto.randomUUID(), fromAgentId: 'ceo', toAgentId: 'investor',
          channel: 'ceo-investor', content: response, timestamp: new Date(),
        });

        // Classify intent using Claude (replaces keyword matching)
        const intent = await this.classifyIntent(msg.text);
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

      // Determine who should respond
      let respondingAgents: string[] = [];
      if (msg.mentionedAgents && msg.mentionedAgents.length > 0) {
        respondingAgents = msg.mentionedAgents;
      } else {
        respondingAgents = this.pickRelevantAgents(msg.text);
      }

      // Build chat history
      const slackChannel = msg.channelName;
      const recentMessages = await this.store.getChannelMessages(slackChannel, 10);
      const history = recentMessages
        .map(m => {
          const sender = m.fromAgentId === 'investor' ? 'Investor' : (this.agentManager.getBlueprint(m.fromAgentId ?? '')?.name ?? m.fromAgentId);
          return `${sender}: ${m.content}`;
        })
        .join('\n');

      // All responding agents chat (in parallel)
      const chatPromises = respondingAgents.map(async (agentId) => {
        const blueprint = this.agentManager.getBlueprint(agentId);
        if (!blueprint) return;

        try {
          const context = `You are ${blueprint.name} (${blueprint.role}) in the #${slackChannel} Slack channel.\n\nRecent messages:\n${history}\n\nInvestor says: "${msg.text}"\n\nRespond naturally as ${blueprint.name}. Keep it short — 1-2 sentences, like a real Slack message. Only respond with your message, nothing else.`;

          const chatResponse = await this.agentManager.chat(agentId, msg.text, context);
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
    try {
      const prompt = [
        `Classify this message from a company investor/owner. Respond with ONLY a JSON object, nothing else.`,
        ``,
        `Message: "${text}"`,
        ``,
        `Categories:`,
        `- "project_idea": A new product, app, feature, or initiative that needs planning (e.g. "let's build a recipe app", "I want a new SaaS product")`,
        `- "simple_task": A concrete, actionable request that can be done quickly (e.g. "fix the login bug", "add a dark mode toggle", "update the README")`,
        `- "hire_request": Wants to hire/add a new team member or role (e.g. "we need a security expert", "hire a data scientist")`,
        `- "question": Asking for information, status, or opinions (e.g. "how's the project going?", "what tech stack should we use?")`,
        `- "chat": Casual conversation, greetings, or non-actionable messages (e.g. "hey", "good morning", "thanks")`,
        ``,
        `{"type":"<category>","summary":"<1 sentence summary of what they want>"}`,
      ].join('\n');

      const stream = query({
        prompt,
        options: {
          allowedTools: [],
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          env: _classifyEnv,
        },
      });

      let result = '';
      for await (const msg of stream) {
        if (msg.type === 'result') {
          const r = msg as SDKResultMessage;
          if (r.subtype === 'success') result = r.result;
        }
      }

      const match = result.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        if (parsed.type && parsed.summary) return parsed;
      }
    } catch {
      // Fallback to simple heuristic if classification fails
    }

    // Fallback: short messages are chat, longer ones are probably tasks
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
    // Alice tells Diana in #leadership
    try {
      await this.agentManager.agentToAgentChat(
        'ceo', 'pm',
        `new project from the investor: "${summary}". take point on this — figure out what we need and get the team moving`,
        'leadership'
      );
    } catch { /* non-critical */ }

    // Create a PM task with full context and API access
    const apiUrl = `http://localhost:${agencyConfig.wsPort + 1}`;
    const agents = this.agentManager.getAllBlueprints();
    const agentList = agents.filter(a => !['ceo', 'hr'].includes(a.id))
      .map(a => `- ${a.id}: ${a.name} (${a.role})`).join('\n');

    const task = {
      id: crypto.randomUUID(),
      title: `Plan & execute: ${summary.slice(0, 100)}`,
      description: [
        `The investor wants: "${investorMessage}"`,
        ``,
        `You are Diana, the PM/Tech Lead. Your job:`,
        `1. Evaluate the complexity of this request`,
        `2. If it's a complex project, create a project and consult Charlie (architect) first`,
        `3. If it's straightforward, go ahead and break it into tasks`,
        `4. Assign tasks to the right agents using the API`,
        `5. If repos are needed, ask the investor or create them via API`,
        ``,
        `## Available Team`,
        agentList,
        ``,
        `## Agency API (use via curl)`,
        `- Create project: curl -s -X POST ${apiUrl}/api/agency/projects -H 'Content-Type: application/json' -d '{"name":"...","description":"..."}'`,
        `- Add repo: curl -s -X POST ${apiUrl}/api/agency/repositories -H 'Content-Type: application/json' -d '{"projectId":"...","repoUrl":"..."}'`,
        `- Clone repo: curl -s -X POST ${apiUrl}/api/agency/repositories/{repoId}/clone`,
        `- Create & assign task: curl -s -X POST ${apiUrl}/api/agency/tasks -H 'Content-Type: application/json' -d '{"projectId":"...","title":"...","description":"...","assignTo":"developer","priority":7}'`,
        `- List agents: curl -s ${apiUrl}/api/agents`,
        `- List projects: curl -s ${apiUrl}/api/projects`,
        ``,
        `## Decision Guide`,
        `- Need architecture review? → Create a task for "architect" first`,
        `- Need UI/design? → Create a task for "designer"`,
        `- Need research? → Create a task for "researcher"`,
        `- Pure code work? → Create tasks for "developer", "frontend-developer", or "backend-developer"`,
        `- Simple enough for one person? → Create just one task`,
        `- Complex? → Create multiple subtasks and assign to different agents`,
        `- Need MORE people of the same role? → You can assign the same task type to multiple agents, or ask Alice to have Bob (HR) hire more (e.g. "frontend-developer-2", "frontend-developer-3")`,
        `- Multiple agents CAN work on different tasks in parallel — assign different subtasks to different agents`,
        ``,
        `Take action now. Use curl to create the project and tasks via the API.`,
      ].join('\n'),
      status: 'assigned' as const,
      projectId: null,
      assignedTo: 'pm',
      createdBy: 'ceo',
      parentTaskId: null,
      priority: 8,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);
    await this.agentManager.assignTask('pm', task);
  }

  /**
   * Simple task — PM gets it and decides who does it.
   * For very simple things PM might just assign to one developer directly.
   */
  private async delegateSimpleTask(investorMessage: string, summary: string): Promise<void> {
    const apiUrl = `http://localhost:${agencyConfig.wsPort + 1}`;
    const agents = this.agentManager.getAllBlueprints();
    const agentList = agents.filter(a => !['ceo', 'hr'].includes(a.id))
      .map(a => `- ${a.id}: ${a.name} (${a.role})`).join('\n');

    const task = {
      id: crypto.randomUUID(),
      title: summary.slice(0, 120),
      description: [
        `Investor request: "${investorMessage}"`,
        ``,
        `You are Diana, the PM. This is a simple/direct request.`,
        `Figure out who should do it and assign it via the API.`,
        ``,
        `## Available Team`,
        agentList,
        ``,
        `## API`,
        `- Create & assign task: curl -s -X POST ${apiUrl}/api/agency/tasks -H 'Content-Type: application/json' -d '{"title":"...","description":"...","assignTo":"developer","priority":7}'`,
        `- List agents: curl -s ${apiUrl}/api/agents`,
        ``,
        `Assign to the most appropriate agent. If unclear, assign to "developer".`,
      ].join('\n'),
      status: 'assigned' as const,
      projectId: null,
      assignedTo: 'pm',
      createdBy: 'ceo',
      parentTaskId: null,
      priority: 7,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);
    await this.agentManager.assignTask('pm', task);
  }

  /**
   * Route HR requests to Bob.
   */
  private async routeToHr(investorMessage: string, ceoResponse: string): Promise<void> {
    try {
      const hrResponse = await this.agentManager.chat('hr', investorMessage,
        `You are Bob (HR Manager). The investor asked: "${investorMessage}"\n\nAlice (CEO) responded: "${ceoResponse}"\n\nIf this is a hiring request, create the blueprint JSON immediately. Include all required fields: id, role, name, gender, systemPrompt. Respond with your message and the JSON blueprint if applicable.`
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

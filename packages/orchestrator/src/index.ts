import { agencyConfig } from './config/agency.config.js';
import { defaultBlacklist } from './config/blacklist.js';
import { defaultBlueprints } from './config/blueprints/index.js';
import { StateStore } from './state-store.js';
import { PermissionEngine } from './permission-engine.js';
import { AgentManager } from './agent-manager.js';
import { Scheduler } from './scheduler.js';
import { TaskRouter } from './task-router.js';
import { DashboardWSServer } from './ws-server.js';
import { SlackBridge, type InvestorMessage } from 'slack-bridge';

export class Agency {
  private store: StateStore;
  private permissions: PermissionEngine;
  private agentManager: AgentManager;
  private scheduler: Scheduler;
  private taskRouter: TaskRouter;
  private wsServer: DashboardWSServer;
  private slack: SlackBridge | null = null;

  constructor() {
    this.store = new StateStore(agencyConfig.mysql);
    this.permissions = new PermissionEngine(defaultBlacklist);
    this.agentManager = new AgentManager(this.store, this.permissions, agencyConfig);
    this.scheduler = new Scheduler(this.store, this.agentManager);
    this.taskRouter = new TaskRouter(this.store, this.agentManager);
    this.wsServer = new DashboardWSServer(agencyConfig.wsPort);
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

    // Initialize Slack if configured
    if (agencyConfig.slack.botToken && agencyConfig.slack.appToken) {
      try {
        this.slack = new SlackBridge({
          botToken: agencyConfig.slack.botToken,
          signingSecret: agencyConfig.slack.signingSecret,
          appToken: agencyConfig.slack.appToken,
        });
        await this.slack.start();
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

    // Start the scheduler
    this.scheduler.start();
    console.log('Scheduler started');

    console.log(`WebSocket server running on port ${agencyConfig.wsPort}`);
    console.log('Claude Agency is running. Waiting for tasks...');
  }

  private setupAgentEvents(): void {
    this.agentManager.on('message', async (agentId: string, channel: string, content: string) => {
      // Broadcast to dashboard
      this.wsServer.broadcast('message:new', { agentId, channel, content });

      // Save to DB
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
    });

    this.agentManager.on('taskComplete', (agentId: string, taskId: string) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'review' });
    });

    this.agentManager.on('taskFailed', (agentId: string, taskId: string, error: string) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'blocked', error });
    });

    this.agentManager.on('breakStarted', (agentId: string, reason: string, until: Date) => {
      this.wsServer.broadcast('break:start', { agentId, reason, until: until.toISOString() });
    });

    this.agentManager.on('breakEnded', (agentId: string) => {
      this.wsServer.broadcast('break:end', { agentId });
    });

    this.agentManager.on('needsApproval', async (agentId: string, title: string, description: string) => {
      this.wsServer.broadcast('approval:new', { agentId, title, description });

      // Create approval in DB
      const approvalId = crypto.randomUUID();
      await this.store.createApproval({
        id: approvalId,
        title,
        description,
        requestedBy: agentId,
        status: 'pending',
        projectId: null,
        response: null,
        createdAt: new Date(),
        resolvedAt: null,
      });

      // Send to Slack
      if (this.slack) {
        const blueprint = this.agentManager.getBlueprint(agentId);
        await this.slack.sendApprovalRequest(approvalId, title, description, blueprint?.name ?? agentId);
      }
    });

    this.agentManager.on('error', (agentId: string, error: Error) => {
      console.error(`[Agent ${agentId}] Error:`, error.message);
      this.wsServer.broadcast('agent:status', { agentId, status: 'error', error: error.message });
    });
  }

  private setupSlackBridge(): void {
    if (!this.slack) return;

    // Investor messages in #agency-ceo-investor → route to CEO
    this.slack.on('investor:message', async (msg: InvestorMessage) => {
      console.log(`[Slack] Investor: ${msg.text}`);
      const { projectId, taskId } = await this.taskRouter.submitIdea(
        msg.text.slice(0, 100),
        msg.text,
      );
      // Acknowledge in Slack
      await this.slack!.sendAgentMessage('agency-ceo-investor', 'Alice', 'CEO', `got it, I'm on it`);
    });

    // Approval responses
    this.slack.on('approval:resolve', async (data: { approvalId: string; status: string; userId: string }) => {
      if (data.approvalId) {
        await this.store.resolveApproval(
          data.approvalId,
          data.status as 'approved' | 'rejected',
        );
        this.wsServer.broadcast('approval:resolved', {
          approvalId: data.approvalId,
          status: data.status,
        });
      }
    });

    // Messages in project channels → context for working agents
    this.slack.on('channel:message', async (msg: InvestorMessage) => {
      // Save as a message in the system for context
      await this.store.saveMessage({
        id: crypto.randomUUID(),
        fromAgentId: 'investor',
        toAgentId: null,
        channel: msg.channelName,
        content: msg.text,
        timestamp: new Date(),
      });
    });
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

  getStore(): StateStore {
    return this.store;
  }

  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  getSlack(): SlackBridge | null {
    return this.slack;
  }

  async shutdown(): Promise<void> {
    console.log('Shutting down...');
    this.scheduler.stop();
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

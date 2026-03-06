import { agencyConfig } from './config/agency.config.js';
import { defaultBlacklist } from './config/blacklist.js';
import { defaultBlueprints } from './config/blueprints/index.js';
import { StateStore } from './state-store.js';
import { PermissionEngine } from './permission-engine.js';
import { AgentManager } from './agent-manager.js';
import { Scheduler } from './scheduler.js';
import { TaskRouter } from './task-router.js';
import { DashboardWSServer } from './ws-server.js';

export class Agency {
  private store: StateStore;
  private permissions: PermissionEngine;
  private agentManager: AgentManager;
  private scheduler: Scheduler;
  private taskRouter: TaskRouter;
  private wsServer: DashboardWSServer;

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

    // Wire up events to WebSocket broadcasts
    this.agentManager.on('message', (agentId, channel, content) => {
      this.wsServer.broadcast('message:new', { agentId, channel, content });
      // Also save to DB
      this.store.saveMessage({
        id: crypto.randomUUID(),
        fromAgentId: agentId,
        toAgentId: null,
        channel,
        content,
        timestamp: new Date(),
      });
    });

    this.agentManager.on('taskComplete', (agentId, taskId) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'review' });
    });

    this.agentManager.on('taskFailed', (agentId, taskId, error) => {
      this.wsServer.broadcast('task:update', { agentId, taskId, status: 'blocked', error });
    });

    this.agentManager.on('breakStarted', (agentId, reason, until) => {
      this.wsServer.broadcast('break:start', { agentId, reason, until: until.toISOString() });
    });

    this.agentManager.on('breakEnded', (agentId) => {
      this.wsServer.broadcast('break:end', { agentId });
    });

    this.agentManager.on('error', (agentId, error) => {
      console.error(`[Agent ${agentId}] Error:`, error.message);
      this.wsServer.broadcast('agent:status', { agentId, status: 'error', error: error.message });
    });

    // Start the scheduler
    this.scheduler.start();
    console.log('Scheduler started');

    console.log(`WebSocket server running on port ${agencyConfig.wsPort}`);
    console.log('Claude Agency is running. Waiting for tasks...');
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

  async shutdown(): Promise<void> {
    console.log('Shutting down...');
    this.scheduler.stop();
    this.wsServer.close();
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

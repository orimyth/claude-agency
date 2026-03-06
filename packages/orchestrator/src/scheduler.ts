import type { AgentManager } from './agent-manager.js';
import type { StateStore } from './state-store.js';

export class Scheduler {
  private store: StateStore;
  private agentManager: AgentManager;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private breakCheckInterval: ReturnType<typeof setInterval> | null = null;

  constructor(store: StateStore, agentManager: AgentManager) {
    this.store = store;
    this.agentManager = agentManager;
  }

  start(tickMs = 10_000, breakCheckMs = 30_000): void {
    // Main loop: check for idle agents with pending tasks
    this.tickInterval = setInterval(() => this.tick(), tickMs);

    // Break recovery: check if agents should come back from break
    this.breakCheckInterval = setInterval(() => this.checkBreaks(), breakCheckMs);
  }

  stop(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.breakCheckInterval) clearInterval(this.breakCheckInterval);
  }

  private async tick(): Promise<void> {
    try {
      const agents = await this.store.getAllAgents();

      for (const agent of agents) {
        if (agent.status !== 'idle') continue;

        const task = await this.store.getNextAvailableTask(agent.id);
        if (task) {
          await this.agentManager.assignTask(agent.id, task);
        }
      }
    } catch (err) {
      console.error('[Scheduler] tick error:', err);
    }
  }

  private async checkBreaks(): Promise<void> {
    try {
      const agents = await this.store.getAllAgents();
      const now = new Date();

      for (const agent of agents) {
        if (agent.status !== 'on_break') continue;
        if (agent.breakUntil && agent.breakUntil <= now) {
          await this.store.endBreak(agent.id);
          await this.store.updateAgentStatus(agent.id, 'idle');
          await this.agentManager.pickUpNextTask(agent.id);
        }
      }
    } catch (err) {
      console.error('[Scheduler] break check error:', err);
    }
  }
}

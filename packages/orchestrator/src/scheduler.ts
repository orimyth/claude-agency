import { EventEmitter } from 'events';
import type { AgentManager } from './agent-manager.js';
import type { StateStore } from './state-store.js';
import { getSDKMetrics } from './sdk-util.js';

export class Scheduler extends EventEmitter {
  private store: StateStore;
  private agentManager: AgentManager;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private breakCheckInterval: ReturnType<typeof setInterval> | null = null;
  private statusReportInterval: ReturnType<typeof setInterval> | null = null;

  constructor(store: StateStore, agentManager: AgentManager) {
    super();
    this.store = store;
    this.agentManager = agentManager;
  }

  start(tickMs = 10_000, breakCheckMs = 30_000, statusReportMs = 15 * 60_000): void {
    // Main loop: check for idle agents with pending tasks
    this.tickInterval = setInterval(() => this.tick(), tickMs);

    // Break recovery: check if agents should come back from break
    this.breakCheckInterval = setInterval(() => this.checkBreaks(), breakCheckMs);

    // Periodic CEO status report (only fires when at least 1 agent is active)
    this.statusReportInterval = setInterval(() => this.triggerStatusReport(), statusReportMs);
  }

  stop(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.breakCheckInterval) clearInterval(this.breakCheckInterval);
    if (this.statusReportInterval) clearInterval(this.statusReportInterval);
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

  private async triggerStatusReport(): Promise<void> {
    try {
      const agents = await this.store.getAllAgents();
      const tasks = await this.store.getAllTasks(200);

      const active = agents.filter(a => a.status === 'active');
      const onBreak = agents.filter(a => a.status === 'on_break');
      const idle = agents.filter(a => a.status === 'idle');

      // Skip status report if nobody is working (all idle/paused)
      if (active.length === 0 && onBreak.length === 0) {
        return;
      }
      const inProgress = tasks.filter(t => t.status === 'in_progress');
      const completed = tasks.filter(t => t.status === 'done' || t.status === 'review');
      const blocked = tasks.filter(t => t.status === 'blocked');
      const pending = tasks.filter(t => t.status === 'backlog' || t.status === 'assigned');

      this.emit('statusReport', {
        agents,
        summary: {
          activeAgents: active.length,
          idleAgents: idle.length,
          onBreakAgents: onBreak.length,
          tasksInProgress: inProgress.length,
          tasksCompleted: completed.length,
          tasksBlocked: blocked.length,
          tasksPending: pending.length,
        },
        sdkMetrics: getSDKMetrics(),
        activeDetails: active.map(a => ({
          id: a.id,
          name: this.agentManager.getBlueprint(a.id)?.name ?? a.id,
          taskId: a.currentTaskId,
        })),
        blockedTasks: blocked.map(t => ({ id: t.id, title: t.title })),
      });
    } catch (err) {
      console.error('[Scheduler] status report error:', err);
    }
  }
}

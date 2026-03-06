import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';
import type { AgentBlueprint, AgentState, Task, AgencyConfig } from './types.js';
import type { StateStore } from './state-store.js';
import type { PermissionEngine } from './permission-engine.js';

export interface AgentEvents {
  message: (agentId: string, channel: string, content: string) => void;
  taskComplete: (agentId: string, taskId: string) => void;
  taskFailed: (agentId: string, taskId: string, error: string) => void;
  breakStarted: (agentId: string, reason: string, until: Date) => void;
  breakEnded: (agentId: string) => void;
  error: (agentId: string, error: Error) => void;
  needsApproval: (agentId: string, title: string, description: string) => void;
}

export class AgentManager extends EventEmitter {
  private store: StateStore;
  private permissions: PermissionEngine;
  private config: AgencyConfig;
  private blueprints: Map<string, AgentBlueprint> = new Map();
  private activeSessions: Map<string, AbortController> = new Map();
  private activeCount = 0;

  constructor(store: StateStore, permissions: PermissionEngine, config: AgencyConfig) {
    super();
    this.store = store;
    this.permissions = permissions;
    this.config = config;
  }

  registerBlueprint(blueprint: AgentBlueprint): void {
    this.blueprints.set(blueprint.id, blueprint);
  }

  getBlueprint(id: string): AgentBlueprint | undefined {
    return this.blueprints.get(id);
  }

  getAllBlueprints(): AgentBlueprint[] {
    return Array.from(this.blueprints.values());
  }

  async initializeAgent(blueprint: AgentBlueprint): Promise<AgentState> {
    const state: AgentState = {
      id: blueprint.id,
      blueprintId: blueprint.id,
      status: 'idle',
      currentTaskId: null,
      lastActiveAt: new Date(),
      breakUntil: null,
      sessionId: null,
    };
    await this.store.upsertAgent(state);
    return state;
  }

  async assignTask(agentId: string, task: Task): Promise<void> {
    const blueprint = this.blueprints.get(agentId);
    if (!blueprint) throw new Error(`No blueprint for agent ${agentId}`);

    const agent = await this.store.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found in store`);

    if (agent.status === 'on_break') {
      await this.store.updateTaskStatus(task.id, 'assigned', agentId);
      return;
    }

    if (this.activeCount >= this.config.maxConcurrency) {
      await this.store.updateTaskStatus(task.id, 'assigned', agentId);
      this.emit('message', agentId, 'system', `task queued, waiting for a slot to open up`);
      return;
    }

    await this.store.updateTaskStatus(task.id, 'in_progress', agentId);
    await this.store.updateAgentStatus(agentId, 'active');
    await this.store.upsertAgent({ ...agent, status: 'active', currentTaskId: task.id });

    this.runAgent(blueprint, task).catch(err => {
      this.emit('error', agentId, err);
    });
  }

  private async runAgent(blueprint: AgentBlueprint, task: Task): Promise<void> {
    const abortController = new AbortController();
    this.activeSessions.set(blueprint.id, abortController);
    this.activeCount++;

    const project = await this.store.getProject(task.projectId);
    const workDir = project?.workspacePath || this.config.workspace;

    const prompt = this.buildTaskPrompt(blueprint, task);

    try {
      const stream = query({
        prompt,
        options: {
          customSystemPrompt: blueprint.systemPrompt,
          cwd: workDir,
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          abortController,
          permissionMode: 'bypassPermissions',
          maxTurns: 50,
        },
      });

      let resultText = '';

      for await (const message of stream) {
        if (message.type === 'result') {
          const resultMsg = message as SDKResultMessage;
          if (resultMsg.subtype === 'success') {
            resultText = resultMsg.result;
          }
        }
      }

      // Task completed
      this.emit('message', blueprint.id, `project-${task.projectId}`, resultText || 'task done');
      this.emit('taskComplete', blueprint.id, task.id);

      await this.store.updateTaskStatus(task.id, 'review');
      await this.store.updateAgentStatus(blueprint.id, 'idle');
      await this.store.recordKPI(blueprint.id, 'tasks_completed', 1);

      // Autonomous loop: pick up next task
      await this.pickUpNextTask(blueprint.id);
    } catch (err: any) {
      if (this.isRateLimitError(err)) {
        await this.handleRateLimit(blueprint.id, err);
      } else if (abortController.signal.aborted) {
        await this.store.updateAgentStatus(blueprint.id, 'paused');
      } else {
        this.emit('error', blueprint.id, err);
        this.emit('taskFailed', blueprint.id, task.id, err.message);
        await this.store.updateTaskStatus(task.id, 'blocked');
        await this.store.updateAgentStatus(blueprint.id, 'error');
      }
    } finally {
      this.activeSessions.delete(blueprint.id);
      this.activeCount--;
    }
  }

  private buildTaskPrompt(blueprint: AgentBlueprint, task: Task): string {
    return [
      `You are ${blueprint.name}, the ${blueprint.role}.`,
      ``,
      `## Current Task`,
      `**${task.title}**`,
      task.description,
      ``,
      `## Instructions`,
      `- Complete this task autonomously`,
      `- When done, summarize what you did in 1-2 short sentences`,
      `- If you're blocked, say exactly what you need`,
    ].join('\n');
  }

  private isRateLimitError(err: any): boolean {
    const msg = err.message?.toLowerCase() ?? '';
    return msg.includes('rate limit') || msg.includes('429') || msg.includes('too many requests');
  }

  private async handleRateLimit(agentId: string, _err: any): Promise<void> {
    const breakMinutes = 5;
    const breakUntil = new Date(Date.now() + breakMinutes * 60 * 1000);

    await this.store.updateAgentStatus(agentId, 'on_break', breakUntil);
    await this.store.recordBreak(agentId, 'rate_limit');
    await this.store.recordKPI(agentId, 'breaks_taken', 1);

    const blueprint = this.blueprints.get(agentId);
    const name = blueprint?.name ?? agentId;
    this.emit('breakStarted', agentId, 'rate_limit', breakUntil);
    this.emit('message', agentId, 'general', `${name} is taking a break, back in ~${breakMinutes} min`);

    setTimeout(async () => {
      await this.store.endBreak(agentId);
      await this.store.updateAgentStatus(agentId, 'idle');
      this.emit('breakEnded', agentId);
      this.emit('message', agentId, 'general', `${name} is back from break`);
      await this.pickUpNextTask(agentId);
    }, breakMinutes * 60 * 1000);
  }

  async pickUpNextTask(agentId: string): Promise<void> {
    const agent = await this.store.getAgent(agentId);
    if (!agent || agent.status === 'on_break' || agent.status === 'paused') return;

    const task = await this.store.getNextAvailableTask(agentId);
    if (task) {
      await this.assignTask(agentId, task);
    } else {
      await this.store.updateAgentStatus(agentId, 'idle');
    }
  }

  async pauseAgent(agentId: string): Promise<void> {
    const controller = this.activeSessions.get(agentId);
    if (controller) {
      controller.abort();
    }
    await this.store.updateAgentStatus(agentId, 'paused');
  }

  async resumeAgent(agentId: string): Promise<void> {
    await this.store.updateAgentStatus(agentId, 'idle');
    await this.pickUpNextTask(agentId);
  }

  getActiveCount(): number {
    return this.activeCount;
  }
}

import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentBlueprint, AgentState, Task, AgencyConfig } from './types.js';
import type { StateStore } from './state-store.js';
import type { PermissionEngine } from './permission-engine.js';

// Build an env with node's directory in PATH for the Claude Code SDK.
// pnpm replaces PATH with only node_modules/.bin dirs, so nvm's node isn't found.
const nodeDir = dirname(process.execPath);
const sdkEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) sdkEnv[k] = v;
}
if (!sdkEnv.PATH?.includes(nodeDir)) {
  sdkEnv.PATH = `${nodeDir}:${sdkEnv.PATH || ''}`;
}

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
  private languageOverride: string | null = null;

  constructor(store: StateStore, permissions: PermissionEngine, config: AgencyConfig) {
    super();
    this.store = store;
    this.permissions = permissions;
    this.config = config;
  }

  setLanguage(lang: string | null): void {
    this.languageOverride = lang;
  }

  getLanguage(): string | null {
    return this.languageOverride;
  }

  private getLanguageInstruction(): string {
    if (this.languageOverride && this.languageOverride !== 'auto') {
      return `IMPORTANT: Always respond in ${this.languageOverride}. Every message must be in ${this.languageOverride}, regardless of what language the user writes in.`;
    }
    return `IMPORTANT: Always respond in the same language the user is writing in. If they write in German, respond in German. If English, respond in English. Match their language exactly.`;
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

    // Announce task pickup
    this.emit('message', agentId, 'general', `picking up "${task.title.replace('[Investor Idea] ', '')}"`);

    this.runAgent(blueprint, task).catch(err => {
      this.emit('error', agentId, err);
    });
  }

  private async runAgent(blueprint: AgentBlueprint, task: Task): Promise<void> {
    const abortController = new AbortController();
    this.activeSessions.set(blueprint.id, abortController);
    this.activeCount++;

    const project = task.projectId ? await this.store.getProject(task.projectId) : null;
    let workDir = project?.workspacePath || this.config.workspace;
    // Resolve relative workspace paths against project root
    if (!workDir.startsWith('/')) {
      workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', workDir);
    }

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
          env: sdkEnv,
        },
      });

      let resultText = '';
      let turnCount = 0;
      let lastResult: SDKResultMessage | null = null;

      for await (const message of stream) {
        // Track turns for progress updates
        if (message.type === 'assistant') {
          turnCount++;
          // Emit periodic progress (every 5 turns)
          if (turnCount % 5 === 0) {
            this.emit('message', blueprint.id, 'general',
              `still working on "${task.title.replace('[Investor Idea] ', '')}"...`);
          }
        }

        if (message.type === 'result') {
          const resultMsg = message as SDKResultMessage;
          lastResult = resultMsg;
          if (resultMsg.subtype === 'success') {
            resultText = resultMsg.result;
          }
        }
      }

      // Announce task completion
      const summary = resultText ? resultText.slice(0, 200) : 'done';
      const channel = task.projectId ? `project-${task.projectId}` : 'general';
      this.emit('message', blueprint.id, channel, summary);
      this.emit('taskComplete', blueprint.id, task.id);

      // Record usage from the result message
      if (lastResult) {
        await this.store.recordUsage({
          id: crypto.randomUUID(),
          agentId: blueprint.id,
          taskId: task.id,
          inputTokens: lastResult.usage?.input_tokens ?? 0,
          outputTokens: lastResult.usage?.output_tokens ?? 0,
          cacheReadTokens: lastResult.usage?.cache_read_input_tokens ?? 0,
          cacheCreationTokens: lastResult.usage?.cache_creation_input_tokens ?? 0,
          costUsd: lastResult.total_cost_usd ?? 0,
          numTurns: lastResult.num_turns ?? 0,
          durationMs: lastResult.duration_ms ?? 0,
          model: Object.keys(lastResult.modelUsage ?? {})[0] ?? null,
        });
      }

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
      this.getLanguageInstruction(),
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

  /**
   * Send a conversational message to an agent and get a response.
   * Unlike assignTask, this doesn't create tasks — it's for direct chat.
   */
  async chat(agentId: string, message: string, context?: string): Promise<string> {
    const blueprint = this.blueprints.get(agentId);
    if (!blueprint) throw new Error(`No blueprint for agent ${agentId}`);

    let workDir = this.config.workspace;
    if (!workDir.startsWith('/')) {
      workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', workDir);
    }

    // Mark agent as active while chatting
    await this.store.updateAgentStatus(agentId, 'active');

    const langRule = this.getLanguageInstruction();

    const prompt = context
      ? `${langRule}\n\n${context}`
      : `${langRule}\n\nThe investor (your boss) just sent you this message on Slack:\n\n"${message}"\n\nRespond naturally. If they're asking you to build or do something, say you'll get the team on it. If it's casual chat, just be friendly and human. Keep it short — 1-3 sentences max, like a real Slack message.`;

    const stream = query({
      prompt,
      options: {
        customSystemPrompt: blueprint.systemPrompt,
        cwd: workDir,
        allowedTools: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        env: sdkEnv,
      },
    });

    let result = '';
    for await (const msg of stream) {
      if (msg.type === 'result') {
        const r = msg as SDKResultMessage;
        if (r.subtype === 'success') result = r.result;
        // Track chat usage
        try {
          await this.store.recordUsage({
            id: crypto.randomUUID(),
            agentId,
            taskId: null,
            inputTokens: r.usage?.input_tokens ?? 0,
            outputTokens: r.usage?.output_tokens ?? 0,
            cacheReadTokens: r.usage?.cache_read_input_tokens ?? 0,
            cacheCreationTokens: r.usage?.cache_creation_input_tokens ?? 0,
            costUsd: r.total_cost_usd ?? 0,
            numTurns: r.num_turns ?? 0,
            durationMs: r.duration_ms ?? 0,
            model: Object.keys(r.modelUsage ?? {})[0] ?? null,
          });
        } catch { /* non-critical */ }
      }
    }

    // Return to idle after chat
    await this.store.updateAgentStatus(agentId, 'idle');

    return result || "hey, give me a sec";
  }

  /**
   * One agent asks another agent a question and gets a response.
   * Both sides are posted to the specified channel.
   */
  async agentToAgentChat(
    fromId: string, toId: string, message: string, channel = 'leadership'
  ): Promise<string> {
    const from = this.blueprints.get(fromId);
    const to = this.blueprints.get(toId);
    if (!from || !to) throw new Error(`Blueprint not found`);

    // Post the question
    this.emit('message', fromId, channel, message);

    // Get the response
    const context = [
      `You are ${to.name} (${to.role}).`,
      `${from.name} (${from.role}) just said to you in #${channel}:`,
      `"${message}"`,
      ``,
      `Respond naturally as ${to.name}. Keep it short — 1-3 sentences, like a real Slack message. Only respond with your message.`,
    ].join('\n');

    const response = await this.chat(toId, message, context);
    this.emit('message', toId, channel, response);
    return response;
  }

  /**
   * Hand off work from one agent to another with context.
   * Creates a task assigned to the target agent.
   */
  async requestHandoff(
    fromId: string, toId: string, title: string, description: string, channel = 'general'
  ): Promise<void> {
    const from = this.blueprints.get(fromId);
    const to = this.blueprints.get(toId);
    if (!from || !to) return;

    // Announce the handoff
    this.emit('message', fromId, channel,
      `hey ${to.name.toLowerCase()}, handing this off to you: ${title}`);

    // Create and assign the task
    const task = {
      id: crypto.randomUUID(),
      title,
      description: `${from.name} (${from.role}) handed this off:\n\n${description}`,
      status: 'assigned' as const,
      projectId: null,
      assignedTo: toId,
      createdBy: fromId,
      parentTaskId: null,
      priority: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);
    await this.assignTask(toId, task);
  }

  getActiveCount(): number {
    return this.activeCount;
  }
}

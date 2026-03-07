import { query, type SDKResultMessage } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentBlueprint, AgentState, Task, AgencyConfig } from './types.js';
import type { StateStore } from './state-store.js';
import type { PermissionEngine } from './permission-engine.js';
import type { MemoryManager } from './memory-manager.js';
import type { AgentToolHandler } from './agent-tools.js';
import { sdkEnv } from './sdk-util.js';

/** Roles that get agency management tools (can create projects, tasks, etc.) */
const MANAGEMENT_ROLES = new Set(['ceo', 'pm', 'architect', 'hr']);

/** Model tiers for smart routing */
const MODEL_OPUS = 'claude-opus-4-6';
const MODEL_SONNET = 'claude-sonnet-4-6';
const MODEL_HAIKU = 'claude-haiku-4-5-20251001';

/** Worker roles that only get git push/repo listing APIs */
const WORKER_ROLES = new Set(['developer', 'frontend-developer', 'backend-developer', 'designer']);

/**
 * Smart model routing — pick the cheapest model that can handle the task.
 * - Opus: complex coding, architecture, multi-step tasks
 * - Sonnet: management tasks (PM planning, CEO investor chats)
 * - Haiku: simple chat, status updates, acknowledgments
 */
function selectTaskModel(agentId: string, task: { title: string; description: string }): string {
  // Architect tasks need deep reasoning
  if (agentId === 'architect') return MODEL_OPUS;
  // Developer/QA tasks involve coding — use Opus
  if (WORKER_ROLES.has(agentId) || agentId === 'qa' || agentId === 'security') return MODEL_OPUS;
  // PM/CEO management tasks (creating projects, assigning) — Sonnet is sufficient
  if (MANAGEMENT_ROLES.has(agentId)) return MODEL_SONNET;
  // Default to Sonnet for unknown roles
  return MODEL_SONNET;
}

function selectChatModel(agentId: string, context?: string): string {
  // CEO investor chats need nuance — Sonnet
  if (agentId === 'ceo') return MODEL_SONNET;
  // HR chat (may need to generate blueprints) — Sonnet
  if (agentId === 'hr') return MODEL_SONNET;
  // All other chat (status updates, acknowledgments) — Haiku
  return MODEL_HAIKU;
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
  /** Persistent session IDs per agent — allows resuming conversations instead of starting fresh. */
  private agentSessionIds: Map<string, string> = new Map();
  /** Persistent session IDs for chat, keyed by "agentId:channel" for isolation. */
  private chatSessionIds: Map<string, string> = new Map();
  private activeCount = 0;
  private languageOverride: string | null = null;
  private memoryManager: MemoryManager | null = null;
  private toolHandler: AgentToolHandler | null = null;

  constructor(store: StateStore, permissions: PermissionEngine, config: AgencyConfig) {
    super();
    this.store = store;
    this.permissions = permissions;
    this.config = config;
  }

  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  setToolHandler(handler: AgentToolHandler): void {
    this.toolHandler = handler;
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

  private resolveWorkDir(path?: string | null): string {
    let workDir = path || this.config.workspace;
    if (!workDir.startsWith('/')) {
      workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', workDir);
    }
    return workDir;
  }

  registerBlueprint(blueprint: AgentBlueprint): void {
    // Inject role-specific API instructions into the system prompt at registration time.
    // This makes them cacheable by the SDK instead of re-sent as user tokens every task.
    const enriched = { ...blueprint, systemPrompt: this.enrichSystemPrompt(blueprint) };
    this.blueprints.set(enriched.id, enriched);
  }

  /**
   * Build the system prompt: static role first (cacheable), then API docs, then language.
   * Structured for maximum prompt caching: most-static content first, least-static last.
   */
  private enrichSystemPrompt(blueprint: AgentBlueprint): string {
    const apiUrl = `http://localhost:${this.config.wsPort + 1}`;
    const H = `-H 'Content-Type: application/json'`;
    // Language instruction last — it can change via settings, so it should be after the cached prefix
    const langExtra = `\n\n${this.getLanguageInstruction()}`;
    let apiExtra = '';

    if (MANAGEMENT_ROLES.has(blueprint.id)) {
      apiExtra = [
        `\n\n## Agency API (use curl)`,
        `Base: ${apiUrl}`,
        `Projects: POST ${apiUrl}/api/agency/projects ${H} -d '{"name":"...","description":"..."}'`,
        `  List: GET ${apiUrl}/api/projects | Detail: GET ${apiUrl}/api/projects/{id}`,
        `Repos: POST ${apiUrl}/api/agency/repositories ${H} -d '{"projectId":"...","repoUrl":"..."}'`,
        `  Clone: POST ${apiUrl}/api/agency/repositories/{id}/clone | List: GET ${apiUrl}/api/projects/{id}/repositories`,
        `Tasks: POST ${apiUrl}/api/agency/tasks ${H} -d '{"projectId":"...","title":"...","description":"...","assignTo":"developer","priority":7}'`,
        `  Dependencies: add "dependsOn":"<taskId>" | List: GET ${apiUrl}/api/tasks?projectId={id} | Agents: GET ${apiUrl}/api/agents`,
        `Git: POST ${apiUrl}/api/agency/repositories/{id}/push ${H} -d '{"commitMessage":"...","taskId":"..."}'`,
        `  Merge: POST ${apiUrl}/api/agency/repositories/{id}/merge ${H} -d '{"featureBranch":"feature/..."}'`,
        `Push auto-creates feature branch. Merge only after QA passes.`,
      ].join('\n');
    } else if (WORKER_ROLES.has(blueprint.id)) {
      apiExtra = [
        `\n\n## Git Push API (do NOT use git push directly)`,
        `Push: curl -X POST ${apiUrl}/api/agency/repositories/{repoId}/push ${H} -d '{"commitMessage":"...","taskId":"<your-task-id>"}'`,
        `List repos: curl ${apiUrl}/api/projects/{projectId}/repositories`,
        `repoId is in your Project Context. Push auto-creates feature branch.`,
      ].join('\n');
    }

    return blueprint.systemPrompt + langExtra + apiExtra;
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

    const announceChannel = task.projectId ? `project-${task.projectId}` : 'general';
    this.emit('message', agentId, announceChannel, `picking up "${task.title.replace('[Investor Idea] ', '')}"`);

    this.runAgent(blueprint, task).catch(err => {
      this.emit('error', agentId, err);
    });
  }

  /**
   * Determine the working directory for a task.
   * If the task has a project with repos, use the first repo's local path.
   */
  private async resolveTaskWorkDir(task: Task): Promise<string> {
    if (task.projectId) {
      const repos = await this.store.getProjectRepositories(task.projectId);
      if (repos.length > 0 && repos[0].localPath) {
        const { existsSync } = await import('fs');
        if (existsSync(repos[0].localPath)) {
          return repos[0].localPath;
        }
      }
    }
    return this.resolveWorkDir();
  }

  private async runAgent(blueprint: AgentBlueprint, task: Task): Promise<void> {
    const abortController = new AbortController();
    this.activeSessions.set(blueprint.id, abortController);
    this.activeCount++;

    const workDir = await this.resolveTaskWorkDir(task);
    const prompt = await this.buildTaskPrompt(blueprint, task);

    // Inject AGENCY_API_URL so agents can call the API via curl/Bash
    const agentEnv = { ...sdkEnv };
    const apiPort = this.config.wsPort + 1;
    agentEnv.AGENCY_API_URL = `http://localhost:${apiPort}`;
    agentEnv.AGENCY_AGENT_ID = blueprint.id;

    try {
      // Resume existing session if available — keeps context across tasks.
      // This means the agent remembers previous work, decisions, and codebase knowledge.
      const existingSession = this.agentSessionIds.get(blueprint.id);

      const queryOptions: Record<string, any> = {
        model: selectTaskModel(blueprint.id, task),
        customSystemPrompt: blueprint.systemPrompt,
        cwd: workDir,
        allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
        abortController,
        permissionMode: 'bypassPermissions',
        maxTurns: 50,
        env: agentEnv,
      };

      // If we have a previous session, resume it to maintain context
      if (existingSession) {
        queryOptions.sessionId = existingSession;
        queryOptions.resume = true;
      }

      const stream = query({
        prompt,
        options: queryOptions,
      });

      let resultText = '';
      let lastResult: SDKResultMessage | null = null;
      const startTime = Date.now();
      let lastProgressAt = startTime;
      let cumulativeCost = 0;
      const costBudget = this.config.maxCostPerTask;

      for await (const message of stream) {
        // Only emit progress if agent has been working for 15+ min since last update
        if (message.type === 'assistant') {
          const now = Date.now();
          const minsSinceLastProgress = (now - lastProgressAt) / 60_000;
          if (minsSinceLastProgress >= 15) {
            lastProgressAt = now;
            const totalMins = Math.round((now - startTime) / 60_000);
            const channel = task.projectId ? `project-${task.projectId}` : 'general';
            this.emit('message', blueprint.id, channel,
              `still on it (${totalMins} min in)`);
          }
        }

        if (message.type === 'result') {
          const resultMsg = message as SDKResultMessage;
          lastResult = resultMsg;
          if (resultMsg.subtype === 'success') {
            resultText = resultMsg.result;
          }
          // Capture session ID for future resumption
          if ((resultMsg as any).sessionId) {
            this.agentSessionIds.set(blueprint.id, (resultMsg as any).sessionId);
          }

          // Token budget circuit breaker — abort if task exceeds cost limit
          cumulativeCost = resultMsg.total_cost_usd ?? 0;
          if (cumulativeCost >= costBudget) {
            abortController.abort();
            const channel = task.projectId ? `project-${task.projectId}` : 'general';
            this.emit('message', blueprint.id, channel,
              `budget exceeded ($${cumulativeCost.toFixed(2)} / $${costBudget.toFixed(2)} limit) — stopping task`);
            console.warn(`[Budget] ${blueprint.name} exceeded $${costBudget} on task "${task.title}" ($${cumulativeCost.toFixed(2)})`);
            break;
          }
        }
      }

      // Auto-push safety net: if worker has uncommitted changes, push them
      if (WORKER_ROLES.has(blueprint.id) && this.toolHandler && task.projectId) {
        try {
          const repos = await this.store.getProjectRepositories(task.projectId);
          if (repos.length > 0 && repos[0].localPath) {
            const { existsSync } = await import('fs');
            const { execSync } = await import('child_process');
            if (existsSync(repos[0].localPath)) {
              const status = execSync(`git -C "${repos[0].localPath}" status --porcelain`, { timeout: 10000 }).toString().trim();
              if (status) {
                const pushResult = await this.toolHandler.handleToolCall(blueprint.id, 'agency_git_push', {
                  repositoryId: repos[0].id,
                  commitMessage: `Auto-push: ${task.title}`,
                  taskId: task.id,
                });
                if (pushResult.success) {
                  const channel = task.projectId ? `project-${task.projectId}` : 'general';
                  this.emit('message', blueprint.id, channel, `auto-pushed uncommitted changes to ${pushResult.data?.branch ?? 'feature branch'}`);
                }
              }
            }
          }
        } catch { /* non-critical — best effort push */ }
      }

      // Announce task completion — strip markdown formatting
      const rawSummary = resultText ? resultText.slice(0, 200) : 'done';
      const summary = rawSummary
        .replace(/\*\*(.*?)\*\*/g, '$1')  // strip bold
        .replace(/__(.*?)__/g, '$1')       // strip underline
        .replace(/^#+\s*/gm, '')           // strip headers
        .replace(/`([^`]+)`/g, '$1');      // strip inline code
      const channel = task.projectId ? `project-${task.projectId}` : 'general';
      this.emit('message', blueprint.id, channel, summary);
      this.emit('taskComplete', blueprint.id, task.id, resultText);

      // Record usage
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

      // Extract learnings — skip for QA reviews and short results (they're derivative, not worth the model call)
      const isQAReview = task.title.startsWith('QA Review:') || task.title.startsWith('Fix bugs:');
      if (this.memoryManager && resultText && resultText.length >= 100 && !isQAReview) {
        this.memoryManager.extractLearnings(blueprint.id, task.title, resultText, task.projectId)
          .catch(() => { /* non-critical */ });
      }

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

  private async buildTaskPrompt(blueprint: AgentBlueprint, task: Task): Promise<string> {
    // Identity + language are already in the system prompt — don't repeat here.
    const parts: string[] = [];

    // Inject organizational memory context
    if (this.memoryManager) {
      try {
        const memoryContext = await this.memoryManager.buildContext(blueprint.id, task.projectId);
        if (memoryContext) {
          parts.push(memoryContext);
          parts.push('');
        }
      } catch { /* non-critical */ }
    }

    // Inject project context if available
    if (task.projectId) {
      try {
        const project = await this.store.getProject(task.projectId);
        const repos = await this.store.getProjectRepositories(task.projectId);
        if (project) {
          parts.push(`## Project Context`);
          parts.push(`**Project:** ${project.name}`);
          parts.push(`**Description:** ${project.description}`);
          if (repos.length > 0) {
            parts.push(`**Repositories:**`);
            for (const repo of repos) {
              parts.push(`- ${repo.repoName} [repoId: ${repo.id}] (${repo.repoUrl}) → ${repo.localPath}`);
            }
          }
          parts.push('');
        }
      } catch { /* non-critical */ }
    }

    // API instructions are now in the system prompt (cacheable) via enrichSystemPrompt().
    // Only inject the task-specific taskId hint for workers so they know their task ID for git push.
    if (WORKER_ROLES.has(blueprint.id) && task.id) {
      parts.push(`**Your task ID for git push:** ${task.id}`, '');
    }

    // Inject sibling task titles for context isolation (limit to 5 to save tokens)
    if (task.projectId) {
      try {
        const projectTasks = await this.store.getTasksByProject(task.projectId);
        const siblingTasks = projectTasks.filter(t =>
          t.id !== task.id && t.assignedTo && t.assignedTo !== blueprint.id &&
          ['assigned', 'in_progress'].includes(t.status)
        ).slice(0, 5);
        if (siblingTasks.length > 0) {
          const siblings = siblingTasks.map(st => `"${st.title}" (${st.assignedTo})`).join(', ');
          parts.push(`**Other active tasks (don't touch):** ${siblings}`, '');
        }
      } catch { /* non-critical */ }
    }

    // Cap description to avoid bloated prompts from long predecessor results / QA reports
    const cappedDescription = task.description.length > 2000
      ? task.description.slice(0, 2000) + '\n[...truncated]'
      : task.description;

    parts.push(
      `## Current Task`,
      `**${task.title}**`,
      cappedDescription,
      ``,
      `Complete this task autonomously. Build/test/verify before saying done. Summarize in plain text. If blocked, say what you need.`,
    );

    return parts.join('\n');
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
  async chat(agentId: string, message: string, context?: string, channel = 'default'): Promise<string> {
    const blueprint = this.blueprints.get(agentId);
    if (!blueprint) throw new Error(`No blueprint for agent ${agentId}`);

    const workDir = this.resolveWorkDir();

    // Mark agent as active while chatting
    await this.store.updateAgentStatus(agentId, 'active');

    // Language instruction is in system prompt already (cached).
    const prompt = context
      ? context
      : `The investor (your boss) just sent you this message on Slack:\n\n"${message}"\n\nRespond naturally. If they're asking you to build or do something, say you'll get the team on it. If it's casual chat, just be friendly and human. Keep it short — 1-3 sentences max, like a real Slack message.`;

    // Resume chat session if available — keyed by agent+channel for isolation.
    // This means Alice's investor DM session stays separate from her #leadership chats.
    const sessionKey = `${agentId}:${channel}`;
    const existingChatSession = this.chatSessionIds.get(sessionKey);
    const chatOptions: Record<string, any> = {
      model: selectChatModel(agentId, context),
      customSystemPrompt: blueprint.systemPrompt,
      cwd: workDir,
      allowedTools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      env: sdkEnv,
    };
    if (existingChatSession) {
      chatOptions.sessionId = existingChatSession;
      chatOptions.resume = true;
    }

    const stream = query({ prompt, options: chatOptions });

    let result = '';
    for await (const msg of stream) {
      if (msg.type === 'result') {
        const r = msg as SDKResultMessage;
        if (r.subtype === 'success') result = r.result;
        // Capture chat session ID for future resumption
        if ((r as any).sessionId) {
          this.chatSessionIds.set(sessionKey, (r as any).sessionId);
        }
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

    await this.store.updateAgentStatus(agentId, 'idle');

    return result || "hey, give me a sec";
  }

  /**
   * One agent asks another agent a question and gets a response.
   */
  async agentToAgentChat(
    fromId: string, toId: string, message: string, channel = 'leadership'
  ): Promise<string> {
    const from = this.blueprints.get(fromId);
    const to = this.blueprints.get(toId);
    if (!from || !to) throw new Error(`Blueprint not found`);

    this.emit('message', fromId, channel, message);

    const context = [
      `You are ${to.name} (${to.role}).`,
      `${from.name} (${from.role}) just said to you in #${channel}:`,
      `"${message}"`,
      ``,
      `Respond naturally as ${to.name}. Keep it short — 1-3 sentences, like a real Slack message. Only respond with your message.`,
    ].join('\n');

    const response = await this.chat(toId, message, context, channel);
    this.emit('message', toId, channel, response);
    return response;
  }

  /**
   * Hand off work from one agent to another with context.
   */
  async requestHandoff(
    fromId: string, toId: string, title: string, description: string, channel = 'general'
  ): Promise<void> {
    const from = this.blueprints.get(fromId);
    const to = this.blueprints.get(toId);
    if (!from || !to) return;

    this.emit('message', fromId, channel,
      `hey ${to.name.toLowerCase()}, handing this off to you: ${title}`);

    const task = {
      id: crypto.randomUUID(),
      title,
      description: `${from.name} (${from.role}) handed this off:\n\n${description}`,
      status: 'assigned' as const,
      projectId: null,
      assignedTo: toId,
      createdBy: fromId,
      parentTaskId: null,
      dependsOn: null,
      priority: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);
    await this.assignTask(toId, task);
  }

  /**
   * Send a notification message from one agent to a channel without invoking Claude.
   * Use this for status updates that don't need an AI-generated response.
   * Saves a full model call compared to agentToAgentChat().
   */
  notify(fromId: string, channel: string, message: string): void {
    this.emit('message', fromId, channel, message);
  }

  getActiveCount(): number {
    return this.activeCount;
  }
}

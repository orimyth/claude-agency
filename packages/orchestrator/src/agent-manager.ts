import { query, type SDKResultMessage } from '@anthropic-ai/claude-code';
import { EventEmitter } from 'events';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { AgentBlueprint, AgentState, Task, AgencyConfig } from './types.js';
import type { StateStore } from './state-store.js';
import type { PermissionEngine } from './permission-engine.js';
import type { MemoryManager } from './memory-manager.js';
import type { AgentToolHandler } from './agent-tools.js';

// Build an env with node's directory in PATH for the Claude Code SDK.
const nodeDir = dirname(process.execPath);
const sdkEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) sdkEnv[k] = v;
}
if (!sdkEnv.PATH?.includes(nodeDir)) {
  sdkEnv.PATH = `${nodeDir}:${sdkEnv.PATH || ''}`;
}

/** Roles that get agency management tools (can create projects, tasks, etc.) */
const MANAGEMENT_ROLES = new Set(['ceo', 'pm', 'architect', 'hr']);

/** Worker roles that only get git push/repo listing APIs */
const WORKER_ROLES = new Set(['developer', 'frontend-developer', 'backend-developer', 'designer']);

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
      const stream = query({
        prompt,
        options: {
          customSystemPrompt: blueprint.systemPrompt,
          cwd: workDir,
          allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
          abortController,
          permissionMode: 'bypassPermissions',
          maxTurns: 50,
          env: agentEnv,
        },
      });

      let resultText = '';
      let lastResult: SDKResultMessage | null = null;
      const startTime = Date.now();
      let lastProgressAt = startTime;

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

      // Extract learnings
      if (this.memoryManager && resultText) {
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
    const parts = [
      `You are ${blueprint.name}, the ${blueprint.role}.`,
      this.getLanguageInstruction(),
      ``,
    ];

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

    // Agency API instructions for management roles
    if (MANAGEMENT_ROLES.has(blueprint.id)) {
      const apiUrl = `http://localhost:${this.config.wsPort + 1}`;
      parts.push(
        `## Agency Management API`,
        `You can manage projects, tasks, and repos via the Agency API using curl.`,
        `Base URL: ${apiUrl}`,
        ``,
        `**Project management:**`,
        `- Create project: curl -X POST ${apiUrl}/api/agency/projects -H 'Content-Type: application/json' -d '{"name":"...","description":"..."}'`,
        `- List projects: curl ${apiUrl}/api/projects`,
        `- Get project detail: curl ${apiUrl}/api/projects/{projectId}`,
        ``,
        `**Repository management:**`,
        `- Add repo to project: curl -X POST ${apiUrl}/api/agency/repositories -H 'Content-Type: application/json' -d '{"projectId":"...","repoUrl":"https://github.com/..."}'`,
        `- Clone repo locally: curl -X POST ${apiUrl}/api/agency/repositories/{repoId}/clone`,
        `- List repos: curl ${apiUrl}/api/projects/{projectId}/repositories`,
        ``,
        `**Task management:**`,
        `- Create & assign task: curl -X POST ${apiUrl}/api/agency/tasks -H 'Content-Type: application/json' -d '{"projectId":"...","title":"...","description":"...","assignTo":"developer","priority":7}'`,
        `- Create task with dependency: add "dependsOn":"<taskId>" to make it wait for another task to finish first`,
        `- List tasks: curl ${apiUrl}/api/tasks?projectId={id}`,
        `- List agents: curl ${apiUrl}/api/agents`,
        ``,
        `**Git operations:**`,
        `- Push changes (auto feature branch): curl -X POST ${apiUrl}/api/agency/repositories/{repoId}/push -H 'Content-Type: application/json' -d '{"commitMessage":"...","taskId":"..."}'`,
        `- Merge feature branch to main (after QA passes): curl -X POST ${apiUrl}/api/agency/repositories/{repoId}/merge -H 'Content-Type: application/json' -d '{"featureBranch":"feature/..."}'`,
        `Note: Push automatically creates a feature branch. Merge to main only after QA approves.`,
        ``,
        `When the investor gives you a project idea:`,
        `1. Create a project via API`,
        `2. If repos are mentioned, add and clone them via API`,
        `3. Break down the work into tasks and assign to the right agents via API`,
        ``,
      );
    }

    // Agency Git API instructions for worker roles (limited subset — push & list repos only)
    if (WORKER_ROLES.has(blueprint.id)) {
      const apiUrl = `http://localhost:${this.config.wsPort + 1}`;
      parts.push(
        `## Git Push API`,
        `After committing your changes locally, push them via the Agency API (do NOT use git push directly).`,
        `The API auto-creates a feature branch so you never push to main.`,
        ``,
        `**Push changes:**`,
        `\`\`\``,
        `curl -X POST ${apiUrl}/api/agency/repositories/{repoId}/push \\`,
        `  -H 'Content-Type: application/json' \\`,
        `  -d '{"commitMessage":"describe what you did","taskId":"${task.id}"}'`,
        `\`\`\``,
        ``,
        `**List repos (to find repoId):**`,
        `\`\`\``,
        `curl ${apiUrl}/api/projects/{projectId}/repositories`,
        `\`\`\``,
        ``,
        `The repoId is shown in the Project Context above. Use it directly.`,
        ``,
      );
    }

    // Inject active sibling tasks for context isolation
    if (task.projectId) {
      try {
        const projectTasks = await this.store.getTasksByProject(task.projectId);
        const siblingTasks = projectTasks.filter(t =>
          t.id !== task.id && t.assignedTo && t.assignedTo !== blueprint.id &&
          ['assigned', 'in_progress'].includes(t.status)
        );
        if (siblingTasks.length > 0) {
          parts.push(`## Other Active Tasks (DO NOT work on these — other agents handle them)`);
          for (const st of siblingTasks) {
            const assigneeBp = this.blueprints.get(st.assignedTo!);
            const assigneeName = assigneeBp ? `${assigneeBp.name} (${assigneeBp.role})` : st.assignedTo;
            parts.push(`- "${st.title}" → assigned to ${assigneeName}`);
          }
          parts.push(`Only work on YOUR task below. Do not duplicate work from the tasks above.`);
          parts.push('');
        }
      } catch { /* non-critical */ }
    }

    parts.push(
      `## Current Task`,
      `**${task.title}**`,
      task.description,
      ``,
      `## Instructions`,
      `- Complete this task autonomously`,
      `- BEFORE saying done: build the project, run tests, verify it actually works`,
      `- When done, summarize what you did and how you verified it. Plain text only, no markdown, no bold, no headers — write like a Slack message`,
      `- If you're blocked, say exactly what you need`,
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
  async chat(agentId: string, message: string, context?: string): Promise<string> {
    const blueprint = this.blueprints.get(agentId);
    if (!blueprint) throw new Error(`No blueprint for agent ${agentId}`);

    const workDir = this.resolveWorkDir();

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

    const response = await this.chat(toId, message, context);
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

  getActiveCount(): number {
    return this.activeCount;
  }
}

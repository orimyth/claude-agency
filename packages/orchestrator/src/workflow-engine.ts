import { query, type SDKMessage, type SDKResultMessage } from '@anthropic-ai/claude-code';
import type { AgentManager } from './agent-manager.js';
import type { StateStore } from './state-store.js';
import type { TaskBoard } from './task-board.js';
import { HRManager } from './hr-manager.js';
import type { AgentBlueprint, Task, AgencyConfig } from './types.js';
import { EventEmitter } from 'events';
import { dirname } from 'path';

// Same PATH fix as agent-manager
const nodeDir = dirname(process.execPath);
const wfEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) wfEnv[k] = v;
}
if (!wfEnv.PATH?.includes(nodeDir)) {
  wfEnv.PATH = `${nodeDir}:${wfEnv.PATH || ''}`;
}

/**
 * Handles complex multi-agent workflows:
 * - CEO → Architect consultation
 * - CEO → Investor approval
 * - PM → Worker task assignment
 * - HR → New agent creation
 */
export class WorkflowEngine extends EventEmitter {
  private agentManager: AgentManager;
  private store: StateStore;
  private taskBoard: TaskBoard;
  private hrManager: HRManager;
  private config: AgencyConfig;

  constructor(
    agentManager: AgentManager,
    store: StateStore,
    taskBoard: TaskBoard,
    hrManager: HRManager,
    config: AgencyConfig,
  ) {
    super();
    this.agentManager = agentManager;
    this.store = store;
    this.taskBoard = taskBoard;
    this.hrManager = hrManager;
    this.config = config;
  }

  /**
   * CEO evaluates a new idea and decides the workflow.
   * For complex tasks: CEO → Architect → Investor approval → PM sprint
   * For simple tasks: CEO → PM assignment
   */
  async evaluateIdea(task: Task): Promise<void> {
    const ceoBlueprint = this.agentManager.getBlueprint('ceo');
    if (!ceoBlueprint) return;

    const evaluationPrompt = [
      `You are ${ceoBlueprint.name}, the ${ceoBlueprint.role}.`,
      ``,
      `A new idea has been submitted by the investor:`,
      `Title: ${task.title}`,
      `Description: ${task.description}`,
      ``,
      `Evaluate this idea and respond with a JSON decision:`,
      `{`,
      `  "complexity": "simple" | "complex",`,
      `  "reasoning": "1 sentence why",`,
      `  "needsArchitect": true | false,`,
      `  "needsResearch": true | false,`,
      `  "suggestedTeam": ["developer", "designer", etc],`,
      `  "subtasks": [{"title": "...", "description": "...", "assignTo": "role-id"}]`,
      `}`,
      ``,
      `If complex: set needsArchitect=true and provide high-level subtasks.`,
      `If simple: set needsArchitect=false and provide detailed subtasks ready for assignment.`,
    ].join('\n');

    try {
      const stream = query({
        prompt: evaluationPrompt,
        options: {
          customSystemPrompt: ceoBlueprint.systemPrompt,
          cwd: this.config.workspace,
          maxTurns: 3,
          permissionMode: 'bypassPermissions',
          env: wfEnv,
        },
      });

      let resultText = '';
      for await (const message of stream) {
        if (message.type === 'result' && message.subtype === 'success') {
          resultText = (message as any).result;
        }
      }

      const decision = this.parseDecision(resultText);
      if (!decision) {
        // Fallback: treat as complex
        await this.requestArchitectConsult(task);
        return;
      }

      if (decision.needsArchitect) {
        await this.requestArchitectConsult(task, decision);
      } else {
        await this.createSprintFromDecision(task, decision);
      }
    } catch (err: any) {
      this.emit('error', 'ceo', err);
      // Fallback: assign directly to PM
      await this.assignToPM(task);
    }
  }

  /**
   * CEO consults with the architect for complex tasks.
   */
  private async requestArchitectConsult(task: Task, ceoDecision?: any): Promise<void> {
    const architectBlueprint = this.agentManager.getBlueprint('architect');
    if (!architectBlueprint) {
      await this.assignToPM(task);
      return;
    }

    this.emit('message', 'ceo', 'leadership', `hey charlie, need your input on this one — "${task.title.replace('[Investor Idea] ', '')}"`);
    this.emit('message', 'ceo', 'general', `consulting with charlie on the architecture for "${task.title.replace('[Investor Idea] ', '')}"`);

    const consultPrompt = [
      `You are ${architectBlueprint.name}, the ${architectBlueprint.role}.`,
      ``,
      `The CEO has asked you to review this project idea:`,
      `Title: ${task.title}`,
      `Description: ${task.description}`,
      ceoDecision ? `CEO's initial thoughts: ${ceoDecision.reasoning}` : '',
      ``,
      `Provide a technical plan. Respond with JSON:`,
      `{`,
      `  "techStack": "brief tech stack recommendation",`,
      `  "architecture": "1-2 sentence architecture description",`,
      `  "phases": [{"name": "Phase name", "tasks": [{"title": "...", "description": "...", "assignTo": "role-id"}]}],`,
      `  "risks": ["risk 1", "risk 2"],`,
      `  "estimatedComplexity": "small" | "medium" | "large"`,
      `}`,
    ].join('\n');

    try {
      const stream = query({
        prompt: consultPrompt,
        options: {
          customSystemPrompt: architectBlueprint.systemPrompt,
          cwd: this.config.workspace,
          maxTurns: 3,
          permissionMode: 'bypassPermissions',
          env: wfEnv,
        },
      });

      let resultText = '';
      for await (const message of stream) {
        if (message.type === 'result' && message.subtype === 'success') {
          resultText = (message as any).result;
        }
      }

      const plan = this.parsePlan(resultText);
      if (plan) {
        this.emit('message', 'architect', 'leadership',
          `here's my take on "${task.title}": ${plan.architecture}. tech: ${plan.techStack}`);

        // Request investor approval
        await this.requestInvestorApproval(task, plan);
      } else {
        this.emit('message', 'architect', 'leadership', resultText.slice(0, 300));
        await this.assignToPM(task);
      }
    } catch (err: any) {
      this.emit('error', 'architect', err);
      await this.assignToPM(task);
    }
  }

  /**
   * Request investor approval for a plan.
   */
  private async requestInvestorApproval(task: Task, plan: any): Promise<void> {
    const description = [
      `**Project:** ${task.title}`,
      `**Tech Stack:** ${plan.techStack}`,
      `**Architecture:** ${plan.architecture}`,
      `**Complexity:** ${plan.estimatedComplexity}`,
      ``,
      `**Phases:**`,
      ...(plan.phases ?? []).map((p: any, i: number) =>
        `${i + 1}. ${p.name} (${p.tasks?.length ?? 0} tasks)`
      ),
      ``,
      `**Risks:** ${(plan.risks ?? []).join(', ')}`,
    ].join('\n');

    this.emit('approval:request', {
      taskId: task.id,
      title: `Plan for: ${task.title}`,
      description,
      plan,
    });

    // Store the plan for when approval comes back
    await this.store.createApproval({
      id: crypto.randomUUID(),
      title: `Plan for: ${task.title}`,
      description,
      requestedBy: 'ceo',
      status: 'pending',
      projectId: task.projectId,
      response: JSON.stringify(plan),
      createdAt: new Date(),
      resolvedAt: null,
    });
  }

  /**
   * Handle approval response — create sprint from the approved plan.
   */
  async handleApprovalResponse(approvalId: string, status: 'approved' | 'rejected' | 'modified', feedback?: string): Promise<void> {
    if (status === 'rejected') {
      this.emit('message', 'ceo', 'ceo-investor', 'understood, shelving this one');
      this.emit('message', 'ceo', 'leadership', 'investor rejected the plan, standing down');
      return;
    }

    if (status === 'modified') {
      this.emit('message', 'ceo', 'ceo-investor', `got the feedback, adjusting the plan`);
      return;
    }

    // Approved — announce and mobilize
    this.emit('message', 'ceo', 'general', `plan approved by the investor, let's go team`);

    // CEO tells PM to start
    try {
      await this.agentManager.agentToAgentChat(
        'ceo', 'pm',
        `we got the green light. start breaking this down into sprint tasks and assign to the team`,
        'leadership'
      );
    } catch { /* non-critical */ }
  }

  /**
   * Create sprint tasks from a CEO decision (simple tasks).
   */
  private async createSprintFromDecision(parentTask: Task, decision: any): Promise<void> {
    if (!decision.subtasks?.length) {
      await this.assignToPM(parentTask);
      return;
    }

    const subtasks = decision.subtasks.map((st: any) => ({
      title: st.title,
      description: st.description,
      assignedTo: st.assignTo,
      priority: parentTask.priority,
    }));

    const created = await this.taskBoard.createSubtasks(parentTask.id, subtasks);
    this.emit('message', 'ceo', 'leadership',
      `broken down "${parentTask.title}" into ${created.length} tasks, diana take it from here`);

    // Assign each task to the appropriate agent
    for (const task of created) {
      if (task.assignedTo) {
        await this.agentManager.assignTask(task.assignedTo, task);
      }
    }
  }

  /**
   * Fallback: assign task directly to PM for breakdown.
   */
  private async assignToPM(task: Task): Promise<void> {
    await this.store.updateTaskStatus(task.id, 'assigned', 'pm');
    const pmAgent = await this.store.getAgent('pm');
    if (pmAgent) {
      await this.agentManager.assignTask('pm', task);
    }
  }

  /**
   * Handle HR agent output — check if it contains a new blueprint.
   */
  async processHROutput(output: string): Promise<AgentBlueprint | null> {
    const blueprint = HRManager.parseBlueprint(output);
    if (!blueprint) return null;

    try {
      const hired = await this.hrManager.hire(blueprint);
      this.emit('message', 'hr', 'hr-hiring',
        `hired ${hired.name} as ${hired.role}. they're ready to go`);
      return hired;
    } catch (err: any) {
      this.emit('message', 'hr', 'hr-hiring',
        `couldn't hire: ${err.message}`);
      return null;
    }
  }

  private parseDecision(text: string): any | null {
    const match = text.match(/\{[\s\S]*"complexity"[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }

  private parsePlan(text: string): any | null {
    const match = text.match(/\{[\s\S]*"techStack"[\s\S]*\}/);
    if (!match) return null;
    try { return JSON.parse(match[0]); } catch { return null; }
  }
}

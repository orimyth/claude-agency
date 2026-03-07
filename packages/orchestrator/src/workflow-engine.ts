import { query } from '@anthropic-ai/claude-code';
import type { AgentManager } from './agent-manager.js';
import type { StateStore } from './state-store.js';
import type { TaskBoard } from './task-board.js';
import { HRManager } from './hr-manager.js';
import type { AgentBlueprint, Task, AgencyConfig } from './types.js';
import { EventEmitter } from 'events';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

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

  private resolveWorkDir(): string {
    let workDir = this.config.workspace;
    if (!workDir.startsWith('/')) {
      workDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..', workDir);
    }
    return workDir;
  }

  /**
   * CEO evaluates a new idea.
   * Now the CEO gets agency tools so they can create projects/tasks directly,
   * rather than us parsing JSON from their output.
   */
  async evaluateIdea(task: Task): Promise<void> {
    const ceoBlueprint = this.agentManager.getBlueprint('ceo');
    if (!ceoBlueprint) return;

    // Get the list of available agents for the CEO
    const agents = this.agentManager.getAllBlueprints();
    const agentList = agents
      .filter(a => a.id !== 'ceo')
      .map(a => `- ${a.id}: ${a.name} (${a.role})`)
      .join('\n');

    const apiUrl = `http://localhost:${this.config.wsPort + 1}`;

    const evaluationPrompt = [
      `You are ${ceoBlueprint.name}, the ${ceoBlueprint.role}.`,
      ``,
      `A new idea has been submitted by the investor:`,
      `Title: ${task.title}`,
      `Description: ${task.description}`,
      ``,
      `## Available Team Members`,
      agentList,
      ``,
      `## Agency API (use via curl in Bash)`,
      `- Create project: curl -s -X POST ${apiUrl}/api/agency/projects -H 'Content-Type: application/json' -d '{"name":"...","description":"..."}'`,
      `- Add repo: curl -s -X POST ${apiUrl}/api/agency/repositories -H 'Content-Type: application/json' -d '{"projectId":"...","repoUrl":"..."}'`,
      `- Clone repo: curl -s -X POST ${apiUrl}/api/agency/repositories/{repoId}/clone`,
      `- Create task: curl -s -X POST ${apiUrl}/api/agency/tasks -H 'Content-Type: application/json' -d '{"projectId":"...","title":"...","description":"...","assignTo":"developer","priority":7}'`,
      `- List agents: curl -s ${apiUrl}/api/agents`,
      ``,
      `## Your Job`,
      `Evaluate this idea and take action:`,
      `1. Create a project via the API`,
      `2. Break it down into tasks and assign to the right agents via the API`,
      `3. For complex projects, create an architecture task for Charlie first`,
      `4. For simple tasks, assign directly to the right developer/designer`,
      ``,
      `Take action now. Use curl to call the Agency API.`,
    ].join('\n');

    try {
      const stream = query({
        prompt: evaluationPrompt,
        options: {
          model: 'claude-opus-4-6',
          customSystemPrompt: ceoBlueprint.systemPrompt,
          cwd: this.resolveWorkDir(),
          allowedTools: ['Bash'],
          maxTurns: 15,
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

      // Announce completion
      if (resultText) {
        this.emit('message', 'ceo', 'leadership', resultText.slice(0, 300));
      }

      // Mark the original idea task as done
      await this.store.updateTaskStatus(task.id, 'done');
    } catch (err: any) {
      this.emit('error', 'ceo', err);
      // Fallback: assign directly to PM
      await this.assignToPM(task);
    }
  }

  /**
   * Handle approval response — on approve, CEO creates tasks.
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

    // Approved — CEO should now create sprint tasks
    this.emit('message', 'ceo', 'general', `plan approved by the investor, let's go team`);

    // Create a task for the PM to start sprint planning with agency tools
    const pmTask: Task = {
      id: crypto.randomUUID(),
      title: 'Sprint planning for approved project',
      description: [
        `The investor just approved a project plan.`,
        feedback ? `Feedback: ${feedback}` : '',
        ``,
        `Break down the work into concrete tasks and assign them to the team.`,
        `Use agency_create_task to create tasks and assign them.`,
        `Use agency_list_agents to see who's available.`,
      ].filter(Boolean).join('\n'),
      status: 'assigned',
      projectId: null,
      assignedTo: 'pm',
      createdBy: 'ceo',
      parentTaskId: null,
      dependsOn: null,
      priority: 9,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(pmTask);
    await this.agentManager.assignTask('pm', pmTask);
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
}

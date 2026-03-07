import type { AgentManager } from './agent-manager.js';
import type { StateStore } from './state-store.js';
import type { TaskBoard } from './task-board.js';
import { HRManager } from './hr-manager.js';
import type { AgentBlueprint, Task, AgencyConfig } from './types.js';
import { EventEmitter } from 'events';

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
      deadline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(pmTask);
    await this.agentManager.assignTask('pm', pmTask);
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

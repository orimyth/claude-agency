import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { Task } from './types.js';

/**
 * Routes incoming tasks/ideas from the investor to the CEO agent.
 * The CEO then decides how to handle it (direct assignment vs. architect consultation).
 */
export class TaskRouter {
  private store: StateStore;
  private agentManager: AgentManager;

  constructor(store: StateStore, agentManager: AgentManager) {
    this.store = store;
    this.agentManager = agentManager;
  }

  /**
   * Submit a new idea/task from the investor.
   * Creates a project and routes the initial task to the CEO.
   */
  async submitIdea(title: string, description: string): Promise<{ taskId: string }> {
    const taskId = crypto.randomUUID();

    // Create a task for the CEO (no project yet — CEO decides if it needs one)
    const task: Task = {
      id: taskId,
      title: `[Investor Idea] ${title}`,
      description: [
        `The investor has submitted a new idea:`,
        ``,
        `"${description}"`,
        ``,
        `As CEO, evaluate this idea:`,
        `1. If it's straightforward, break it into tasks and assign to the team`,
        `2. If it's complex, consult with Charlie (architect) and create a plan for investor approval`,
        `3. Create subtasks and assign them to the right agents`,
      ].join('\n'),
      status: 'assigned',
      projectId: null,
      assignedTo: 'ceo',
      createdBy: 'investor',
      parentTaskId: null,
      dependsOn: null,
      priority: 10,
      deadline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);
    await this.agentManager.assignTask('ceo', task);

    return { taskId };
  }
}

import type { StateStore } from './state-store.js';
import type { Task, TaskStatus } from './types.js';

/**
 * Valid state transitions for tasks.
 */
const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  backlog: ['assigned', 'queued', 'done', 'cancelled'],
  queued: ['in_progress', 'backlog', 'blocked', 'cancelled'],
  assigned: ['in_progress', 'queued', 'backlog', 'blocked', 'cancelled'],
  in_progress: ['verifying', 'review', 'done', 'blocked', 'assigned', 'cancelled'],
  verifying: ['review', 'done', 'in_progress', 'blocked'],
  review: ['done', 'in_progress', 'assigned', 'cancelled'],
  done: [],
  blocked: ['assigned', 'queued', 'backlog', 'in_progress', 'cancelled'],
  cancelled: ['backlog'],
};

export class TaskBoard {
  private store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  async transition(taskId: string, newStatus: TaskStatus, assignedTo?: string): Promise<Task> {
    const task = await this.store.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    const allowed = VALID_TRANSITIONS[task.status];
    if (!allowed.includes(newStatus)) {
      throw new Error(`Invalid transition: ${task.status} → ${newStatus}. Allowed: ${allowed.join(', ')}`);
    }

    await this.store.updateTaskStatus(taskId, newStatus, assignedTo);
    const updated = await this.store.getTask(taskId);
    return updated!;
  }

  async createSubtasks(parentTaskId: string, subtasks: { title: string; description: string; assignedTo?: string; priority?: number }[]): Promise<Task[]> {
    const parent = await this.store.getTask(parentTaskId);
    if (!parent) throw new Error(`Parent task ${parentTaskId} not found`);

    const created: Task[] = [];
    for (const sub of subtasks) {
      const task: Task = {
        id: crypto.randomUUID(),
        title: sub.title,
        description: sub.description,
        status: sub.assignedTo ? 'assigned' : 'backlog',
        projectId: parent.projectId,
        assignedTo: sub.assignedTo ?? null,
        createdBy: parent.assignedTo ?? 'system',
        parentTaskId,
        dependsOn: null,
        priority: sub.priority ?? parent.priority,
        deadline: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      await this.store.createTask(task);
      created.push(task);
    }
    return created;
  }

  async getProjectBoard(projectId: string): Promise<Record<TaskStatus, Task[]>> {
    const tasks = await this.store.getTasksByProject(projectId);
    const board: Record<TaskStatus, Task[]> = {
      backlog: [],
      queued: [],
      assigned: [],
      in_progress: [],
      verifying: [],
      review: [],
      done: [],
      blocked: [],
      cancelled: [],
    };
    for (const task of tasks) {
      board[task.status].push(task);
    }
    return board;
  }

  async getAgentWorkload(agentId: string): Promise<{ active: number; queued: number; completed: number }> {
    const tasks = await this.store.getTasksByAgent(agentId);
    return {
      active: tasks.filter(t => t.status === 'in_progress').length,
      queued: tasks.filter(t => t.status === 'assigned' || t.status === 'queued').length,
      completed: tasks.filter(t => t.status === 'done').length,
    };
  }
}

import { EventEmitter } from 'events';

export type NotificationType =
  | 'task_started'
  | 'task_completed'
  | 'task_blocked'
  | 'task_cancelled'
  | 'verification_pass'
  | 'verification_fail'
  | 'merge_complete'
  | 'merge_failed'
  | 'merge_rollback'
  | 'project_created'
  | 'project_completed'
  | 'agent_hired'
  | 'agent_retired'
  | 'agent_paused'
  | 'agent_error'
  | 'cost_alert'
  | 'budget_exceeded'
  | 'system_error'
  | 'system_alert';

export interface Notification {
  type: NotificationType;
  agentId?: string;
  taskId?: string;
  projectId?: string;
  summary: string;
  details?: Record<string, unknown>;
  timestamp: Date;
}

interface WSBroadcaster {
  broadcast(event: string, data: unknown): void;
}

interface SlackBridge {
  sendToChannel(channel: string, message: string): Promise<void>;
}

/**
 * Unified notification service.
 * All notifications go through here — WebSocket always, Slack optionally.
 */
export class NotificationService extends EventEmitter {
  private ws: WSBroadcaster;
  private slack: SlackBridge | null = null;

  constructor(ws: WSBroadcaster) {
    super();
    this.ws = ws;
  }

  setSlackBridge(slack: SlackBridge): void {
    this.slack = slack;
  }

  async send(notification: Notification): Promise<void> {
    // Always: broadcast to dashboard via WebSocket
    this.ws.broadcast(`notification:${notification.type}`, notification);

    // Always: emit for internal listeners (audit log, etc.)
    this.emit('notification', notification);

    // Optional: send to Slack
    if (this.slack) {
      const channel = this.routeToSlackChannel(notification);
      if (channel) {
        try {
          await this.slack.sendToChannel(channel, notification.summary);
        } catch {
          // Slack failures are non-fatal
        }
      }
    }
  }

  // Convenience methods

  async taskStarted(agentId: string, taskId: string, taskTitle: string, projectId?: string): Promise<void> {
    await this.send({
      type: 'task_started',
      agentId,
      taskId,
      projectId,
      summary: `${agentId} started: ${taskTitle}`,
      timestamp: new Date(),
    });
  }

  async taskCompleted(agentId: string, taskId: string, taskTitle: string, projectId?: string): Promise<void> {
    await this.send({
      type: 'task_completed',
      agentId,
      taskId,
      projectId,
      summary: `${agentId} completed: ${taskTitle}`,
      timestamp: new Date(),
    });
  }

  async taskBlocked(agentId: string, taskId: string, taskTitle: string, reason: string): Promise<void> {
    await this.send({
      type: 'task_blocked',
      agentId,
      taskId,
      summary: `${agentId} blocked on "${taskTitle}": ${reason}`,
      details: { reason },
      timestamp: new Date(),
    });
  }

  async verificationFailed(taskId: string, taskTitle: string, failures: string): Promise<void> {
    await this.send({
      type: 'verification_fail',
      taskId,
      summary: `Checks failed for "${taskTitle}"`,
      details: { failures },
      timestamp: new Date(),
    });
  }

  async mergeComplete(taskId: string, branch: string, projectId?: string): Promise<void> {
    await this.send({
      type: 'merge_complete',
      taskId,
      projectId,
      summary: `Merged ${branch} to main`,
      timestamp: new Date(),
    });
  }

  async mergeRollback(taskId: string, branch: string, reason: string): Promise<void> {
    await this.send({
      type: 'merge_rollback',
      taskId,
      summary: `Rolled back merge of ${branch}: ${reason}`,
      details: { reason },
      timestamp: new Date(),
    });
  }

  async costAlert(projectId: string, spent: number, budget: number): Promise<void> {
    const pct = Math.round((spent / budget) * 100);
    await this.send({
      type: 'cost_alert',
      projectId,
      summary: `Budget alert: ${pct}% used ($${spent.toFixed(2)} / $${budget.toFixed(2)})`,
      details: { spent, budget, percentage: pct },
      timestamp: new Date(),
    });
  }

  async systemAlert(message: string): Promise<void> {
    await this.send({
      type: 'system_alert',
      summary: message,
      timestamp: new Date(),
    });
  }

  private routeToSlackChannel(notification: Notification): string | null {
    switch (notification.type) {
      case 'task_started':
      case 'task_completed':
      case 'task_blocked':
      case 'verification_pass':
      case 'verification_fail':
      case 'merge_complete':
      case 'merge_failed':
      case 'merge_rollback':
        return notification.projectId ? `project-${notification.projectId}` : 'general';

      case 'project_created':
      case 'project_completed':
        return 'general';

      case 'agent_hired':
      case 'agent_retired':
        return 'hr-hiring';

      case 'cost_alert':
      case 'budget_exceeded':
      case 'system_error':
      case 'system_alert':
      case 'agent_error':
        return 'alerts';

      default:
        return 'general';
    }
  }
}

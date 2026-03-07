import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { NotificationService } from './notification.js';

/**
 * CEO Autonomous Loop — event-driven oversight.
 *
 * The orchestrator checks DB conditions cheaply (zero token cost).
 * Only invokes Alice (CEO agent) when something actually needs attention:
 *   - Project completed → investor report
 *   - Task blocked >30min → escalation
 *   - Budget >80% → alert
 *   - 4h status interval → periodic update
 *   - Weekly digest → summary
 *
 * This is NOT a polling agent. It's a background timer that queries the DB
 * and triggers CEO actions only when conditions are met.
 */
export class CEOLoop {
  private store: StateStore;
  private agentManager: AgentManager;
  private notifications: NotificationService;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastStatusAt = 0;
  private lastDigestAt = 0;
  private checkIntervalMs: number;
  /** Track already-reported blocked tasks to avoid spamming */
  private reportedBlocked = new Set<string>();

  constructor(
    store: StateStore,
    agentManager: AgentManager,
    notifications: NotificationService,
    checkIntervalMs = 5 * 60_000, // Check every 5 min
  ) {
    this.store = store;
    this.agentManager = agentManager;
    this.notifications = notifications;
    this.checkIntervalMs = checkIntervalMs;
  }

  start(): void {
    if (this.interval) return;
    this.lastStatusAt = Date.now();
    this.lastDigestAt = Date.now();
    this.interval = setInterval(() => this.check(), this.checkIntervalMs);
    // Initial check after 30s (let system stabilize first)
    setTimeout(() => this.check(), 30_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<void> {
    try {
      // Record heartbeat for watchdog
      await this.recordHeartbeat();

      // Check triggers in priority order
      await this.checkCompletedProjects();
      await this.checkBlockedTasks();
      await this.checkBudgetAlerts();
      await this.checkPeriodicStatus();
    } catch (err: any) {
      console.error('[CEOLoop] Check failed:', err.message);
    }
  }

  private async recordHeartbeat(): Promise<void> {
    try {
      await this.store.query(
        `INSERT INTO settings (\`key\`, value) VALUES ('ceo_loop_last_run', ?)
         ON DUPLICATE KEY UPDATE value = ?`,
        [JSON.stringify(Date.now()), JSON.stringify(Date.now())],
      );
    } catch {
      // Settings table may not exist yet
    }
  }

  /**
   * Trigger: Project completed → CEO reports to investor.
   */
  private async checkCompletedProjects(): Promise<void> {
    try {
      const rows = await this.store.query(`
        SELECT id, name FROM projects
        WHERE status = 'completed'
          AND updated_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)
        LIMIT 5
      `);

      for (const project of rows) {
        const message = `Project "${project.name}" is complete. I'll prepare a summary for the investor.`;
        this.agentManager.notify('ceo', 'leadership', message);

        // Ask CEO to write a project completion report
        try {
          const report = await this.agentManager.chat(
            'ceo',
            `Project "${project.name}" just completed. Write a brief investor update (2-3 sentences) summarizing what was delivered.`,
            undefined,
            'ceo-investor',
          );
          this.agentManager.notify('ceo', 'ceo-investor', report);
        } catch {
          // Non-fatal — CEO might be busy
        }
      }
    } catch {
      // Query may fail if table doesn't have expected columns
    }
  }

  /**
   * Trigger: Task blocked >30min → CEO escalation.
   */
  private async checkBlockedTasks(): Promise<void> {
    try {
      const rows = await this.store.query(`
        SELECT t.id, t.title, t.assigned_to, t.project_id, t.updated_at
        FROM tasks t
        WHERE t.status = 'blocked'
          AND t.updated_at < DATE_SUB(NOW(), INTERVAL 30 MINUTE)
        LIMIT 10
      `);

      for (const task of rows) {
        if (this.reportedBlocked.has(task.id)) continue;
        this.reportedBlocked.add(task.id);

        const agentName = task.assigned_to
          ? (this.agentManager.getBlueprint(task.assigned_to)?.name ?? task.assigned_to)
          : 'unassigned';
        const channel = task.project_id ? `project-${task.project_id}` : 'leadership';

        this.agentManager.notify('ceo', channel,
          `heads up: "${task.title}" has been blocked for 30+ min (${agentName}). looking into it`);

        // Ask CEO to evaluate and decide action
        try {
          await this.agentManager.chat(
            'ceo',
            `Task "${task.title}" assigned to ${agentName} has been blocked for over 30 minutes. Check what's blocking it via the API and decide: reassign, unblock, or escalate. Keep your response to 1-2 sentences.`,
            undefined,
            'leadership',
          );
        } catch {
          // Non-fatal
        }
      }

      // Clean up resolved blocks from tracking set
      const currentBlocked = new Set(rows.map((r: any) => r.id));
      for (const id of this.reportedBlocked) {
        if (!currentBlocked.has(id)) {
          this.reportedBlocked.delete(id);
        }
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Trigger: Project budget >80% → alert.
   */
  private async checkBudgetAlerts(): Promise<void> {
    try {
      const rows = await this.store.query(`
        SELECT id, name, budget_usd, spent_usd
        FROM projects
        WHERE budget_usd IS NOT NULL
          AND budget_usd > 0
          AND spent_usd / budget_usd > 0.8
          AND status = 'active'
        LIMIT 5
      `);

      for (const project of rows) {
        const pct = Math.round((project.spent_usd / project.budget_usd) * 100);
        if (pct >= 100) {
          this.agentManager.notify('ceo', 'leadership',
            `budget exceeded on "${project.name}": $${project.spent_usd.toFixed(2)} / $${project.budget_usd.toFixed(2)} (${pct}%)`);
          this.notifications.costAlert(project.id, project.spent_usd, project.budget_usd);
        } else {
          this.agentManager.notify('ceo', 'leadership',
            `budget warning on "${project.name}": ${pct}% used ($${project.spent_usd.toFixed(2)} / $${project.budget_usd.toFixed(2)})`);
        }
      }
    } catch {
      // Budget columns may not exist yet
    }
  }

  /**
   * Trigger: 4-hour interval → periodic status update.
   */
  private async checkPeriodicStatus(): Promise<void> {
    const STATUS_INTERVAL_MS = 4 * 60 * 60_000; // 4 hours
    const now = Date.now();

    if (now - this.lastStatusAt < STATUS_INTERVAL_MS) return;
    this.lastStatusAt = now;

    try {
      const agents = await this.store.getAllAgents();
      const tasks = await this.store.getAllTasks(200);

      const active = agents.filter(a => a.status === 'active').length;
      const idle = agents.filter(a => a.status === 'idle').length;
      const inProgress = tasks.filter(t => t.status === 'in_progress').length;
      const done = tasks.filter(t => t.status === 'done').length;
      const blocked = tasks.filter(t => t.status === 'blocked').length;
      const pending = tasks.filter(t => ['backlog', 'queued', 'assigned'].includes(t.status)).length;

      // Only invoke CEO if there's activity worth reporting
      if (active > 0 || inProgress > 0 || blocked > 0) {
        const statusMsg = [
          `4h status: ${active} agents active, ${idle} idle.`,
          `Tasks: ${inProgress} in progress, ${done} done, ${blocked} blocked, ${pending} pending.`,
        ].join(' ');

        this.agentManager.notify('ceo', 'leadership', statusMsg);
      }
    } catch {
      // Non-fatal
    }
  }
}

import type { StateStore } from './state-store.js';
import type { NotificationService } from './notification.js';
import { Logger } from './logger.js';

const log = new Logger({ component: 'watchdog' });

/**
 * System-level watchdog that monitors overall health.
 * Runs as a background loop in the orchestrator — NOT an agent.
 * Independent of all agents — if every agent crashes, watchdog still runs.
 */
export class Watchdog {
  private store: StateStore;
  private notifications: NotificationService;
  private interval: ReturnType<typeof setInterval> | null = null;
  private checkIntervalMs: number;

  constructor(store: StateStore, notifications: NotificationService, checkIntervalMs = 120_000) {
    this.store = store;
    this.notifications = notifications;
    this.checkIntervalMs = checkIntervalMs;
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), this.checkIntervalMs);
    // Run initial check after a short delay
    setTimeout(() => this.check(), 5000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<void> {
    try {
      await this.checkLoopHeartbeats();
      await this.checkOrphanedTasks();
      await this.checkStuckAgents();
      await this.checkStuckTasks();
      await this.checkDbHealth();
    } catch (err: any) {
      log.error('Check failed', { error: err.message });
    }
  }

  /**
   * Check if CEO/HR autonomous loops are running.
   * Each loop writes a heartbeat timestamp to the config table.
   */
  private async checkLoopHeartbeats(): Promise<void> {
    const loops = ['ceo_loop_last_run', 'hr_loop_last_run'];
    const staleThresholdMs = 35 * 60_000; // 35 min for CEO (runs every 5 min, generous buffer)

    for (const key of loops) {
      try {
        const rows = await this.store.query(
          'SELECT value FROM settings WHERE `key` = ?',
          [key],
        );
        if (rows.length > 0) {
          const lastRun = Number(JSON.parse(rows[0].value));
          if (lastRun && Date.now() - lastRun > staleThresholdMs) {
            const loopName = key.replace('_loop_last_run', '').toUpperCase();
            log.warn(`${loopName} loop stalled`, { lastRun: new Date(lastRun).toISOString() });
            await this.notifications.systemAlert(
              `${loopName} oversight loop hasn't run in ${Math.round((Date.now() - lastRun) / 60_000)} minutes`,
            );
          }
        }
      } catch {
        // Config key may not exist yet — that's fine on first boot
      }
    }
  }

  /**
   * Find tasks assigned to agents that don't exist (retired, deleted).
   */
  private async checkOrphanedTasks(): Promise<void> {
    try {
      const orphaned = await this.store.query(`
        SELECT t.id, t.title, t.assigned_to
        FROM tasks t
        LEFT JOIN agents a ON t.assigned_to = a.id
        WHERE t.status IN ('assigned', 'queued', 'in_progress')
          AND t.assigned_to IS NOT NULL
          AND a.id IS NULL
        LIMIT 10
      `);

      for (const task of orphaned) {
        log.warn('Orphaned task', { taskId: task.id, title: task.title, assignedTo: task.assigned_to });
        await this.store.updateTaskStatus(task.id, 'backlog');
        await this.notifications.systemAlert(
          `Orphaned task "${task.title}" returned to backlog (agent ${task.assigned_to} not found)`,
        );
      }
    } catch {
      // Table structure may not support this query yet
    }
  }

  /**
   * Check for agents stuck in 'active' status for too long.
   */
  private async checkStuckAgents(): Promise<void> {
    try {
      const stuckMinutes = 90;
      const stuck = await this.store.query(`
        SELECT id, blueprint_id, current_task_id, last_active_at
        FROM agents
        WHERE status = 'active'
          AND last_active_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
      `, [stuckMinutes]);

      for (const agent of stuck) {
        log.warn('Agent stuck in active', { agentId: agent.id, blueprintId: agent.blueprint_id, minutes: stuckMinutes });
        await this.notifications.systemAlert(
          `Agent ${agent.blueprint_id} has been active for ${stuckMinutes}+ minutes without completing`,
        );
      }
    } catch {
      // Column names may differ
    }
  }

  /**
   * Detect tasks stuck in 'in_progress' for too long without updates.
   */
  private async checkStuckTasks(): Promise<void> {
    try {
      const stuckMinutes = 60;
      const stuck = await this.store.query(`
        SELECT t.id, t.title, t.assigned_to, t.updated_at
        FROM tasks t
        WHERE t.status = 'in_progress'
          AND t.updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)
        LIMIT 10
      `, [stuckMinutes]);

      for (const task of stuck) {
        const minsStuck = Math.round((Date.now() - new Date(task.updated_at).getTime()) / 60_000);
        log.warn('Stuck task detected', {
          taskId: task.id,
          title: task.title,
          assignedTo: task.assigned_to,
          minutesStuck: minsStuck,
        });
        await this.notifications.systemAlert(
          `Task "${task.title}" has been in_progress for ${minsStuck}min without updates (assigned to ${task.assigned_to ?? 'nobody'})`,
        );
      }
    } catch {
      // Table structure may not support this query yet
    }
  }

  /**
   * Basic DB health check.
   */
  private async checkDbHealth(): Promise<void> {
    try {
      const start = Date.now();
      await this.store.query('SELECT 1');
      const latencyMs = Date.now() - start;
      if (latencyMs > 1000) {
        log.warn('High DB latency', { latencyMs });
      }
    } catch (err: any) {
      log.error('DB health check failed', { error: err.message });
      await this.notifications.systemAlert('Database health check failed');
    }
  }
}

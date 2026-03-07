import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { NotificationService } from './notification.js';

/**
 * HR Autonomous Loop — workforce management.
 *
 * Event-driven checks (zero token cost when idle):
 *   - Workload imbalance: too many queued tasks for a role → recommend hiring
 *   - Idle agents: agent with no tasks for extended period → recommend retiring
 *   - Skill gaps: tasks assigned to roles that don't exist → flag
 *   - Agent health: consecutive failures → auto-pause + notification
 *
 * Guardrails:
 *   - Max agents: won't recommend hiring past configurable limit (default: 15)
 *   - Cooldown: minimum 30 min between hire recommendations
 *   - Template-only: can only hire from existing blueprint templates
 */
export class HRLoop {
  private store: StateStore;
  private agentManager: AgentManager;
  private notifications: NotificationService;
  private interval: ReturnType<typeof setInterval> | null = null;
  private checkIntervalMs: number;
  private maxAgents: number;
  private lastHireRecommendationAt = 0;
  private hireCooldownMs: number;

  constructor(
    store: StateStore,
    agentManager: AgentManager,
    notifications: NotificationService,
    opts: {
      checkIntervalMs?: number;
      maxAgents?: number;
      hireCooldownMs?: number;
    } = {},
  ) {
    this.store = store;
    this.agentManager = agentManager;
    this.notifications = notifications;
    this.checkIntervalMs = opts.checkIntervalMs ?? 10 * 60_000; // 10 min
    this.maxAgents = opts.maxAgents ?? 15;
    this.hireCooldownMs = opts.hireCooldownMs ?? 30 * 60_000; // 30 min
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.check(), this.checkIntervalMs);
    // Initial check after 60s
    setTimeout(() => this.check(), 60_000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async check(): Promise<void> {
    try {
      await this.recordHeartbeat();
      await this.checkWorkloadImbalance();
      await this.checkIdleAgents();
      await this.checkAgentHealth();
      await this.checkSkillGaps();
    } catch (err: any) {
      console.error('[HRLoop] Check failed:', err.message);
    }
  }

  private async recordHeartbeat(): Promise<void> {
    try {
      await this.store.query(
        `INSERT INTO settings (\`key\`, value) VALUES ('hr_loop_last_run', ?)
         ON DUPLICATE KEY UPDATE value = ?`,
        [JSON.stringify(Date.now()), JSON.stringify(Date.now())],
      );
    } catch {
      // Settings table may not exist yet
    }
  }

  /**
   * Check if any role has too many queued tasks relative to available agents.
   * Threshold: 5+ queued tasks for a role with only 1 agent → recommend hire.
   */
  private async checkWorkloadImbalance(): Promise<void> {
    const now = Date.now();
    if (now - this.lastHireRecommendationAt < this.hireCooldownMs) return;

    try {
      // Count active agents
      const agents = await this.store.getAllAgents();
      if (agents.length >= this.maxAgents) return;

      // Count queued tasks per assigned agent
      const rows = await this.store.query(`
        SELECT assigned_to, COUNT(*) as queued_count
        FROM tasks
        WHERE status IN ('queued', 'assigned', 'backlog')
          AND assigned_to IS NOT NULL
        GROUP BY assigned_to
        HAVING queued_count >= 5
        ORDER BY queued_count DESC
        LIMIT 3
      `);

      for (const row of rows) {
        const agentId = row.assigned_to;
        const blueprint = this.agentManager.getBlueprint(agentId);
        if (!blueprint) continue;

        // Check if there are already multiple agents with this role
        const sameRoleAgents = agents.filter(a => {
          const bp = this.agentManager.getBlueprint(a.id);
          return bp && bp.role === blueprint.role;
        });

        if (sameRoleAgents.length >= 3) continue; // Already have 3 of this role

        this.lastHireRecommendationAt = now;
        const message = `workload alert: ${blueprint.name} has ${row.queued_count} queued tasks. consider hiring another ${blueprint.role}`;
        this.agentManager.notify('hr', 'hr-hiring', message);
        this.agentManager.notify('hr', 'leadership', message);
        this.notifications.systemAlert(`HR recommendation: hire additional ${blueprint.role} (${row.queued_count} tasks queued for ${blueprint.name})`);
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Check for agents that have been idle with no tasks for >2 hours.
   * Recommend retirement to free resources.
   */
  private async checkIdleAgents(): Promise<void> {
    try {
      const rows = await this.store.query(`
        SELECT a.id, a.blueprint_id, a.last_active_at
        FROM agents a
        WHERE a.status = 'idle'
          AND a.last_active_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)
          AND NOT EXISTS (
            SELECT 1 FROM tasks t
            WHERE t.assigned_to = a.id
              AND t.status IN ('queued', 'assigned', 'in_progress')
          )
      `);

      for (const agent of rows) {
        const blueprint = this.agentManager.getBlueprint(agent.id);
        if (!blueprint) continue;

        // Don't recommend retiring core roles
        const coreRoles = new Set(['ceo', 'hr', 'pm', 'architect']);
        if (coreRoles.has(blueprint.id)) continue;

        const hoursIdle = Math.round((Date.now() - new Date(agent.last_active_at).getTime()) / (60 * 60_000));
        this.agentManager.notify('hr', 'hr-hiring',
          `${blueprint.name} has been idle for ${hoursIdle}h with no pending work. consider pausing or retiring`);
      }
    } catch {
      // Non-fatal
    }
  }

  /**
   * Check for agents with consecutive failures → auto-pause.
   */
  private async checkAgentHealth(): Promise<void> {
    try {
      // Check for agents with recent errors via KPI tracking
      const rows = await this.store.query(`
        SELECT agent_id, COUNT(*) as fail_count
        FROM agent_kpis
        WHERE metric = 'tasks_failed'
          AND recorded_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)
        GROUP BY agent_id
        HAVING fail_count >= 3
      `);

      for (const row of rows) {
        const blueprint = this.agentManager.getBlueprint(row.agent_id);
        if (!blueprint) continue;

        // Auto-pause the agent
        await this.agentManager.pauseAgent(row.agent_id);
        const message = `auto-paused ${blueprint.name}: ${row.fail_count} task failures in the last hour. needs investigation`;
        this.agentManager.notify('hr', 'leadership', message);
        this.notifications.systemAlert(message);
      }
    } catch {
      // Non-fatal — KPI table may not exist
    }
  }

  /**
   * Check for tasks assigned to agents/roles that don't have blueprints.
   */
  private async checkSkillGaps(): Promise<void> {
    try {
      const rows = await this.store.query(`
        SELECT DISTINCT assigned_to
        FROM tasks
        WHERE status IN ('queued', 'assigned', 'backlog')
          AND assigned_to IS NOT NULL
        LIMIT 50
      `);

      for (const row of rows) {
        const blueprint = this.agentManager.getBlueprint(row.assigned_to);
        if (!blueprint) {
          this.agentManager.notify('hr', 'hr-hiring',
            `skill gap: tasks assigned to "${row.assigned_to}" but no agent with that ID exists. need to hire or reassign`);
        }
      }
    } catch {
      // Non-fatal
    }
  }
}

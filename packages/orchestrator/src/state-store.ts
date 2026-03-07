import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { AgentState, Task, Project, ProjectRepository, Message, Approval, AgentBlueprint, AgencyConfig } from './types.js';

export class StateStore {
  private pool: Pool;
  private config: AgencyConfig['mysql'];

  constructor(config: AgencyConfig['mysql']) {
    this.config = config;
    this.pool = this.createPool(config);
  }

  private createPool(config: AgencyConfig['mysql']): Pool {
    return mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
      connectTimeout: 10_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 30_000,
    });
  }

  /**
   * Execute a query with automatic retry on connection errors.
   * Uses exponential backoff: 1s, 2s, 4s.
   */
  private async withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const isConnectionError = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' ||
          err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ER_CON_COUNT_ERROR' ||
          err.message?.includes('Connection lost');

        if (!isConnectionError || attempt === maxRetries - 1) throw err;

        const backoffMs = Math.pow(2, attempt) * 1000;
        console.warn(`[DB] Connection error (attempt ${attempt + 1}/${maxRetries}), retrying in ${backoffMs}ms: ${err.code ?? err.message}`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));

        // Recreate pool on persistent connection failures
        if (attempt >= 1) {
          try { await this.pool.end(); } catch { /* ignore */ }
          this.pool = this.createPool(this.config);
        }
      }
    }
    throw new Error('Unreachable');
  }

  async initialize(): Promise<void> {
    const conn = await this.pool.getConnection();
    try {
      await conn.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id VARCHAR(64) PRIMARY KEY,
          blueprint_id VARCHAR(64) NOT NULL,
          status ENUM('active','idle','paused','on_break','error') NOT NULL DEFAULT 'idle',
          current_task_id VARCHAR(64) NULL,
          last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          break_until DATETIME NULL,
          session_id VARCHAR(255) NULL
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS projects (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          slack_channel VARCHAR(128) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          status ENUM('created','active','paused','completed','cancelled','archived') NOT NULL DEFAULT 'active'
        )
      `);

      // Migration: drop workspace_path if it exists (moved to project_repositories)
      try { await conn.query(`ALTER TABLE projects DROP COLUMN workspace_path`); } catch { /* may not exist */ }

      await conn.query(`
        CREATE TABLE IF NOT EXISTS project_repositories (
          id VARCHAR(64) PRIMARY KEY,
          project_id VARCHAR(64) NOT NULL,
          repo_url VARCHAR(512) NOT NULL,
          repo_name VARCHAR(255) NOT NULL,
          local_path VARCHAR(512) NOT NULL,
          default_branch VARCHAR(128) NOT NULL DEFAULT 'main',
          current_branch VARCHAR(128) NULL,
          last_synced_at DATETIME NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_project (project_id)
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS blueprints (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(128) NOT NULL,
          role VARCHAR(128) NOT NULL,
          is_default BOOLEAN NOT NULL DEFAULT FALSE,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          blueprint_json TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      // Migration: move custom_blueprints data to blueprints if the old table exists
      try {
        const [oldRows] = await conn.query<RowDataPacket[]>('SELECT * FROM custom_blueprints');
        for (const row of oldRows) {
          try {
            const bp = JSON.parse(row.blueprint_json);
            await conn.query(
              `INSERT IGNORE INTO blueprints (id, name, role, is_default, active, blueprint_json) VALUES (?, ?, ?, FALSE, TRUE, ?)`,
              [row.id, bp.name ?? row.id, bp.role ?? 'Unknown', row.blueprint_json]
            );
          } catch { /* skip invalid */ }
        }
        await conn.query('DROP TABLE IF EXISTS custom_blueprints');
      } catch { /* table may not exist */ }

      await conn.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id VARCHAR(64) PRIMARY KEY,
          title VARCHAR(512) NOT NULL,
          description TEXT,
          status ENUM('backlog','queued','assigned','in_progress','verifying','review','done','blocked','cancelled') NOT NULL DEFAULT 'backlog',
          project_id VARCHAR(64) NULL,
          assigned_to VARCHAR(64) NULL,
          created_by VARCHAR(64) NOT NULL,
          parent_task_id VARCHAR(64) NULL,
          depends_on VARCHAR(64) NULL,
          priority INT NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      // Migration: make project_id nullable and drop FKs if table already existed
      try { await conn.query(`ALTER TABLE tasks DROP FOREIGN KEY tasks_ibfk_1`); } catch { /* may not exist */ }
      try { await conn.query(`ALTER TABLE tasks DROP FOREIGN KEY tasks_ibfk_2`); } catch { /* may not exist */ }
      try { await conn.query(`ALTER TABLE tasks DROP FOREIGN KEY tasks_ibfk_3`); } catch { /* may not exist */ }
      try { await conn.query(`ALTER TABLE tasks MODIFY project_id VARCHAR(64) NULL`); } catch { /* already nullable */ }
      // Migration: add depends_on column
      try { await conn.query(`ALTER TABLE tasks ADD COLUMN depends_on VARCHAR(64) NULL`); } catch { /* already exists */ }

      await conn.query(`
        CREATE TABLE IF NOT EXISTS task_dependencies (
          task_id VARCHAR(64) NOT NULL,
          depends_on_task_id VARCHAR(64) NOT NULL,
          PRIMARY KEY (task_id, depends_on_task_id),
          INDEX idx_depends_on (depends_on_task_id)
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS messages (
          id VARCHAR(64) PRIMARY KEY,
          from_agent_id VARCHAR(64) NULL,
          to_agent_id VARCHAR(64) NULL,
          channel VARCHAR(128) NOT NULL,
          content TEXT NOT NULL,
          timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Migration: drop FK and make from_agent_id nullable if table already existed
      try {
        await conn.query(`ALTER TABLE messages DROP FOREIGN KEY messages_ibfk_1`);
      } catch { /* FK may not exist */ }
      try {
        await conn.query(`ALTER TABLE messages MODIFY from_agent_id VARCHAR(64) NULL`);
      } catch { /* already nullable */ }

      await conn.query(`
        CREATE TABLE IF NOT EXISTS approvals (
          id VARCHAR(64) PRIMARY KEY,
          title VARCHAR(512) NOT NULL,
          description TEXT,
          requested_by VARCHAR(64) NOT NULL,
          status ENUM('pending','approved','rejected','modified') NOT NULL DEFAULT 'pending',
          project_id VARCHAR(64) NULL,
          response TEXT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          resolved_at DATETIME NULL,
          FOREIGN KEY (requested_by) REFERENCES agents(id),
          FOREIGN KEY (project_id) REFERENCES projects(id)
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS agent_breaks (
          id VARCHAR(64) PRIMARY KEY,
          agent_id VARCHAR(64) NOT NULL,
          reason VARCHAR(255) NOT NULL,
          started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          ended_at DATETIME NULL,
          FOREIGN KEY (agent_id) REFERENCES agents(id)
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS kpi_entries (
          id VARCHAR(64) PRIMARY KEY,
          agent_id VARCHAR(64) NOT NULL,
          metric VARCHAR(128) NOT NULL,
          value FLOAT NOT NULL,
          recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (agent_id) REFERENCES agents(id)
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS settings (
          \`key\` VARCHAR(128) PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS memories (
          id VARCHAR(64) PRIMARY KEY,
          type ENUM('decision','lesson','pattern','context','summary','note') NOT NULL DEFAULT 'note',
          scope VARCHAR(128) NOT NULL DEFAULT 'company',
          category VARCHAR(64) NOT NULL DEFAULT 'general',
          title VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          importance INT NOT NULL DEFAULT 5,
          created_by VARCHAR(64) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NULL,
          superseded_by VARCHAR(64) NULL,
          INDEX idx_scope (scope),
          INDEX idx_category (category),
          INDEX idx_importance (importance DESC),
          INDEX idx_created (created_at DESC)
        )
      `);

      await conn.query(`
        CREATE TABLE IF NOT EXISTS usage_log (
          id VARCHAR(64) PRIMARY KEY,
          agent_id VARCHAR(64) NOT NULL,
          task_id VARCHAR(64) NULL,
          input_tokens INT NOT NULL DEFAULT 0,
          output_tokens INT NOT NULL DEFAULT 0,
          cache_read_tokens INT NOT NULL DEFAULT 0,
          cache_creation_tokens INT NOT NULL DEFAULT 0,
          cost_usd DECIMAL(10, 6) NOT NULL DEFAULT 0,
          num_turns INT NOT NULL DEFAULT 0,
          duration_ms INT NOT NULL DEFAULT 0,
          model VARCHAR(128) NULL,
          recorded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_agent (agent_id),
          INDEX idx_recorded (recorded_at)
        )
      `);

      // Task templates — reusable task patterns (e.g., "New Feature" → design → frontend → backend → QA)
      await conn.query(`
        CREATE TABLE IF NOT EXISTS task_templates (
          id VARCHAR(64) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          description TEXT,
          steps_json TEXT NOT NULL,
          created_by VARCHAR(64) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);

      // Investor task tracking — links investor messages to spawned tasks
      await conn.query(`
        CREATE TABLE IF NOT EXISTS investor_requests (
          id VARCHAR(64) PRIMARY KEY,
          investor_message TEXT NOT NULL,
          intent VARCHAR(64) NOT NULL,
          summary VARCHAR(512) NOT NULL,
          root_task_id VARCHAR(64) NULL,
          status ENUM('received','delegated','in_progress','completed','failed') NOT NULL DEFAULT 'received',
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          completed_at DATETIME NULL,
          INDEX idx_status (status),
          INDEX idx_root_task (root_task_id)
        )
      `);

      // Performance indices for common query patterns
      try { await conn.query(`CREATE INDEX idx_depends_on ON tasks (depends_on)`); } catch { /* already exists */ }
      try { await conn.query(`CREATE INDEX idx_assigned_to ON tasks (assigned_to)`); } catch { /* already exists */ }
      try { await conn.query(`CREATE INDEX idx_tasks_status_priority ON tasks (status, priority DESC, created_at)`); } catch { /* already exists */ }
      try { await conn.query(`CREATE INDEX idx_tasks_status_assigned ON tasks (status, assigned_to)`); } catch { /* already exists */ }
      try { await conn.query(`CREATE INDEX idx_tasks_status_updated ON tasks (status, updated_at)`); } catch { /* already exists */ }

      // Migration: add deadline column to tasks
      try { await conn.query(`ALTER TABLE tasks ADD COLUMN deadline DATETIME NULL`); } catch { /* already exists */ }

      // Task progress notes — intermediate updates agents post while working
      await conn.query(`
        CREATE TABLE IF NOT EXISTS task_notes (
          id VARCHAR(64) PRIMARY KEY,
          task_id VARCHAR(64) NOT NULL,
          agent_id VARCHAR(64) NOT NULL,
          content TEXT NOT NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_task (task_id),
          INDEX idx_agent (agent_id)
        )
      `);
    } finally {
      conn.release();
    }
  }

  // Generic query (for watchdog and other infrastructure)
  async query(sql: string, params?: unknown[]): Promise<RowDataPacket[]> {
    return this.withRetry(async () => {
      const [rows] = await this.pool.query<RowDataPacket[]>(sql, params);
      return rows;
    });
  }

  // Agent operations
  async getAgent(id: string): Promise<AgentState | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM agents WHERE id = ?', [id]
    );
    if (rows.length === 0) return null;
    return this.mapAgent(rows[0]);
  }

  async getAllAgents(): Promise<AgentState[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT * FROM agents');
    return rows.map(r => this.mapAgent(r));
  }

  async upsertAgent(agent: AgentState): Promise<void> {
    await this.pool.query(
      `INSERT INTO agents (id, blueprint_id, status, current_task_id, last_active_at, break_until, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         current_task_id = VALUES(current_task_id),
         last_active_at = VALUES(last_active_at),
         break_until = VALUES(break_until),
         session_id = VALUES(session_id)`,
      [agent.id, agent.blueprintId, agent.status, agent.currentTaskId, agent.lastActiveAt, agent.breakUntil, agent.sessionId]
    );
  }

  async updateAgentStatus(id: string, status: AgentState['status'], breakUntil?: Date): Promise<void> {
    await this.pool.query(
      'UPDATE agents SET status = ?, break_until = ?, last_active_at = NOW() WHERE id = ?',
      [status, breakUntil ?? null, id]
    );
  }

  // Task operations
  async createTask(task: Task): Promise<void> {
    await this.pool.query(
      `INSERT INTO tasks (id, title, description, status, project_id, assigned_to, created_by, parent_task_id, depends_on, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.title, task.description, task.status, task.projectId, task.assignedTo, task.createdBy, task.parentTaskId, task.dependsOn, task.priority]
    );
  }

  /**
   * Batch-create multiple tasks in a single transaction.
   * Much faster than sequential createTask() calls when PM creates 5+ tasks at once.
   */
  async createTasks(tasks: Task[]): Promise<void> {
    if (tasks.length === 0) return;
    if (tasks.length === 1) return this.createTask(tasks[0]);

    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const task of tasks) {
        await conn.query(
          `INSERT INTO tasks (id, title, description, status, project_id, assigned_to, created_by, parent_task_id, depends_on, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [task.id, task.title, task.description, task.status, task.projectId, task.assignedTo, task.createdBy, task.parentTaskId, task.dependsOn, task.priority]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  async getTask(id: string): Promise<Task | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM tasks WHERE id = ?', [id]
    );
    if (rows.length === 0) return null;
    return this.mapTask(rows[0]);
  }

  async getAllTasks(limit = 100): Promise<Task[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM tasks ORDER BY priority DESC, created_at DESC LIMIT ?', [limit]
    );
    return rows.map(r => this.mapTask(r));
  }

  /**
   * Get recent non-completed tasks for duplicate detection.
   * Only returns id, title, description to keep it lightweight.
   */
  async getActiveTasksForDedup(): Promise<Array<{ id: string; title: string; description: string | null }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, title, description FROM tasks
       WHERE status NOT IN ('done', 'blocked', 'cancelled')
         AND created_at > DATE_SUB(NOW(), INTERVAL 30 DAY)
       ORDER BY created_at DESC LIMIT 200`
    );
    return rows.map(r => ({ id: r.id, title: r.title, description: r.description }));
  }

  async getTasksByProject(projectId: string): Promise<Task[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM tasks WHERE project_id = ? ORDER BY priority DESC, created_at ASC', [projectId]
    );
    return rows.map(r => this.mapTask(r));
  }

  async getTasksByAgent(agentId: string): Promise<Task[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM tasks WHERE assigned_to = ? ORDER BY priority DESC', [agentId]
    );
    return rows.map(r => this.mapTask(r));
  }

  async getNextAvailableTask(agentId: string): Promise<Task | null> {
    // Pick up queued tasks whose ALL dependencies (junction table + legacy) are satisfied.
    // A task is ready when:
    //   1. No rows in task_dependencies for it, OR all dependent tasks are done
    //   2. Legacy depends_on is NULL or the referenced task is done
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT t.* FROM tasks t
       LEFT JOIN tasks legacy_dep ON t.depends_on = legacy_dep.id
       WHERE t.assigned_to = ? AND t.status IN ('queued', 'assigned')
         AND (t.depends_on IS NULL OR legacy_dep.status = 'done')
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies td
           JOIN tasks dep ON td.depends_on_task_id = dep.id
           WHERE td.task_id = t.id AND dep.status != 'done'
         )
       ORDER BY t.priority DESC, t.created_at ASC LIMIT 1`,
      [agentId]
    );
    if (rows.length === 0) return null;
    return this.mapTask(rows[0]);
  }

  /**
   * Unblock tasks that were waiting on a now-completed dependency.
   * Checks both legacy depends_on and junction table.
   * Returns tasks that are ready (ALL their dependencies are now done).
   */
  async getUnblockedTasks(completedTaskId: string): Promise<Task[]> {
    // Find tasks that depend on the completed task (via either mechanism)
    // and now have ALL dependencies satisfied
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT DISTINCT t.* FROM tasks t
       WHERE t.status IN ('queued', 'assigned', 'blocked')
         AND (
           t.depends_on = ?
           OR t.id IN (SELECT td.task_id FROM task_dependencies td WHERE td.depends_on_task_id = ?)
         )
         AND (t.depends_on IS NULL OR EXISTS (
           SELECT 1 FROM tasks dep WHERE dep.id = t.depends_on AND dep.status = 'done'
         ))
         AND NOT EXISTS (
           SELECT 1 FROM task_dependencies td
           JOIN tasks dep ON td.depends_on_task_id = dep.id
           WHERE td.task_id = t.id AND dep.status != 'done'
         )
       ORDER BY t.priority DESC`,
      [completedTaskId, completedTaskId]
    );
    return rows.map(r => this.mapTask(r));
  }

  async updateTaskStatus(id: string, status: Task['status'], assignedTo?: string): Promise<void> {
    if (assignedTo !== undefined) {
      await this.pool.query(
        'UPDATE tasks SET status = ?, assigned_to = ? WHERE id = ?',
        [status, assignedTo, id]
      );
    } else {
      await this.pool.query(
        'UPDATE tasks SET status = ? WHERE id = ?',
        [status, id]
      );
    }
  }

  async updateTaskDescription(id: string, description: string): Promise<void> {
    await this.pool.query(
      'UPDATE tasks SET description = ? WHERE id = ?',
      [description, id]
    );
  }

  async setTaskCompletionSummary(id: string, summary: string): Promise<void> {
    await this.pool.query(
      'UPDATE tasks SET completion_summary = ? WHERE id = ?',
      [summary, id]
    );
  }

  async cancelTask(id: string, cancelledBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE tasks SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ? WHERE id = ?`,
      [cancelledBy, id]
    );
  }

  async incrementTaskRetry(id: string): Promise<number> {
    await this.pool.query(
      'UPDATE tasks SET retry_count = retry_count + 1 WHERE id = ?',
      [id]
    );
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT retry_count FROM tasks WHERE id = ?', [id]
    );
    return rows[0]?.retry_count ?? 0;
  }

  /**
   * Add a dependency between tasks using the junction table.
   */
  async addTaskDependency(taskId: string, dependsOnTaskId: string): Promise<void> {
    await this.pool.query(
      `INSERT IGNORE INTO task_dependencies (task_id, depends_on_task_id) VALUES (?, ?)`,
      [taskId, dependsOnTaskId]
    );
  }

  /**
   * Get all dependency task IDs for a given task.
   */
  async getTaskDependencies(taskId: string): Promise<string[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT depends_on_task_id FROM task_dependencies WHERE task_id = ?',
      [taskId]
    );
    return rows.map(r => r.depends_on_task_id);
  }

  // Project operations
  async createProject(project: Omit<Project, 'createdAt' | 'updatedAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO projects (id, name, description, slack_channel, status)
       VALUES (?, ?, ?, ?, ?)`,
      [project.id, project.name, project.description, project.slackChannel, project.status]
    );
  }

  async getProject(id: string): Promise<Project | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM projects WHERE id = ?', [id]
    );
    if (rows.length === 0) return null;
    return this.mapProject(rows[0]);
  }

  async updateProject(id: string, updates: Partial<Pick<Project, 'name' | 'description' | 'status' | 'slackChannel'>>): Promise<void> {
    const sets: string[] = [];
    const params: any[] = [];
    if (updates.name !== undefined) { sets.push('name = ?'); params.push(updates.name); }
    if (updates.description !== undefined) { sets.push('description = ?'); params.push(updates.description); }
    if (updates.status !== undefined) { sets.push('status = ?'); params.push(updates.status); }
    if (updates.slackChannel !== undefined) { sets.push('slack_channel = ?'); params.push(updates.slackChannel); }
    if (sets.length === 0) return;
    params.push(id);
    await this.pool.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  async getAllProjects(): Promise<Project[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM projects ORDER BY created_at DESC'
    );
    return rows.map(r => this.mapProject(r));
  }

  // Project Repository operations
  async addRepository(repo: Omit<ProjectRepository, 'createdAt'>): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_repositories (id, project_id, repo_url, repo_name, local_path, default_branch, current_branch, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [repo.id, repo.projectId, repo.repoUrl, repo.repoName, repo.localPath, repo.defaultBranch, repo.currentBranch, repo.lastSyncedAt]
    );
  }

  async getProjectRepositories(projectId: string): Promise<ProjectRepository[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM project_repositories WHERE project_id = ? ORDER BY created_at ASC', [projectId]
    );
    return rows.map(r => ({
      id: r.id,
      projectId: r.project_id,
      repoUrl: r.repo_url,
      repoName: r.repo_name,
      localPath: r.local_path,
      defaultBranch: r.default_branch,
      currentBranch: r.current_branch,
      lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at) : null,
      createdAt: new Date(r.created_at),
    }));
  }

  async getRepository(id: string): Promise<ProjectRepository | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM project_repositories WHERE id = ?', [id]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      id: r.id, projectId: r.project_id, repoUrl: r.repo_url, repoName: r.repo_name,
      localPath: r.local_path, defaultBranch: r.default_branch, currentBranch: r.current_branch,
      lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at) : null, createdAt: new Date(r.created_at),
    };
  }

  async updateRepositorySync(id: string, branch?: string): Promise<void> {
    await this.pool.query(
      'UPDATE project_repositories SET last_synced_at = NOW(), current_branch = COALESCE(?, current_branch) WHERE id = ?',
      [branch ?? null, id]
    );
  }

  // Blueprint storage — single source of truth for all agents

  /**
   * Save or update a blueprint. Used for both seeding defaults and creating new agents.
   */
  async saveBlueprint(blueprint: AgentBlueprint, isDefault = false): Promise<void> {
    await this.pool.query(
      `INSERT INTO blueprints (id, name, role, is_default, active, blueprint_json) VALUES (?, ?, ?, ?, TRUE, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), role = VALUES(role), blueprint_json = VALUES(blueprint_json), active = TRUE`,
      [blueprint.id, blueprint.name, blueprint.role, isDefault, JSON.stringify(blueprint)]
    );
  }

  /**
   * Get all active blueprints from the database.
   */
  async getAllBlueprints(): Promise<AgentBlueprint[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT blueprint_json FROM blueprints WHERE active = TRUE ORDER BY is_default DESC, created_at ASC'
    );
    const results: AgentBlueprint[] = [];
    for (const row of rows) {
      try { results.push(JSON.parse(row.blueprint_json)); } catch { /* skip invalid */ }
    }
    return results;
  }

  /**
   * Get a single blueprint by ID.
   */
  async getBlueprint(id: string): Promise<AgentBlueprint | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT blueprint_json FROM blueprints WHERE id = ? AND active = TRUE', [id]
    );
    if (rows.length === 0) return null;
    try { return JSON.parse(rows[0].blueprint_json); } catch { return null; }
  }

  /**
   * Update just the blueprint JSON (for editing system prompts, etc.).
   */
  async updateBlueprint(id: string, blueprint: AgentBlueprint): Promise<void> {
    await this.pool.query(
      'UPDATE blueprints SET name = ?, role = ?, blueprint_json = ? WHERE id = ?',
      [blueprint.name, blueprint.role, JSON.stringify(blueprint), id]
    );
  }

  /**
   * Deactivate a blueprint (soft delete — keeps history).
   */
  async deactivateBlueprint(id: string): Promise<void> {
    await this.pool.query('UPDATE blueprints SET active = FALSE WHERE id = ?', [id]);
  }

  /**
   * Get non-default (hired) blueprints only.
   */
  async getHiredBlueprints(): Promise<AgentBlueprint[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT blueprint_json FROM blueprints WHERE is_default = FALSE AND active = TRUE ORDER BY created_at ASC'
    );
    const results: AgentBlueprint[] = [];
    for (const row of rows) {
      try { results.push(JSON.parse(row.blueprint_json)); } catch { /* skip invalid */ }
    }
    return results;
  }

  // Message operations
  async saveMessage(msg: Message): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, from_agent_id, to_agent_id, channel, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [msg.id, msg.fromAgentId, msg.toAgentId, msg.channel, msg.content, msg.timestamp]
    );
  }

  async getChannelMessages(channel: string, limit = 50): Promise<Message[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?',
      [channel, limit]
    );
    return rows.map(r => this.mapMessage(r)).reverse();
  }

  // Approval operations
  async createApproval(approval: Approval): Promise<void> {
    await this.pool.query(
      `INSERT INTO approvals (id, title, description, requested_by, status, project_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [approval.id, approval.title, approval.description, approval.requestedBy, approval.status, approval.projectId]
    );
  }

  async getPendingApprovals(): Promise<Approval[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      "SELECT * FROM approvals WHERE status = 'pending' ORDER BY created_at ASC"
    );
    return rows.map(r => this.mapApproval(r));
  }

  async resolveApproval(id: string, status: 'approved' | 'rejected' | 'modified', response?: string): Promise<void> {
    await this.pool.query(
      'UPDATE approvals SET status = ?, response = ?, resolved_at = NOW() WHERE id = ?',
      [status, response ?? null, id]
    );
  }

  // Break tracking
  async recordBreak(agentId: string, reason: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.pool.query(
      'INSERT INTO agent_breaks (id, agent_id, reason) VALUES (?, ?, ?)',
      [id, agentId, reason]
    );
    return id;
  }

  async endBreak(agentId: string): Promise<void> {
    await this.pool.query(
      "UPDATE agent_breaks SET ended_at = NOW() WHERE agent_id = ? AND ended_at IS NULL",
      [agentId]
    );
  }

  // KPI
  async recordKPI(agentId: string, metric: string, value: number): Promise<void> {
    const id = crypto.randomUUID();
    await this.pool.query(
      'INSERT INTO kpi_entries (id, agent_id, metric, value) VALUES (?, ?, ?, ?)',
      [id, agentId, metric, value]
    );
  }

  // Memory operations
  async saveMemory(entry: {
    id: string;
    type: 'decision' | 'lesson' | 'pattern' | 'context' | 'summary' | 'note';
    scope: string;
    category: string;
    title: string;
    content: string;
    importance: number;
    createdBy: string | null;
    expiresAt?: Date | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO memories (id, type, scope, category, title, content, importance, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.type, entry.scope, entry.category, entry.title, entry.content,
       entry.importance, entry.createdBy, entry.expiresAt ?? null]
    );
  }

  /**
   * Query memories relevant to an agent's current context.
   * Returns most important + most recent, within a token budget.
   */
  async queryMemories(opts: {
    scope?: string;
    scopes?: string[];
    category?: string;
    categories?: string[];
    limit?: number;
    minImportance?: number;
  }): Promise<Array<{
    id: string; type: string; scope: string; category: string;
    title: string; content: string; importance: number;
    createdBy: string | null; createdAt: Date;
  }>> {
    const conditions: string[] = ['(expires_at IS NULL OR expires_at > NOW())', 'superseded_by IS NULL'];
    const params: any[] = [];

    if (opts.scope) {
      conditions.push('scope = ?');
      params.push(opts.scope);
    } else if (opts.scopes && opts.scopes.length > 0) {
      conditions.push(`scope IN (${opts.scopes.map(() => '?').join(',')})`);
      params.push(...opts.scopes);
    }

    if (opts.category) {
      conditions.push('category = ?');
      params.push(opts.category);
    } else if (opts.categories && opts.categories.length > 0) {
      conditions.push(`category IN (${opts.categories.map(() => '?').join(',')})`);
      params.push(...opts.categories);
    }

    if (opts.minImportance) {
      conditions.push('importance >= ?');
      params.push(opts.minImportance);
    }

    const limit = opts.limit ?? 20;
    params.push(limit);

    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM memories WHERE ${conditions.join(' AND ')}
       ORDER BY importance DESC, created_at DESC LIMIT ?`,
      params
    );

    return rows.map(r => ({
      id: r.id,
      type: r.type,
      scope: r.scope,
      category: r.category,
      title: r.title,
      content: r.content,
      importance: r.importance,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at),
    }));
  }

  /**
   * Count memories per scope+category (for summarization triggers).
   */
  async countMemories(scope: string, category: string): Promise<number> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) as cnt FROM memories
       WHERE scope = ? AND category = ? AND superseded_by IS NULL AND type != 'summary'`,
      [scope, category]
    );
    return rows[0].cnt;
  }

  /**
   * Mark old memories as superseded by a summary.
   */
  async supersedMemories(ids: string[], summaryId: string): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      `UPDATE memories SET superseded_by = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      [summaryId, ...ids]
    );
  }

  async getAllMemories(scope?: string, limit = 50): Promise<Array<{
    id: string; type: string; scope: string; category: string;
    title: string; content: string; importance: number;
    createdBy: string | null; createdAt: Date;
  }>> {
    const where = scope
      ? 'WHERE scope = ? AND superseded_by IS NULL'
      : 'WHERE superseded_by IS NULL';
    const params: any[] = scope ? [scope, limit] : [limit];

    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM memories ${where} ORDER BY importance DESC, created_at DESC LIMIT ?`,
      params
    );

    return rows.map(r => ({
      id: r.id, type: r.type, scope: r.scope, category: r.category,
      title: r.title, content: r.content, importance: r.importance,
      createdBy: r.created_by, createdAt: new Date(r.created_at),
    }));
  }

  // Usage tracking
  async recordUsage(entry: {
    id: string;
    agentId: string;
    taskId: string | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
    numTurns: number;
    durationMs: number;
    model: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO usage_log (id, agent_id, task_id, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, num_turns, duration_ms, model)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entry.id, entry.agentId, entry.taskId, entry.inputTokens, entry.outputTokens,
       entry.cacheReadTokens, entry.cacheCreationTokens, entry.costUsd, entry.numTurns, entry.durationMs, entry.model]
    );
  }

  async getUsageSummary(): Promise<{
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCacheReadTokens: number;
    totalSessions: number;
    byAgent: Array<{
      agentId: string;
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      sessions: number;
    }>;
    last24h: {
      costUsd: number;
      inputTokens: number;
      outputTokens: number;
      sessions: number;
    };
  }> {
    // Totals
    const [totalRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(input_tokens), 0) as total_input,
        COALESCE(SUM(output_tokens), 0) as total_output,
        COALESCE(SUM(cache_read_tokens), 0) as total_cache_read,
        COUNT(*) as total_sessions
      FROM usage_log`
    );

    // By agent
    const [agentRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
        agent_id,
        COALESCE(SUM(cost_usd), 0) as cost,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as sessions
      FROM usage_log
      GROUP BY agent_id
      ORDER BY cost DESC`
    );

    // Last 24 hours
    const [recentRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
        COALESCE(SUM(cost_usd), 0) as cost,
        COALESCE(SUM(input_tokens), 0) as input_tokens,
        COALESCE(SUM(output_tokens), 0) as output_tokens,
        COUNT(*) as sessions
      FROM usage_log
      WHERE recorded_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`
    );

    const t = totalRows[0];
    const r = recentRows[0];

    return {
      totalCostUsd: Number(t.total_cost),
      totalInputTokens: Number(t.total_input),
      totalOutputTokens: Number(t.total_output),
      totalCacheReadTokens: Number(t.total_cache_read),
      totalSessions: Number(t.total_sessions),
      byAgent: agentRows.map(row => ({
        agentId: row.agent_id,
        costUsd: Number(row.cost),
        inputTokens: Number(row.input_tokens),
        outputTokens: Number(row.output_tokens),
        sessions: Number(row.sessions),
      })),
      last24h: {
        costUsd: Number(r.cost),
        inputTokens: Number(r.input_tokens),
        outputTokens: Number(r.output_tokens),
        sessions: Number(r.sessions),
      },
    };
  }

  async getRecentUsage(limit = 20): Promise<Array<{
    agentId: string;
    taskId: string | null;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    numTurns: number;
    durationMs: number;
    model: string | null;
    recordedAt: Date;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM usage_log ORDER BY recorded_at DESC LIMIT ?', [limit]
    );
    return rows.map(r => ({
      agentId: r.agent_id,
      taskId: r.task_id,
      costUsd: Number(r.cost_usd),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      numTurns: r.num_turns,
      durationMs: r.duration_ms,
      model: r.model,
      recordedAt: new Date(r.recorded_at),
    }));
  }

  /**
   * Aggregate cost by project — joins usage_log → tasks → projects.
   */
  async getCostByProject(): Promise<Array<{
    projectId: string;
    projectName: string;
    totalCostUsd: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    sessions: number;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
        p.id as project_id,
        p.name as project_name,
        COALESCE(SUM(u.cost_usd), 0) as total_cost,
        COALESCE(SUM(u.input_tokens), 0) as total_input,
        COALESCE(SUM(u.output_tokens), 0) as total_output,
        COUNT(u.id) as sessions
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
      LEFT JOIN usage_log u ON u.task_id = t.id
      GROUP BY p.id, p.name
      ORDER BY total_cost DESC`
    );
    return rows.map(r => ({
      projectId: r.project_id,
      projectName: r.project_name,
      totalCostUsd: Number(r.total_cost),
      totalInputTokens: Number(r.total_input),
      totalOutputTokens: Number(r.total_output),
      sessions: Number(r.sessions),
    }));
  }

  /**
   * Prune expired memories and old low-importance entries.
   * Returns number of entries pruned.
   */
  async pruneMemories(maxAgeDays = 30, minImportance = 2): Promise<number> {
    // Delete expired entries
    const [expired] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < NOW()`
    );
    // Delete old low-importance entries that aren't summaries
    const [old] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM memories WHERE type != 'summary' AND importance <= ? AND created_at < DATE_SUB(NOW(), INTERVAL ? DAY) AND superseded_by IS NULL`,
      [minImportance, maxAgeDays]
    );
    return (expired.affectedRows ?? 0) + (old.affectedRows ?? 0);
  }

  /**
   * Count QA fix cycles for a task chain to prevent infinite loops.
   * Walks the dependsOn chain backwards counting "Fix bugs:" tasks.
   */
  async countFixCycles(taskId: string, maxDepth = 10): Promise<number> {
    let count = 0;
    let currentId: string | null = taskId;
    for (let i = 0; i < maxDepth && currentId; i++) {
      const task = await this.getTask(currentId);
      if (!task) break;
      if (task.title.startsWith('Fix bugs:')) count++;
      currentId = task.dependsOn;
    }
    return count;
  }

  // --- Agent Performance Scoring ---

  /**
   * Get performance metrics for an agent: tasks completed, bugs introduced (fix tasks created from their work),
   * rework % (fix tasks / total tasks), avg task duration.
   */
  async getAgentPerformance(agentId: string): Promise<{
    tasksCompleted: number;
    tasksBlocked: number;
    bugsIntroduced: number;
    reworkPercent: number;
    avgDurationMs: number;
    totalCostUsd: number;
  }> {
    const [taskRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT status, COUNT(*) as cnt FROM tasks WHERE assigned_to = ? GROUP BY status`,
      [agentId]
    );
    const counts: Record<string, number> = {};
    for (const r of taskRows) counts[r.status] = Number(r.cnt);
    const completed = (counts['done'] ?? 0) + (counts['review'] ?? 0);
    const blocked = counts['blocked'] ?? 0;

    // Count "Fix bugs:" tasks that were created because QA found bugs in this agent's work
    const [bugRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COUNT(*) as cnt FROM tasks WHERE assigned_to = ? AND title LIKE 'Fix bugs:%'`,
      [agentId]
    );
    const bugsIntroduced = Number(bugRows[0].cnt);
    const total = completed + blocked + (counts['in_progress'] ?? 0);
    const reworkPercent = total > 0 ? (bugsIntroduced / total) * 100 : 0;

    // Avg duration from usage_log
    const [usageRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(AVG(duration_ms), 0) as avg_dur, COALESCE(SUM(cost_usd), 0) as total_cost
       FROM usage_log WHERE agent_id = ? AND task_id IS NOT NULL`,
      [agentId]
    );

    return {
      tasksCompleted: completed,
      tasksBlocked: blocked,
      bugsIntroduced,
      reworkPercent: Math.round(reworkPercent * 10) / 10,
      avgDurationMs: Math.round(Number(usageRows[0].avg_dur)),
      totalCostUsd: Number(usageRows[0].total_cost),
    };
  }

  /**
   * Get performance for all agents at once.
   */
  async getAllAgentPerformance(): Promise<Array<{ agentId: string } & Awaited<ReturnType<StateStore['getAgentPerformance']>>>> {
    const agents = await this.getAllAgents();
    return Promise.all(agents.map(async a => ({
      agentId: a.id,
      ...(await this.getAgentPerformance(a.id)),
    })));
  }

  // --- Agent Skill Matching ---

  /**
   * Find the best agent for a task based on skills + file patterns overlap.
   * Returns agents ranked by match score (higher = better match).
   */
  findBestAgent(
    blueprints: AgentBlueprint[],
    taskTitle: string,
    taskDescription: string,
    excludeIds: string[] = []
  ): Array<{ agentId: string; name: string; score: number; matchedSkills: string[] }> {
    const text = `${taskTitle} ${taskDescription}`.toLowerCase();
    const results: Array<{ agentId: string; name: string; score: number; matchedSkills: string[] }> = [];

    for (const bp of blueprints) {
      if (excludeIds.includes(bp.id)) continue;

      let score = 0;
      const matchedSkills: string[] = [];

      // Check skill keywords
      for (const skill of bp.skills) {
        const skillLower = skill.toLowerCase();
        if (text.includes(skillLower)) {
          score += 3;
          matchedSkills.push(skill);
        }
      }

      // Check file pattern hints (e.g., "*.tsx" → frontend work)
      for (const pattern of bp.filePatterns) {
        const ext = pattern.replace('*', '').toLowerCase();
        if (text.includes(ext)) {
          score += 1;
        }
      }

      // Role keyword match
      const roleLower = bp.role.toLowerCase();
      if (text.includes(roleLower) || text.includes(bp.id)) {
        score += 5;
        matchedSkills.push(bp.role);
      }

      if (score > 0) {
        results.push({ agentId: bp.id, name: bp.name, score, matchedSkills });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  // --- Deadlock Detection ---

  /**
   * Detect circular dependencies in task chains.
   * Returns array of task IDs forming the cycle, or empty if no cycle.
   */
  async detectDeadlocks(): Promise<string[][]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT id, depends_on FROM tasks WHERE depends_on IS NOT NULL AND status NOT IN ('done', 'review')`
    );

    // Build adjacency: task → depends_on
    const deps = new Map<string, string>();
    for (const r of rows) {
      deps.set(r.id, r.depends_on);
    }

    const cycles: string[][] = [];
    const visited = new Set<string>();

    for (const startId of deps.keys()) {
      if (visited.has(startId)) continue;
      const path: string[] = [];
      const pathSet = new Set<string>();
      let current: string | undefined = startId;

      while (current && !visited.has(current)) {
        if (pathSet.has(current)) {
          // Found a cycle — extract it
          const cycleStart = path.indexOf(current);
          cycles.push(path.slice(cycleStart));
          break;
        }
        path.push(current);
        pathSet.add(current);
        current = deps.get(current);
      }

      for (const id of path) visited.add(id);
    }

    return cycles;
  }

  // --- Task Templates ---

  async saveTaskTemplate(template: {
    id: string;
    name: string;
    description: string;
    steps: Array<{ title: string; description: string; assignTo: string; dependsOnStep?: number }>;
    createdBy: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO task_templates (id, name, description, steps_json, created_by) VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), description = VALUES(description), steps_json = VALUES(steps_json)`,
      [template.id, template.name, template.description, JSON.stringify(template.steps), template.createdBy]
    );
  }

  async getTaskTemplate(id: string): Promise<{
    id: string; name: string; description: string;
    steps: Array<{ title: string; description: string; assignTo: string; dependsOnStep?: number }>;
  } | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM task_templates WHERE id = ?', [id]
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return { id: r.id, name: r.name, description: r.description, steps: JSON.parse(r.steps_json) };
  }

  async getAllTaskTemplates(): Promise<Array<{ id: string; name: string; description: string; stepCount: number }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT id, name, description, steps_json FROM task_templates ORDER BY created_at DESC'
    );
    return rows.map(r => ({
      id: r.id, name: r.name, description: r.description,
      stepCount: JSON.parse(r.steps_json).length,
    }));
  }

  // --- Investor Request Tracking ---

  async saveInvestorRequest(req: {
    id: string;
    investorMessage: string;
    intent: string;
    summary: string;
    rootTaskId: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO investor_requests (id, investor_message, intent, summary, root_task_id, status) VALUES (?, ?, ?, ?, ?, 'delegated')`,
      [req.id, req.investorMessage, req.intent, req.summary, req.rootTaskId]
    );
  }

  async updateInvestorRequestStatus(id: string, status: string): Promise<void> {
    const extra = status === 'completed' ? ', completed_at = NOW()' : '';
    await this.pool.query(
      `UPDATE investor_requests SET status = ?${extra} WHERE id = ?`,
      [status, id]
    );
  }

  async getInvestorRequests(limit = 20): Promise<Array<{
    id: string; investorMessage: string; intent: string; summary: string;
    rootTaskId: string | null; status: string; createdAt: Date; completedAt: Date | null;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM investor_requests ORDER BY created_at DESC LIMIT ?', [limit]
    );
    return rows.map(r => ({
      id: r.id, investorMessage: r.investor_message, intent: r.intent,
      summary: r.summary, rootTaskId: r.root_task_id, status: r.status,
      createdAt: new Date(r.created_at), completedAt: r.completed_at ? new Date(r.completed_at) : null,
    }));
  }

  /**
   * Get all tasks spawned from an investor request (via the root task and its children).
   */
  async getInvestorRequestTasks(rootTaskId: string): Promise<Task[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM tasks WHERE id = ? OR parent_task_id = ? OR created_by IN (
         SELECT assigned_to FROM tasks WHERE id = ? OR parent_task_id = ?
       ) ORDER BY created_at ASC`,
      [rootTaskId, rootTaskId, rootTaskId, rootTaskId]
    );
    return rows.map(r => this.mapTask(r));
  }

  // --- Message Retention Policy ---

  /**
   * Purge messages older than `days` days. Returns count of deleted messages.
   */
  async purgeOldMessages(days = 7): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `DELETE FROM messages WHERE timestamp < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days]
    );
    return result.affectedRows ?? 0;
  }

  // --- Task Priority Rebalancing ---

  /**
   * Bulk-update task priorities. Input: array of { taskId, priority }.
   */
  async rebalancePriorities(updates: Array<{ taskId: string; priority: number }>): Promise<void> {
    if (updates.length === 0) return;
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const { taskId, priority } of updates) {
        await conn.query('UPDATE tasks SET priority = ? WHERE id = ?', [priority, taskId]);
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  /**
   * Auto-deprioritize stale backlog tasks (older than `days` days in backlog, drop priority by 1).
   */
  async deprioritizeStaleBacklog(days = 14): Promise<number> {
    const [result] = await this.pool.query<ResultSetHeader>(
      `UPDATE tasks SET priority = GREATEST(priority - 1, 1)
       WHERE status = 'backlog' AND priority > 1
         AND updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [days]
    );
    return result.affectedRows ?? 0;
  }

  // --- Task Duration Estimation ---

  /**
   * Get average task duration per agent, grouped by task type heuristic (QA, Fix, Code Review, other).
   */
  async getTaskDurationEstimates(): Promise<Array<{
    agentId: string;
    taskType: string;
    avgDurationMs: number;
    sampleCount: number;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
        u.agent_id,
        CASE
          WHEN t.title LIKE 'QA Review:%' THEN 'qa_review'
          WHEN t.title LIKE 'Fix bugs:%' THEN 'bug_fix'
          WHEN t.title LIKE 'Code Review:%' THEN 'code_review'
          WHEN t.title LIKE 'Code review fixes:%' THEN 'code_review_fix'
          WHEN t.title LIKE 'Help %' THEN 'handoff'
          WHEN t.title LIKE 'Design:%' THEN 'design'
          WHEN t.title LIKE 'Frontend:%' THEN 'frontend'
          WHEN t.title LIKE 'Backend:%' THEN 'backend'
          WHEN t.title LIKE 'Security%' THEN 'security'
          WHEN t.title LIKE 'Architecture:%' THEN 'architecture'
          ELSE 'general'
        END as task_type,
        AVG(u.duration_ms) as avg_duration,
        COUNT(*) as sample_count
      FROM usage_log u
      INNER JOIN tasks t ON u.task_id = t.id
      WHERE u.task_id IS NOT NULL AND u.duration_ms > 0
      GROUP BY u.agent_id, task_type
      ORDER BY u.agent_id, avg_duration DESC`
    );

    return rows.map(r => ({
      agentId: r.agent_id,
      taskType: r.task_type,
      avgDurationMs: Math.round(Number(r.avg_duration)),
      sampleCount: Number(r.sample_count),
    }));
  }

  /**
   * Estimate duration for a specific task based on historical data.
   */
  async estimateTaskDuration(agentId: string, taskTitle: string): Promise<{ estimatedMs: number; confidence: string } | null> {
    // Determine task type from title
    let taskType = 'general';
    if (taskTitle.startsWith('QA Review:')) taskType = 'qa_review';
    else if (taskTitle.startsWith('Fix bugs:')) taskType = 'bug_fix';
    else if (taskTitle.startsWith('Code Review:')) taskType = 'code_review';
    else if (taskTitle.startsWith('Design:')) taskType = 'design';
    else if (taskTitle.startsWith('Frontend:')) taskType = 'frontend';
    else if (taskTitle.startsWith('Backend:')) taskType = 'backend';

    const estimates = await this.getTaskDurationEstimates();
    // Try specific agent + task type
    const specific = estimates.find(e => e.agentId === agentId && e.taskType === taskType);
    if (specific && specific.sampleCount >= 2) {
      return { estimatedMs: specific.avgDurationMs, confidence: specific.sampleCount >= 5 ? 'high' : 'medium' };
    }
    // Fall back to agent average
    const agentAvg = estimates.filter(e => e.agentId === agentId);
    if (agentAvg.length > 0) {
      const totalDur = agentAvg.reduce((s, e) => s + e.avgDurationMs * e.sampleCount, 0);
      const totalSamples = agentAvg.reduce((s, e) => s + e.sampleCount, 0);
      return { estimatedMs: Math.round(totalDur / totalSamples), confidence: 'low' };
    }
    return null;
  }

  /**
   * Get raw task completion data for the estimator (duration + cost per task).
   */
  async getTaskCompletionHistory(): Promise<Array<{
    agentId: string;
    taskType: string;
    durationMs: number;
    costUsd: number;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
        u.agent_id,
        t.title,
        u.duration_ms,
        u.total_cost_usd
      FROM usage_log u
      INNER JOIN tasks t ON u.task_id = t.id
      WHERE u.task_id IS NOT NULL AND u.duration_ms > 0
      ORDER BY u.created_at DESC
      LIMIT 1000`
    );

    return rows.map(r => {
      const title = (r.title ?? '').toLowerCase();
      let taskType = 'general';
      if (title.startsWith('qa review:')) taskType = 'qa_review';
      else if (title.startsWith('fix bugs:')) taskType = 'bug_fix';
      else if (title.startsWith('code review:')) taskType = 'code_review';
      else if (title.includes('design')) taskType = 'design';
      else if (title.includes('frontend') || title.includes('ui')) taskType = 'frontend';
      else if (title.includes('backend') || title.includes('api')) taskType = 'backend';
      else if (title.includes('test')) taskType = 'testing';
      else if (title.includes('deploy') || title.includes('ci/cd')) taskType = 'devops';

      return {
        agentId: r.agent_id,
        taskType,
        durationMs: Number(r.duration_ms),
        costUsd: Number(r.total_cost_usd ?? 0),
      };
    });
  }

  // --- Conversation Audit Log ---

  /**
   * Save a full audit trail entry for investor interactions.
   */
  async saveAuditEntry(entry: {
    id: string;
    eventType: string;
    actorId: string;
    channel: string;
    content: string;
    metadata: Record<string, any>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, from_agent_id, to_agent_id, channel, content, timestamp)
       VALUES (?, ?, NULL, ?, ?, NOW())`,
      [entry.id, entry.actorId, `audit:${entry.channel}`, JSON.stringify({ eventType: entry.eventType, content: entry.content, ...entry.metadata })]
    );
  }

  /**
   * Get audit log entries for a channel.
   */
  async getAuditLog(channel: string, limit = 50): Promise<Array<{
    id: string; eventType: string; actorId: string; content: string;
    metadata: Record<string, any>; timestamp: Date;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?`,
      [`audit:${channel}`, limit]
    );
    return rows.map(r => {
      let parsed: any = {};
      try { parsed = JSON.parse(r.content); } catch { parsed = { content: r.content }; }
      return {
        id: r.id,
        eventType: parsed.eventType ?? 'unknown',
        actorId: r.from_agent_id ?? 'system',
        content: parsed.content ?? r.content,
        metadata: parsed,
        timestamp: new Date(r.timestamp),
      };
    });
  }

  // Settings
  async getSetting(key: string): Promise<string | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT value FROM settings WHERE `key` = ?', [key]
    );
    return rows.length > 0 ? rows[0].value : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.pool.query(
      'INSERT INTO settings (`key`, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)',
      [key, value]
    );
  }

  async getAllSettings(): Promise<Record<string, string>> {
    const [rows] = await this.pool.query<RowDataPacket[]>('SELECT `key`, value FROM settings');
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  // Cleanup
  async close(): Promise<void> {
    await this.pool.end();
  }

  // Mappers
  private mapAgent(row: RowDataPacket): AgentState {
    return {
      id: row.id,
      blueprintId: row.blueprint_id,
      status: row.status,
      currentTaskId: row.current_task_id,
      lastActiveAt: new Date(row.last_active_at),
      breakUntil: row.break_until ? new Date(row.break_until) : null,
      sessionId: row.session_id,
    };
  }

  // --- Agent Health Metrics ---

  /**
   * Get comprehensive health metrics for an agent: success rate, avg response time,
   * error frequency, uptime stats.
   */
  async getAgentHealthMetrics(agentId: string): Promise<{
    successRate: number;
    avgDurationMs: number;
    avgCostPerTask: number;
    totalTasks: number;
    errorCount: number;
    last7dCost: number;
    last7dTasks: number;
    cacheHitRate: number;
  }> {
    // Task success/failure
    const [taskRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status IN ('done', 'review') THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) as errors
      FROM tasks WHERE assigned_to = ?`,
      [agentId]
    );
    const total = Number(taskRows[0].total);
    const success = Number(taskRows[0].success);
    const errors = Number(taskRows[0].errors);
    const successRate = total > 0 ? (success / total) * 100 : 100;

    // Usage stats
    const [usageRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT
        COALESCE(AVG(duration_ms), 0) as avg_dur,
        COALESCE(AVG(cost_usd), 0) as avg_cost,
        COALESCE(SUM(cache_read_tokens), 0) as cache_reads,
        COALESCE(SUM(input_tokens), 0) as total_input
      FROM usage_log WHERE agent_id = ? AND task_id IS NOT NULL`,
      [agentId]
    );
    const cacheReads = Number(usageRows[0].cache_reads);
    const totalInput = Number(usageRows[0].total_input);
    const cacheHitRate = totalInput > 0 ? (cacheReads / (cacheReads + totalInput)) * 100 : 0;

    // Last 7 days
    const [recentRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as tasks
       FROM usage_log WHERE agent_id = ? AND task_id IS NOT NULL
       AND recorded_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      [agentId]
    );

    return {
      successRate: Math.round(successRate * 10) / 10,
      avgDurationMs: Math.round(Number(usageRows[0].avg_dur)),
      avgCostPerTask: Math.round(Number(usageRows[0].avg_cost) * 1000000) / 1000000,
      totalTasks: total,
      errorCount: errors,
      last7dCost: Number(recentRows[0].cost),
      last7dTasks: Number(recentRows[0].tasks),
      cacheHitRate: Math.round(cacheHitRate * 10) / 10,
    };
  }

  /**
   * Get health metrics for all agents at once.
   */
  async getAllAgentHealthMetrics(): Promise<Array<{ agentId: string } & Awaited<ReturnType<StateStore['getAgentHealthMetrics']>>>> {
    const agents = await this.getAllAgents();
    return Promise.all(agents.map(async a => ({
      agentId: a.id,
      ...(await this.getAgentHealthMetrics(a.id)),
    })));
  }

  // --- Task Deadline / SLA ---

  /**
   * Set a deadline on a task.
   */
  async setTaskDeadline(taskId: string, deadline: Date): Promise<void> {
    await this.pool.query(
      'UPDATE tasks SET deadline = ? WHERE id = ?',
      [deadline, taskId]
    );
  }

  /**
   * Get tasks that are past their deadline and not yet done.
   */
  async getOverdueTasks(): Promise<Array<Task & { deadline: Date }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM tasks
       WHERE deadline IS NOT NULL AND deadline < NOW()
       AND status NOT IN ('done', 'review')
       ORDER BY deadline ASC`
    );
    return rows.map(r => ({ ...this.mapTask(r), deadline: new Date(r.deadline) }));
  }

  /**
   * Get tasks approaching deadline (within N hours) that aren't done yet.
   */
  async getTasksNearDeadline(hoursThreshold = 2): Promise<Array<Task & { deadline: Date }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM tasks
       WHERE deadline IS NOT NULL
       AND deadline > NOW()
       AND deadline < DATE_ADD(NOW(), INTERVAL ? HOUR)
       AND status NOT IN ('done', 'review')
       ORDER BY deadline ASC`,
      [hoursThreshold]
    );
    return rows.map(r => ({ ...this.mapTask(r), deadline: new Date(r.deadline) }));
  }

  // --- Daily Cost Digest ---

  /**
   * Get cost breakdown for the last N hours, grouped by agent.
   */
  async getCostDigest(hours = 24): Promise<{
    totalCost: number;
    totalSessions: number;
    byAgent: Array<{ agentId: string; cost: number; sessions: number; avgDuration: number }>;
    topExpensiveTask: { taskId: string; title: string; cost: number } | null;
  }> {
    const [totalRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as sessions
       FROM usage_log WHERE recorded_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)`,
      [hours]
    );

    const [agentRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT agent_id, COALESCE(SUM(cost_usd), 0) as cost, COUNT(*) as sessions,
       COALESCE(AVG(duration_ms), 0) as avg_dur
       FROM usage_log WHERE recorded_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       GROUP BY agent_id ORDER BY cost DESC`,
      [hours]
    );

    const [expensiveRows] = await this.pool.query<RowDataPacket[]>(
      `SELECT u.task_id, t.title, SUM(u.cost_usd) as cost
       FROM usage_log u
       LEFT JOIN tasks t ON u.task_id = t.id
       WHERE u.recorded_at >= DATE_SUB(NOW(), INTERVAL ? HOUR) AND u.task_id IS NOT NULL
       GROUP BY u.task_id, t.title
       ORDER BY cost DESC LIMIT 1`,
      [hours]
    );

    return {
      totalCost: Number(totalRows[0].cost),
      totalSessions: Number(totalRows[0].sessions),
      byAgent: agentRows.map(r => ({
        agentId: r.agent_id,
        cost: Number(r.cost),
        sessions: Number(r.sessions),
        avgDuration: Math.round(Number(r.avg_dur)),
      })),
      topExpensiveTask: expensiveRows.length > 0
        ? { taskId: expensiveRows[0].task_id, title: expensiveRows[0].title ?? 'Unknown', cost: Number(expensiveRows[0].cost) }
        : null,
    };
  }

  // --- Cascade Task Operations ---

  /**
   * Cancel a task and all tasks that depend on it (cascade cancel).
   * Returns the IDs of all cancelled tasks.
   */
  async cascadeCancelTask(taskId: string): Promise<string[]> {
    const cancelled: string[] = [];
    const queue = [taskId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      await this.pool.query(
        `UPDATE tasks SET status = 'blocked' WHERE id = ? AND status NOT IN ('done', 'review')`,
        [currentId]
      );
      cancelled.push(currentId);

      // Find tasks that depend on this one
      const [dependents] = await this.pool.query<RowDataPacket[]>(
        `SELECT id FROM tasks WHERE depends_on = ? AND status NOT IN ('done', 'review', 'blocked')`,
        [currentId]
      );
      for (const dep of dependents) {
        queue.push(dep.id);
      }
    }

    return cancelled;
  }

  /**
   * Reassign a task and optionally cascade to dependent tasks.
   */
  async cascadeReassignTask(taskId: string, newAgentId: string, cascade = false): Promise<string[]> {
    const reassigned: string[] = [];
    const queue = [taskId];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      await this.pool.query(
        `UPDATE tasks SET assigned_to = ? WHERE id = ?`,
        [newAgentId, currentId]
      );
      reassigned.push(currentId);

      if (cascade) {
        const [dependents] = await this.pool.query<RowDataPacket[]>(
          `SELECT id FROM tasks WHERE depends_on = ? AND status NOT IN ('done', 'review')`,
          [currentId]
        );
        for (const dep of dependents) {
          queue.push(dep.id);
        }
      }
    }

    return reassigned;
  }

  // --- Agent Workload Balancing ---

  /**
   * Get the current workload for each agent: count of active + assigned tasks.
   */
  async getAgentWorkloads(): Promise<Array<{ agentId: string; activeTasks: number; queuedTasks: number; totalLoad: number }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT assigned_to as agent_id,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END) as queued
      FROM tasks
      WHERE assigned_to IS NOT NULL AND status IN ('in_progress', 'assigned')
      GROUP BY assigned_to
      ORDER BY (SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) + SUM(CASE WHEN status = 'assigned' THEN 1 ELSE 0 END)) DESC`
    );

    return rows.map(r => ({
      agentId: r.agent_id,
      activeTasks: Number(r.active),
      queuedTasks: Number(r.queued),
      totalLoad: Number(r.active) + Number(r.queued),
    }));
  }

  /**
   * Find tasks that can be moved from an overloaded agent to an underloaded one.
   * Only considers 'assigned' tasks (not in_progress — those are already running).
   */
  async getRebalanceCandidates(fromAgentId: string, limit = 3): Promise<Task[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM tasks
       WHERE assigned_to = ? AND status = 'assigned'
       ORDER BY priority ASC, created_at ASC
       LIMIT ?`,
      [fromAgentId, limit]
    );
    return rows.map(r => this.mapTask(r));
  }

  // --- Task Progress Notes ---

  /**
   * Add a progress note to a task.
   */
  async addTaskNote(taskId: string, agentId: string, content: string): Promise<string> {
    const id = crypto.randomUUID();
    await this.pool.query(
      `INSERT INTO task_notes (id, task_id, agent_id, content) VALUES (?, ?, ?, ?)`,
      [id, taskId, agentId, content]
    );
    return id;
  }

  /**
   * Get all progress notes for a task, ordered chronologically.
   */
  async getTaskNotes(taskId: string): Promise<Array<{
    id: string; taskId: string; agentId: string; content: string; createdAt: Date;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM task_notes WHERE task_id = ? ORDER BY created_at ASC`,
      [taskId]
    );
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      agentId: r.agent_id,
      content: r.content,
      createdAt: new Date(r.created_at),
    }));
  }

  /**
   * Get recent notes across all tasks (for the activity feed).
   */
  async getRecentTaskNotes(limit = 20): Promise<Array<{
    id: string; taskId: string; taskTitle: string; agentId: string; content: string; createdAt: Date;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT n.*, t.title as task_title
       FROM task_notes n
       LEFT JOIN tasks t ON n.task_id = t.id
       ORDER BY n.created_at DESC LIMIT ?`,
      [limit]
    );
    return rows.map(r => ({
      id: r.id,
      taskId: r.task_id,
      taskTitle: r.task_title ?? 'Unknown',
      agentId: r.agent_id,
      content: r.content,
      createdAt: new Date(r.created_at),
    }));
  }

  /**
   * Get agent activity timeline: task history per agent for swimlane visualization.
   * Returns completed/in-progress tasks with timing info, grouped by agent.
   */
  async getAgentTimeline(hours = 72): Promise<Array<{
    agentId: string;
    tasks: Array<{
      id: string;
      title: string;
      status: string;
      startedAt: string;
      completedAt: string | null;
      durationMs: number | null;
    }>;
  }>> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT t.id, t.title, t.status, t.assigned_to, t.created_at, t.updated_at
       FROM tasks t
       WHERE t.assigned_to IS NOT NULL
         AND t.created_at > DATE_SUB(NOW(), INTERVAL ? HOUR)
       ORDER BY t.assigned_to, t.created_at ASC`,
      [hours]
    );

    const byAgent = new Map<string, Array<{
      id: string; title: string; status: string;
      startedAt: string; completedAt: string | null; durationMs: number | null;
    }>>();

    for (const r of rows) {
      const agentId = r.assigned_to;
      if (!byAgent.has(agentId)) byAgent.set(agentId, []);
      const started = new Date(r.created_at);
      const updated = new Date(r.updated_at);
      const completed = r.status === 'done' ? updated : null;
      byAgent.get(agentId)!.push({
        id: r.id,
        title: r.title,
        status: r.status,
        startedAt: started.toISOString(),
        completedAt: completed ? completed.toISOString() : null,
        durationMs: completed ? completed.getTime() - started.getTime() : null,
      });
    }

    return Array.from(byAgent.entries()).map(([agentId, tasks]) => ({ agentId, tasks }));
  }

  private mapTask(row: RowDataPacket): Task {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      status: row.status,
      projectId: row.project_id,
      assignedTo: row.assigned_to,
      createdBy: row.created_by,
      parentTaskId: row.parent_task_id,
      dependsOn: row.depends_on ?? null,
      priority: row.priority,
      deadline: row.deadline ? new Date(row.deadline) : null,
      completionSummary: row.completion_summary ?? null,
      retryCount: row.retry_count ?? 0,
      needsReview: row.needs_review === 1 || row.needs_review === true,
      groupId: row.group_id ?? null,
      phase: row.phase ?? null,
      cancelledAt: row.cancelled_at ? new Date(row.cancelled_at) : null,
      cancelledBy: row.cancelled_by ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private mapProject(row: RowDataPacket): Project {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      slackChannel: row.slack_channel,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      status: row.status,
      budgetUsd: row.budget_usd ?? null,
      spentUsd: row.spent_usd ?? 0,
    };
  }

  private mapMessage(row: RowDataPacket): Message {
    return {
      id: row.id,
      fromAgentId: row.from_agent_id,
      toAgentId: row.to_agent_id,
      channel: row.channel,
      content: row.content,
      timestamp: new Date(row.timestamp),
    };
  }

  private mapApproval(row: RowDataPacket): Approval {
    return {
      id: row.id,
      title: row.title,
      description: row.description,
      requestedBy: row.requested_by,
      status: row.status,
      projectId: row.project_id,
      response: row.response,
      createdAt: new Date(row.created_at),
      resolvedAt: row.resolved_at ? new Date(row.resolved_at) : null,
    };
  }

  /**
   * Recover orphaned tasks that have been stuck in 'in_progress' for longer
   * than `staleMinutes`. Moves them back to 'assigned' so they get picked up again.
   */
  async recoverOrphanedTasks(staleMinutes: number): Promise<Task[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM tasks
       WHERE status = 'in_progress'
         AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
      [staleMinutes],
    );

    const recovered: Task[] = [];
    for (const row of rows) {
      await this.pool.query(
        `UPDATE tasks SET status = 'assigned', updated_at = NOW() WHERE id = ?`,
        [row.id],
      );
      recovered.push(this.mapTask(row));
    }
    return recovered;
  }
}

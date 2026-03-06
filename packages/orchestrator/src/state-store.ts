import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { AgentState, Task, Project, ProjectRepository, Message, Approval, AgentBlueprint, AgencyConfig } from './types.js';

export class StateStore {
  private pool: Pool;

  constructor(config: AgencyConfig['mysql']) {
    this.pool = mysql.createPool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      waitForConnections: true,
      connectionLimit: 10,
    });
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
          status ENUM('active','paused','completed','archived') NOT NULL DEFAULT 'active'
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
          status ENUM('backlog','assigned','in_progress','review','done','blocked') NOT NULL DEFAULT 'backlog',
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
    } finally {
      conn.release();
    }
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
    // Only pick up tasks whose dependencies are done (or have no dependency)
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT t.* FROM tasks t
       LEFT JOIN tasks dep ON t.depends_on = dep.id
       WHERE t.assigned_to = ? AND t.status = 'assigned'
         AND (t.depends_on IS NULL OR dep.status IN ('done', 'review'))
       ORDER BY t.priority DESC, t.created_at ASC LIMIT 1`,
      [agentId]
    );
    if (rows.length === 0) return null;
    return this.mapTask(rows[0]);
  }

  /**
   * Unblock tasks that were waiting on a now-completed dependency.
   * Returns tasks that are ready to be assigned/started.
   */
  async getUnblockedTasks(completedTaskId: string): Promise<Task[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM tasks WHERE depends_on = ? AND status = 'assigned'
       ORDER BY priority DESC`,
      [completedTaskId]
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
}

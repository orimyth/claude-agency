import mysql, { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import type { AgentState, Task, Project, Message, Approval, AgencyConfig } from './types.js';

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
          workspace_path VARCHAR(512) NOT NULL,
          slack_channel VARCHAR(128) NULL,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          status ENUM('active','paused','completed','archived') NOT NULL DEFAULT 'active'
        )
      `);

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
      `INSERT INTO tasks (id, title, description, status, project_id, assigned_to, created_by, parent_task_id, priority)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.title, task.description, task.status, task.projectId, task.assignedTo, task.createdBy, task.parentTaskId, task.priority]
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
    const [rows] = await this.pool.query<RowDataPacket[]>(
      `SELECT * FROM tasks WHERE assigned_to = ? AND status = 'assigned'
       ORDER BY priority DESC, created_at ASC LIMIT 1`,
      [agentId]
    );
    if (rows.length === 0) return null;
    return this.mapTask(rows[0]);
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
  async createProject(project: Project): Promise<void> {
    await this.pool.query(
      `INSERT INTO projects (id, name, description, workspace_path, slack_channel, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [project.id, project.name, project.description, project.workspacePath, project.slackChannel, project.status]
    );
  }

  async getProject(id: string): Promise<Project | null> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM projects WHERE id = ?', [id]
    );
    if (rows.length === 0) return null;
    return this.mapProject(rows[0]);
  }

  async getAllProjects(): Promise<Project[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>(
      'SELECT * FROM projects ORDER BY created_at DESC'
    );
    return rows.map(r => this.mapProject(r));
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
      workspacePath: row.workspace_path,
      slackChannel: row.slack_channel,
      createdAt: new Date(row.created_at),
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

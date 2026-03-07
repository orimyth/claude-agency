/**
 * Migration 001: Task States & Project Budget
 *
 * - Adds new columns to tasks: completion_summary, retry_count, needs_review,
 *   cancelled_at, cancelled_by, group_id, phase
 * - Creates task_dependencies junction table (replaces single depends_on field)
 * - Migrates existing depends_on data into junction table
 * - Adds budget_usd, spent_usd, archived_at to projects
 * - Creates _migrations tracking table
 */

export const id = '001';
export const description = 'Task states, dependencies junction table, project budget';

export const up = `
-- Migration tracking table
CREATE TABLE IF NOT EXISTS _migrations (
  id VARCHAR(10) PRIMARY KEY,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tasks: expand status ENUM with new states
ALTER TABLE tasks
  MODIFY COLUMN status ENUM('backlog','queued','assigned','in_progress','verifying','review','done','blocked','cancelled') NOT NULL DEFAULT 'backlog';

-- Tasks: add new columns for enhanced task lifecycle
ALTER TABLE tasks
  ADD COLUMN completion_summary TEXT NULL,
  ADD COLUMN retry_count INT DEFAULT 0,
  ADD COLUMN needs_review BOOLEAN DEFAULT TRUE,
  ADD COLUMN cancelled_at TIMESTAMP NULL,
  ADD COLUMN cancelled_by VARCHAR(50) NULL,
  ADD COLUMN group_id VARCHAR(36) NULL,
  ADD COLUMN phase INT DEFAULT 0;

-- Projects: expand status ENUM
ALTER TABLE projects
  MODIFY COLUMN status ENUM('created','active','paused','completed','cancelled','archived') NOT NULL DEFAULT 'active';

-- Task dependency junction table (supports multi-dependency DAGs)
CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id VARCHAR(36) NOT NULL,
  depends_on_task_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (depends_on_task_id) REFERENCES tasks(id),
  INDEX idx_dep_reverse (depends_on_task_id)
);

-- Migrate existing single depends_on data into junction table
INSERT IGNORE INTO task_dependencies (task_id, depends_on_task_id)
  SELECT id, depends_on FROM tasks WHERE depends_on IS NOT NULL;

-- Projects: add budget tracking and lifecycle columns
ALTER TABLE projects
  ADD COLUMN budget_usd DECIMAL(10,2) NULL,
  ADD COLUMN spent_usd DECIMAL(10,2) DEFAULT 0,
  ADD COLUMN archived_at TIMESTAMP NULL;
`;

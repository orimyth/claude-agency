/**
 * Migration 002: New Tables
 *
 * - task_groups: DAG-based task execution grouping
 * - audit_log: Full audit trail for all entity actions
 * - verification_results: Mechanical check results (build, test, lint, etc.)
 * - config: Runtime configuration key-value store
 * - familiarity_scores: Agent codebase familiarity tracking
 * - collaborations: Inter-agent collaboration requests
 */

export const id = '002';
export const description = 'New tables: task_groups, audit_log, verification_results, config, familiarity_scores, collaborations';

export const up = `
-- Task groups for DAG-based task execution
CREATE TABLE IF NOT EXISTS task_groups (
  id VARCHAR(36) PRIMARY KEY,
  project_id VARCHAR(64) NULL,
  name VARCHAR(200) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- Audit trail for all actions
CREATE TABLE IF NOT EXISTS audit_log (
  id VARCHAR(36) PRIMARY KEY,
  entity_type ENUM('task', 'project', 'agent', 'config', 'system') NOT NULL,
  entity_id VARCHAR(36),
  action VARCHAR(100) NOT NULL,
  actor VARCHAR(50) NOT NULL,
  old_value JSON,
  new_value JSON,
  metadata JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_entity (entity_type, entity_id),
  INDEX idx_action (action),
  INDEX idx_actor (actor),
  INDEX idx_created (created_at)
);

-- Mechanical check results
CREATE TABLE IF NOT EXISTS verification_results (
  id VARCHAR(36) PRIMARY KEY,
  task_id VARCHAR(36) NOT NULL,
  check_type ENUM('build', 'test', 'lint', 'typecheck', 'start', 'review') NOT NULL,
  passed BOOLEAN NOT NULL,
  output TEXT,
  duration_ms INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_task (task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

-- Runtime configuration (replaces hardcoded values)
CREATE TABLE IF NOT EXISTS config (
  key_name VARCHAR(100) PRIMARY KEY,
  value JSON NOT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  updated_by VARCHAR(50) DEFAULT 'system'
);

-- Codebase familiarity scores per agent
CREATE TABLE IF NOT EXISTS familiarity_scores (
  agent_id VARCHAR(50) NOT NULL,
  file_pattern VARCHAR(500) NOT NULL,
  score DECIMAL(5,2) DEFAULT 0,
  last_touched TIMESTAMP NULL,
  PRIMARY KEY (agent_id, file_pattern),
  INDEX idx_pattern (file_pattern)
);

-- Agent collaboration requests
CREATE TABLE IF NOT EXISTS collaborations (
  id VARCHAR(36) PRIMARY KEY,
  from_agent VARCHAR(50) NOT NULL,
  to_agent VARCHAR(50) NOT NULL,
  task_id VARCHAR(36) NOT NULL,
  question TEXT NOT NULL,
  response TEXT,
  status ENUM('pending', 'answered', 'expired') DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  answered_at TIMESTAMP NULL,
  INDEX idx_task (task_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);
`;

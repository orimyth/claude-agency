import type { BlacklistConfig } from './types.js';

export class PermissionEngine {
  private config: BlacklistConfig;

  constructor(config: BlacklistConfig) {
    this.config = config;
  }

  updateConfig(config: BlacklistConfig): void {
    this.config = config;
  }

  /**
   * Check if a command is allowed for a given role.
   * Returns { allowed: true } or { allowed: false, reason: string }
   */
  checkCommand(command: string, role: string, agentId: string, taskId?: string): CheckResult {
    // Check temporary overrides first (most specific)
    if (taskId) {
      const override = this.config.overrides.find(
        o => o.agentId === agentId && o.taskId === taskId && new Date(o.expiresAt) > new Date()
      );
      if (override && command.includes(override.allowedAction)) {
        return { allowed: true };
      }
    }

    // Check global blocked commands (exact match)
    for (const blocked of this.config.global.blockedCommands) {
      if (command.toLowerCase().includes(blocked.toLowerCase())) {
        return { allowed: false, reason: `Blocked by global rule: "${blocked}"` };
      }
    }

    // Check global blocked patterns (regex)
    for (const pattern of this.config.global.blockedPatterns) {
      const regex = new RegExp(pattern, 'i');
      if (regex.test(command)) {
        return { allowed: false, reason: `Blocked by global pattern: ${pattern}` };
      }
    }

    // Check role-specific rules
    const roleRules = this.config.roles[role];
    if (roleRules) {
      for (const blocked of roleRules.blockedCommands) {
        if (command.toLowerCase().includes(blocked.toLowerCase())) {
          return { allowed: false, reason: `Blocked by role rule (${role}): "${blocked}"` };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a file path is accessible for a given role.
   */
  checkPath(filePath: string, role: string): CheckResult {
    // Check global blocked paths
    for (const blocked of this.config.global.blockedPaths) {
      const expanded = blocked.replace('~', process.env.HOME || '');
      if (filePath.startsWith(expanded)) {
        return { allowed: false, reason: `Path blocked globally: "${blocked}"` };
      }
    }

    // Check role-specific path rules
    const roleRules = this.config.roles[role];
    if (roleRules) {
      // If role has allowedPaths, check whitelist first
      if (roleRules.allowedPaths.length > 0) {
        const isAllowed = roleRules.allowedPaths.some(p => matchGlob(filePath, p));
        if (isAllowed) return { allowed: true };
      }

      // Check blocked paths for role
      for (const blocked of roleRules.blockedPaths) {
        if (matchGlob(filePath, blocked)) {
          return { allowed: false, reason: `Path blocked for role ${role}: "${blocked}"` };
        }
      }
    }

    return { allowed: true };
  }
}

function matchGlob(path: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/\*\*/g, '{{GLOBSTAR}}')
    .replace(/\*/g, '[^/]*')
    .replace(/{{GLOBSTAR}}/g, '.*');
  return new RegExp(regexStr).test(path);
}

interface CheckResult {
  allowed: boolean;
  reason?: string;
}

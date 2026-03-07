/**
 * SDK PreToolUse hook for permission enforcement.
 *
 * We keep `permissionMode: 'bypassPermissions'` so the SDK doesn't prompt
 * interactively, but this hook intercepts tool calls before execution and
 * blocks dangerous operations. The agent receives the block reason as a
 * systemMessage, so it can adjust its approach.
 */

export interface AgentPermissions {
  allowedPaths: string[];
  blockedPaths: string[];
  canUseBash: boolean;
  canWriteFiles: boolean;
  canReadFiles: boolean;
}

export interface GlobalBlacklist {
  blockedPatterns: RegExp[];
  blockedPaths: string[];
}

interface HookInput {
  hook_event_name: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  session_id: string;
  cwd: string;
}

interface HookOutput {
  decision: 'approve' | 'block';
  systemMessage?: string;
}

// Default global blacklist
export const DEFAULT_BLACKLIST: GlobalBlacklist = {
  blockedPatterns: [
    /rm\s+-rf\s+\//,
    /rm\s+-rf\s+~/,
    /rm\s+-rf\s+\*/,
    /chmod\s+777/,
    /DROP\s+TABLE/i,
    /DROP\s+DATABASE/i,
    /git\s+push\s+--force/,
    /git\s+push\s+.*--force/,
    /git\s+push\s+origin\s+main\b/,
    /git\s+push\s+origin\s+master\b/,
    /git\s+reset\s+--hard/,
    /curl\s+.*\|\s*sh/,
    /curl\s+.*\|\s*bash/,
    /npm\s+publish/,
    />\s*\/dev\/sd/,
  ],
  blockedPaths: [
    '~/.ssh',
    '~/.aws',
    '~/.env',
    '/etc/',
    '/usr/',
  ],
};

// Default permission profiles per role
export const ROLE_PERMISSIONS: Record<string, AgentPermissions> = {
  ceo: {
    allowedPaths: [],
    blockedPaths: ['*'],
    canUseBash: true, // For curl API calls
    canWriteFiles: false,
    canReadFiles: false,
  },
  hr: {
    allowedPaths: [],
    blockedPaths: ['*'],
    canUseBash: true, // For curl API calls
    canWriteFiles: false,
    canReadFiles: false,
  },
  pm: {
    allowedPaths: [],
    blockedPaths: ['*'],
    canUseBash: true, // For curl API calls
    canWriteFiles: false,
    canReadFiles: false,
  },
  architect: {
    allowedPaths: ['**/*'],
    blockedPaths: ['node_modules/**'],
    canUseBash: true,
    canWriteFiles: true,
    canReadFiles: true,
  },
  coder: {
    allowedPaths: ['**/*'],
    blockedPaths: ['node_modules/**'],
    canUseBash: true,
    canWriteFiles: true,
    canReadFiles: true,
  },
  frontend: {
    allowedPaths: ['**/*'],
    blockedPaths: ['node_modules/**'],
    canUseBash: true,
    canWriteFiles: true,
    canReadFiles: true,
  },
  backend: {
    allowedPaths: ['**/*'],
    blockedPaths: ['node_modules/**'],
    canUseBash: true,
    canWriteFiles: true,
    canReadFiles: true,
  },
  reviewer: {
    allowedPaths: ['**/*'],
    blockedPaths: ['node_modules/**'],
    canUseBash: true,
    canWriteFiles: false,
    canReadFiles: true,
  },
  designer: {
    allowedPaths: ['**/*'],
    blockedPaths: ['node_modules/**'],
    canUseBash: true,
    canWriteFiles: true,
    canReadFiles: true,
  },
  researcher: {
    allowedPaths: ['**/*'],
    blockedPaths: [],
    canUseBash: true,
    canWriteFiles: true,
    canReadFiles: true,
  },
};

/**
 * Create a PreToolUse hook callback for an agent.
 */
export function createPermissionHook(
  agentId: string,
  role: string,
  blacklist: GlobalBlacklist = DEFAULT_BLACKLIST,
  onBlock?: (agentId: string, toolName: string, reason: string) => void,
) {
  const permissions = ROLE_PERMISSIONS[role] ?? ROLE_PERMISSIONS.coder;

  return {
    matcher: '*',
    callback: async (input: HookInput): Promise<HookOutput> => {
      const { tool_name, tool_input } = input;

      // 1. Global blacklist check (Bash commands)
      if (tool_name === 'Bash') {
        if (!permissions.canUseBash) {
          const reason = `Bash not allowed for role: ${role}`;
          onBlock?.(agentId, tool_name, reason);
          return { decision: 'block', systemMessage: reason };
        }

        const cmd = String(tool_input.command ?? '');
        for (const pattern of blacklist.blockedPatterns) {
          if (pattern.test(cmd)) {
            const reason = `Blocked by global policy: ${pattern}`;
            onBlock?.(agentId, tool_name, reason);
            return { decision: 'block', systemMessage: reason };
          }
        }
      }

      // 2. File write restrictions
      if (tool_name === 'Write' || tool_name === 'Edit') {
        if (!permissions.canWriteFiles) {
          const reason = `Write access not allowed for role: ${role}`;
          onBlock?.(agentId, tool_name, reason);
          return { decision: 'block', systemMessage: reason };
        }

        const filePath = String(tool_input.file_path ?? '');
        if (isBlockedPath(filePath, blacklist.blockedPaths)) {
          const reason = `Path blocked: ${filePath}`;
          onBlock?.(agentId, tool_name, reason);
          return { decision: 'block', systemMessage: reason };
        }
      }

      // 3. File read restrictions
      if (tool_name === 'Read') {
        if (!permissions.canReadFiles) {
          const reason = `Read access not allowed for role: ${role}`;
          onBlock?.(agentId, tool_name, reason);
          return { decision: 'block', systemMessage: reason };
        }
      }

      return { decision: 'approve' };
    },
  };
}

function isBlockedPath(filePath: string, blockedPaths: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  for (const blocked of blockedPaths) {
    const normalizedBlocked = blocked.replace(/\\/g, '/');
    if (normalized.startsWith(normalizedBlocked) || normalized.includes(normalizedBlocked)) {
      return true;
    }
  }
  return false;
}

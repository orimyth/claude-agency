import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Task, AgentBlueprint, AgencyConfig } from './types.js';

/**
 * Integration tests with mock SDK.
 * Tests the flow between components without requiring real Claude API or MySQL.
 */

// Mock the SDK before importing anything that uses it
vi.mock('@anthropic-ai/claude-code', () => ({
  query: vi.fn(({ prompt }: { prompt: string }) => {
    // Return an async iterator that yields a result message
    return (async function* () {
      yield {
        type: 'result',
        subtype: 'success',
        result: `Completed: ${prompt.slice(0, 50)}`,
        sessionId: 'mock-session-1',
        total_cost_usd: 0.05,
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { 'claude-sonnet-4-6': { input_tokens: 1000, output_tokens: 500 } },
        num_turns: 3,
        duration_ms: 5000,
      };
    })();
  }),
}));

// Mock the verification module
vi.mock('./verification.js', () => ({
  runMechanicalChecks: vi.fn().mockResolvedValue({
    build: { passed: true, output: 'OK', duration_ms: 100 },
    tests: { passed: true, output: 'OK', duration_ms: 100 },
    lint: { passed: true, output: 'OK', duration_ms: 100 },
    typecheck: { passed: true, output: 'OK', duration_ms: 100 },
    allPassed: true,
  }),
  formatCheckFailures: vi.fn().mockReturnValue('No failures'),
}));

// Mock git-ops
vi.mock('./git-ops.js', () => ({
  GitOps: vi.fn().mockImplementation(() => ({
    createTaskWorktree: vi.fn().mockResolvedValue({ path: '/tmp/worktree', branch: 'feature/dev/abc', taskId: 'task-1' }),
    cleanupWorktree: vi.fn().mockResolvedValue(undefined),
    commitAndPush: vi.fn().mockResolvedValue({ pushed: false, branch: 'feature/dev/abc', noChanges: true }),
  })),
}));

function makeMockStore() {
  const tasks = new Map<string, Task>();
  const agents = new Map<string, any>();

  return {
    getAgent: vi.fn(async (id: string) => agents.get(id) ?? null),
    getAllAgents: vi.fn(async () => Array.from(agents.values())),
    upsertAgent: vi.fn(async (state: any) => agents.set(state.id, state)),
    updateAgentStatus: vi.fn(async (id: string, status: string, breakUntil?: Date) => {
      const agent = agents.get(id);
      if (agent) agents.set(id, { ...agent, status, breakUntil });
    }),
    getTask: vi.fn(async (id: string) => tasks.get(id) ?? null),
    createTask: vi.fn(async (task: Task) => tasks.set(task.id, task)),
    updateTaskStatus: vi.fn(async (id: string, status: string, assignedTo?: string) => {
      const task = tasks.get(id);
      if (task) tasks.set(id, { ...task, status: status as any, assignedTo: assignedTo ?? task.assignedTo });
    }),
    setTaskCompletionSummary: vi.fn().mockResolvedValue(undefined),
    incrementTaskRetry: vi.fn().mockResolvedValue(1),
    getNextAvailableTask: vi.fn().mockResolvedValue(null),
    getProjectRepositories: vi.fn().mockResolvedValue([]),
    getTasksByProject: vi.fn().mockResolvedValue([]),
    getTaskNotes: vi.fn().mockResolvedValue([]),
    getProject: vi.fn().mockResolvedValue(null),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    recordKPI: vi.fn().mockResolvedValue(undefined),
    recordBreak: vi.fn().mockResolvedValue(undefined),
    endBreak: vi.fn().mockResolvedValue(undefined),
    addTaskNote: vi.fn().mockResolvedValue(undefined),
    saveBlueprint: vi.fn().mockResolvedValue(undefined),
    // Expose internals for assertions
    _tasks: tasks,
    _agents: agents,
  };
}

function makeMockPermissions() {
  return {
    check: vi.fn().mockReturnValue({ allowed: true }),
  };
}

const baseConfig: AgencyConfig = {
  workspace: '/tmp/test-workspace',
  maxConcurrency: 5,
  mysql: { host: 'localhost', port: 3306, user: 'test', password: 'test', database: 'test' },
  slack: { botToken: '', signingSecret: '', appToken: '' },
  dashboardPort: 3000,
  wsPort: 3001,
  maxCostPerTask: 5.0,
  emergencyPause: false,
  webhooks: [],
  messageRetentionDays: 7,
};

const testBlueprint: AgentBlueprint = {
  id: 'developer',
  role: 'developer',
  name: 'Eve',
  gender: 'female',
  avatar: '👩‍💻',
  systemPrompt: 'You are Eve, a senior developer.',
  skills: [],
  filePatterns: ['**/*.ts'],
  slackChannels: ['general'],
  kpis: [],
  reportsTo: 'pm',
  canCollabWith: ['architect'],
  blacklistOverrides: [],
};

describe('AgentManager integration', () => {
  let store: ReturnType<typeof makeMockStore>;

  beforeEach(() => {
    store = makeMockStore();
  });

  it('can import and construct AgentManager', async () => {
    const { AgentManager } = await import('./agent-manager.js');
    const manager = new AgentManager(store as any, makeMockPermissions() as any, baseConfig);
    expect(manager).toBeDefined();
  });

  it('registers blueprints and initializes agents', async () => {
    const { AgentManager } = await import('./agent-manager.js');
    const manager = new AgentManager(store as any, makeMockPermissions() as any, baseConfig);
    manager.registerBlueprint(testBlueprint);
    const state = await manager.initializeAgent(testBlueprint);
    expect(state.id).toBe('developer');
    expect(state.status).toBe('idle');
    expect(store.upsertAgent).toHaveBeenCalled();
  });

  it('getBlueprint returns registered blueprint', async () => {
    const { AgentManager } = await import('./agent-manager.js');
    const manager = new AgentManager(store as any, makeMockPermissions() as any, baseConfig);
    manager.registerBlueprint(testBlueprint);
    const bp = manager.getBlueprint('developer');
    expect(bp).toBeDefined();
    expect(bp!.name).toBe('Eve');
  });

  it('queues tasks when at max concurrency', async () => {
    const { AgentManager } = await import('./agent-manager.js');
    const config = { ...baseConfig, maxConcurrency: 0 };
    const manager = new AgentManager(store as any, makeMockPermissions() as any, config);
    manager.registerBlueprint(testBlueprint);
    await manager.initializeAgent(testBlueprint);

    const task: Task = {
      id: 'task-1',
      title: 'Test task',
      description: 'Do something',
      status: 'backlog',
      projectId: null,
      assignedTo: 'developer',
      createdBy: 'pm',
      parentTaskId: null,
      dependsOn: null,
      priority: 5,
      deadline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await manager.assignTask('developer', task);
    // Should have been queued (status: 'queued') instead of started
    expect(store.updateTaskStatus).toHaveBeenCalledWith('task-1', 'queued', 'developer');
  });

  it('queues tasks during emergency pause', async () => {
    const { AgentManager } = await import('./agent-manager.js');
    const config = { ...baseConfig, emergencyPause: true };
    const manager = new AgentManager(store as any, makeMockPermissions() as any, config);
    manager.registerBlueprint(testBlueprint);
    await manager.initializeAgent(testBlueprint);

    const task: Task = {
      id: 'task-2',
      title: 'Paused task',
      description: 'Should be queued',
      status: 'backlog',
      projectId: null,
      assignedTo: 'developer',
      createdBy: 'pm',
      parentTaskId: null,
      dependsOn: null,
      priority: 5,
      deadline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await manager.assignTask('developer', task);
    expect(store.updateTaskStatus).toHaveBeenCalledWith('task-2', 'queued', 'developer');
  });

  it('getAllBlueprints returns all registered', async () => {
    const { AgentManager } = await import('./agent-manager.js');
    const manager = new AgentManager(store as any, makeMockPermissions() as any, baseConfig);
    manager.registerBlueprint(testBlueprint);
    manager.registerBlueprint({ ...testBlueprint, id: 'frontend', role: 'frontend', name: 'Maya' });
    expect(manager.getAllBlueprints()).toHaveLength(2);
  });

  it('pauseAll sets emergency pause and aborts', async () => {
    const { AgentManager } = await import('./agent-manager.js');
    const manager = new AgentManager(store as any, makeMockPermissions() as any, baseConfig);
    const count = await manager.pauseAll();
    expect(manager.isEmergencyPaused()).toBe(true);
    expect(count).toBe(0); // No active sessions
  });

  it('resumeAll clears emergency pause', async () => {
    const { AgentManager } = await import('./agent-manager.js');
    const manager = new AgentManager(store as any, makeMockPermissions() as any, baseConfig);
    await manager.pauseAll();
    expect(manager.isEmergencyPaused()).toBe(true);
    await manager.resumeAll();
    expect(manager.isEmergencyPaused()).toBe(false);
  });
});

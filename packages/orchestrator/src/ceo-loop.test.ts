import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CEOLoop } from './ceo-loop.js';

function makeMockStore() {
  return {
    query: vi.fn().mockResolvedValue([]),
    getAllAgents: vi.fn().mockResolvedValue([]),
    getAllTasks: vi.fn().mockResolvedValue([]),
  };
}

function makeMockAgentManager() {
  return {
    notify: vi.fn(),
    chat: vi.fn().mockResolvedValue('Got it, will update the investor.'),
    getBlueprint: vi.fn().mockReturnValue({ name: 'Eve', role: 'developer' }),
  };
}

function makeMockNotifications() {
  return {
    systemAlert: vi.fn().mockResolvedValue(undefined),
    costAlert: vi.fn().mockResolvedValue(undefined),
  };
}

describe('CEOLoop', () => {
  let store: ReturnType<typeof makeMockStore>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let notifications: ReturnType<typeof makeMockNotifications>;
  let loop: CEOLoop;

  beforeEach(() => {
    store = makeMockStore();
    agentManager = makeMockAgentManager();
    notifications = makeMockNotifications();
    loop = new CEOLoop(store as any, agentManager as any, notifications as any, 60_000);
  });

  afterEach(() => {
    loop.stop();
  });

  it('starts and stops without error', () => {
    loop.start();
    loop.stop();
  });

  describe('checkCompletedProjects', () => {
    it('notifies when project completes', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'completed'")) {
          return [{ id: 'proj-1', name: 'Recipe App' }];
        }
        return [];
      });

      await (loop as any).check();

      expect(agentManager.notify).toHaveBeenCalledWith(
        'ceo', 'leadership',
        expect.stringContaining('Recipe App'),
      );
    });
  });

  describe('checkBlockedTasks', () => {
    it('notifies about blocked tasks >30min', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'blocked'")) {
          return [{ id: 'task-1', title: 'Auth module', assigned_to: 'developer', project_id: 'proj-1', updated_at: new Date() }];
        }
        return [];
      });

      await (loop as any).check();

      expect(agentManager.notify).toHaveBeenCalledWith(
        'ceo', 'project-proj-1',
        expect.stringContaining('Auth module'),
      );
    });

    it('does not re-report same blocked task', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'blocked'")) {
          return [{ id: 'task-1', title: 'Auth module', assigned_to: 'developer', project_id: null, updated_at: new Date() }];
        }
        return [];
      });

      await (loop as any).check();
      await (loop as any).check();

      // Should only notify once for same task
      const blockNotifs = agentManager.notify.mock.calls.filter(
        (c: any[]) => c[2].includes('Auth module') && c[2].includes('blocked'),
      );
      expect(blockNotifs).toHaveLength(1);
    });
  });

  describe('checkBudgetAlerts', () => {
    it('alerts on >80% budget usage', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes('budget_usd')) {
          return [{ id: 'proj-1', name: 'Big Project', budget_usd: 100, spent_usd: 85 }];
        }
        return [];
      });

      await (loop as any).check();

      expect(agentManager.notify).toHaveBeenCalledWith(
        'ceo', 'leadership',
        expect.stringContaining('85%'),
      );
    });

    it('escalates on >100% budget', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes('budget_usd')) {
          return [{ id: 'proj-1', name: 'Over Budget', budget_usd: 50, spent_usd: 60 }];
        }
        return [];
      });

      await (loop as any).check();

      expect(notifications.costAlert).toHaveBeenCalledWith('proj-1', 60, 50);
    });
  });

  describe('checkPeriodicStatus', () => {
    it('sends status after 4 hours', async () => {
      // Set lastStatusAt to 5 hours ago
      (loop as any).lastStatusAt = Date.now() - 5 * 60 * 60_000;

      store.getAllAgents.mockResolvedValue([
        { id: 'dev1', status: 'active' },
        { id: 'dev2', status: 'idle' },
      ]);
      store.getAllTasks.mockResolvedValue([
        { status: 'in_progress' },
        { status: 'done' },
        { status: 'blocked' },
      ]);

      await (loop as any).check();

      expect(agentManager.notify).toHaveBeenCalledWith(
        'ceo', 'leadership',
        expect.stringContaining('4h status'),
      );
    });

    it('skips status if interval not elapsed', async () => {
      // lastStatusAt was just set (default is Date.now() in start)
      (loop as any).lastStatusAt = Date.now();

      await (loop as any).checkPeriodicStatus();

      const statusCalls = agentManager.notify.mock.calls.filter(
        (c: any[]) => c[2].includes('4h status'),
      );
      expect(statusCalls).toHaveLength(0);
    });
  });
});

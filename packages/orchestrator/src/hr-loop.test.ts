import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HRLoop } from './hr-loop.js';

function makeMockStore() {
  return {
    query: vi.fn().mockResolvedValue([]),
    getAllAgents: vi.fn().mockResolvedValue([]),
  };
}

function makeMockAgentManager() {
  return {
    notify: vi.fn(),
    getBlueprint: vi.fn().mockReturnValue({ id: 'developer', name: 'Eve', role: 'developer' }),
    pauseAgent: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockNotifications() {
  return {
    systemAlert: vi.fn().mockResolvedValue(undefined),
  };
}

describe('HRLoop', () => {
  let store: ReturnType<typeof makeMockStore>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let notifications: ReturnType<typeof makeMockNotifications>;
  let loop: HRLoop;

  beforeEach(() => {
    store = makeMockStore();
    agentManager = makeMockAgentManager();
    notifications = makeMockNotifications();
    loop = new HRLoop(store as any, agentManager as any, notifications as any, {
      checkIntervalMs: 60_000,
      maxAgents: 15,
      hireCooldownMs: 0, // No cooldown for tests
    });
  });

  afterEach(() => {
    loop.stop();
  });

  it('starts and stops without error', () => {
    loop.start();
    loop.stop();
  });

  describe('checkWorkloadImbalance', () => {
    it('recommends hiring when queue is overloaded', async () => {
      store.getAllAgents.mockResolvedValue([
        { id: 'developer', status: 'active' },
      ]);
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes('queued_count')) {
          return [{ assigned_to: 'developer', queued_count: 7 }];
        }
        return [];
      });

      await (loop as any).check();

      expect(agentManager.notify).toHaveBeenCalledWith(
        'hr', 'hr-hiring',
        expect.stringContaining('workload alert'),
      );
    });

    it('does not recommend when at max agents', async () => {
      const agents = Array.from({ length: 15 }, (_, i) => ({ id: `agent-${i}`, status: 'active' }));
      store.getAllAgents.mockResolvedValue(agents);
      store.query.mockResolvedValue([{ assigned_to: 'developer', queued_count: 10 }]);

      await (loop as any).check();

      const hireCalls = agentManager.notify.mock.calls.filter(
        (c: any[]) => c[2].includes('workload alert'),
      );
      expect(hireCalls).toHaveLength(0);
    });

    it('does not recommend when 3+ agents of same role exist', async () => {
      store.getAllAgents.mockResolvedValue([
        { id: 'dev-1', status: 'active' },
        { id: 'dev-2', status: 'active' },
        { id: 'dev-3', status: 'active' },
      ]);
      agentManager.getBlueprint.mockReturnValue({ id: 'developer', name: 'Eve', role: 'developer' });
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes('queued_count')) {
          return [{ assigned_to: 'dev-1', queued_count: 8 }];
        }
        return [];
      });

      await (loop as any).check();

      const hireCalls = agentManager.notify.mock.calls.filter(
        (c: any[]) => c[2].includes('workload alert'),
      );
      expect(hireCalls).toHaveLength(0);
    });
  });

  describe('checkAgentHealth', () => {
    it('auto-pauses agents with 3+ failures', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes('tasks_failed')) {
          return [{ agent_id: 'developer', fail_count: 4 }];
        }
        return [];
      });

      await (loop as any).check();

      expect(agentManager.pauseAgent).toHaveBeenCalledWith('developer');
      expect(notifications.systemAlert).toHaveBeenCalledWith(
        expect.stringContaining('auto-paused'),
      );
    });
  });

  describe('checkSkillGaps', () => {
    it('flags tasks assigned to non-existent agents', async () => {
      agentManager.getBlueprint.mockImplementation((id: string) => {
        if (id === 'nonexistent') return undefined;
        return { id, name: 'Eve', role: 'developer' };
      });
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes('assigned_to IS NOT NULL')) {
          return [{ assigned_to: 'nonexistent' }];
        }
        return [];
      });

      await (loop as any).check();

      expect(agentManager.notify).toHaveBeenCalledWith(
        'hr', 'hr-hiring',
        expect.stringContaining('skill gap'),
      );
    });
  });

  describe('checkIdleAgents', () => {
    it('recommends retiring long-idle agents', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'idle'")) {
          return [{ id: 'developer', blueprint_id: 'developer', last_active_at: new Date(Date.now() - 4 * 60 * 60_000) }];
        }
        return [];
      });

      await (loop as any).check();

      expect(agentManager.notify).toHaveBeenCalledWith(
        'hr', 'hr-hiring',
        expect.stringContaining('idle'),
      );
    });

    it('does not recommend retiring core roles', async () => {
      agentManager.getBlueprint.mockReturnValue({ id: 'ceo', name: 'Alice', role: 'ceo' });
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes("status = 'idle'")) {
          return [{ id: 'ceo', blueprint_id: 'ceo', last_active_at: new Date(Date.now() - 10 * 60 * 60_000) }];
        }
        return [];
      });

      await (loop as any).check();

      const retireCalls = agentManager.notify.mock.calls.filter(
        (c: any[]) => c[2].includes('idle') && c[2].includes('retiring'),
      );
      expect(retireCalls).toHaveLength(0);
    });
  });
});

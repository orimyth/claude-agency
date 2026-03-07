import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Watchdog } from './watchdog.js';

function makeMockStore() {
  return {
    query: vi.fn().mockResolvedValue([]),
    updateTaskStatus: vi.fn().mockResolvedValue(undefined),
  };
}

function makeMockNotifications() {
  return {
    systemAlert: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Watchdog', () => {
  let store: ReturnType<typeof makeMockStore>;
  let notifications: ReturnType<typeof makeMockNotifications>;
  let watchdog: Watchdog;

  beforeEach(() => {
    store = makeMockStore();
    notifications = makeMockNotifications();
    watchdog = new Watchdog(store as any, notifications as any, 60_000);
  });

  afterEach(() => {
    watchdog.stop();
  });

  it('starts and stops without error', () => {
    watchdog.start();
    watchdog.stop();
  });

  it('does not start twice', () => {
    watchdog.start();
    watchdog.start(); // Should be no-op
    watchdog.stop();
  });

  describe('checkLoopHeartbeats', () => {
    it('alerts when CEO loop is stale', async () => {
      const staleTime = Date.now() - 40 * 60_000; // 40 min ago
      store.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('settings') && params?.[0] === 'ceo_loop_last_run') {
          return [{ value: JSON.stringify(staleTime) }];
        }
        if (sql.includes('settings')) return [];
        if (sql.includes('SELECT 1')) return [{ 1: 1 }];
        return [];
      });

      // Access private method via any
      await (watchdog as any).check();

      expect(notifications.systemAlert).toHaveBeenCalledWith(
        expect.stringContaining('CEO'),
      );
    });

    it('does not alert when loops are fresh', async () => {
      const freshTime = Date.now() - 2 * 60_000; // 2 min ago
      store.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('settings')) {
          return [{ value: JSON.stringify(freshTime) }];
        }
        if (sql.includes('SELECT 1')) return [{ 1: 1 }];
        return [];
      });

      await (watchdog as any).check();

      // systemAlert should only be called if something is stale
      // With fresh timestamps, no alert expected from heartbeats
      const heartbeatAlerts = notifications.systemAlert.mock.calls.filter(
        (call: any[]) => call[0].includes('loop') || call[0].includes('CEO') || call[0].includes('HR')
      );
      expect(heartbeatAlerts).toHaveLength(0);
    });
  });

  describe('checkOrphanedTasks', () => {
    it('returns orphaned tasks to backlog', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql.includes('LEFT JOIN agents')) {
          return [{ id: 'task-1', title: 'Orphaned task', assigned_to: 'deleted-agent' }];
        }
        if (sql.includes('SELECT 1')) return [{ 1: 1 }];
        return [];
      });

      await (watchdog as any).check();

      expect(store.updateTaskStatus).toHaveBeenCalledWith('task-1', 'backlog');
      expect(notifications.systemAlert).toHaveBeenCalledWith(
        expect.stringContaining('Orphaned task'),
      );
    });
  });

  describe('checkDbHealth', () => {
    it('alerts on DB failure', async () => {
      store.query.mockImplementation(async (sql: string) => {
        if (sql === 'SELECT 1') throw new Error('Connection refused');
        return [];
      });

      await (watchdog as any).check();

      expect(notifications.systemAlert).toHaveBeenCalledWith(
        expect.stringContaining('Database health check failed'),
      );
    });
  });
});

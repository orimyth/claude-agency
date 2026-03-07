import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService, type Notification } from './notification.js';

function makeMockWS() {
  return { broadcast: vi.fn() };
}

function makeMockSlack() {
  return { sendToChannel: vi.fn().mockResolvedValue(undefined) };
}

describe('NotificationService', () => {
  let ws: ReturnType<typeof makeMockWS>;
  let service: NotificationService;

  beforeEach(() => {
    ws = makeMockWS();
    service = new NotificationService(ws);
  });

  describe('send', () => {
    it('broadcasts to WebSocket', async () => {
      await service.send({
        type: 'task_completed',
        agentId: 'dev1',
        taskId: 'task-1',
        summary: 'Done with feature',
        timestamp: new Date(),
      });
      expect(ws.broadcast).toHaveBeenCalledWith('notification:task_completed', expect.objectContaining({
        type: 'task_completed',
        summary: 'Done with feature',
      }));
    });

    it('emits notification event', async () => {
      const handler = vi.fn();
      service.on('notification', handler);
      await service.send({
        type: 'system_alert',
        summary: 'Test alert',
        timestamp: new Date(),
      });
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        type: 'system_alert',
        summary: 'Test alert',
      }));
    });

    it('sends to Slack when configured', async () => {
      const slack = makeMockSlack();
      service.setSlackBridge(slack);
      await service.send({
        type: 'system_alert',
        summary: 'Test alert',
        timestamp: new Date(),
      });
      expect(slack.sendToChannel).toHaveBeenCalledWith('alerts', 'Test alert');
    });

    it('does not crash when Slack fails', async () => {
      const slack = makeMockSlack();
      slack.sendToChannel.mockRejectedValue(new Error('Slack down'));
      service.setSlackBridge(slack);
      // Should not throw
      await service.send({
        type: 'system_alert',
        summary: 'Test',
        timestamp: new Date(),
      });
      expect(ws.broadcast).toHaveBeenCalled();
    });
  });

  describe('convenience methods', () => {
    it('taskStarted sends correct type', async () => {
      await service.taskStarted('dev1', 'task-1', 'Build feature', 'proj-1');
      expect(ws.broadcast).toHaveBeenCalledWith('notification:task_started', expect.objectContaining({
        type: 'task_started',
        agentId: 'dev1',
        taskId: 'task-1',
        projectId: 'proj-1',
      }));
    });

    it('taskCompleted sends correct type', async () => {
      await service.taskCompleted('dev1', 'task-1', 'Build feature');
      expect(ws.broadcast).toHaveBeenCalledWith('notification:task_completed', expect.objectContaining({
        type: 'task_completed',
      }));
    });

    it('taskBlocked includes reason in details', async () => {
      await service.taskBlocked('dev1', 'task-1', 'Build feature', 'Missing dependency');
      expect(ws.broadcast).toHaveBeenCalledWith('notification:task_blocked', expect.objectContaining({
        details: { reason: 'Missing dependency' },
      }));
    });

    it('costAlert calculates percentage', async () => {
      await service.costAlert('proj-1', 7.5, 10);
      expect(ws.broadcast).toHaveBeenCalledWith('notification:cost_alert', expect.objectContaining({
        summary: expect.stringContaining('75%'),
        details: expect.objectContaining({ spent: 7.5, budget: 10, percentage: 75 }),
      }));
    });

    it('systemAlert sends to alerts channel', async () => {
      const slack = makeMockSlack();
      service.setSlackBridge(slack);
      await service.systemAlert('DB is slow');
      expect(slack.sendToChannel).toHaveBeenCalledWith('alerts', 'DB is slow');
    });

    it('mergeComplete sends correct data', async () => {
      await service.mergeComplete('task-1', 'feature/auth', 'proj-1');
      expect(ws.broadcast).toHaveBeenCalledWith('notification:merge_complete', expect.objectContaining({
        type: 'merge_complete',
        summary: expect.stringContaining('feature/auth'),
      }));
    });

    it('mergeRollback includes reason', async () => {
      await service.mergeRollback('task-1', 'feature/auth', 'Tests failed');
      expect(ws.broadcast).toHaveBeenCalledWith('notification:merge_rollback', expect.objectContaining({
        details: { reason: 'Tests failed' },
      }));
    });
  });

  describe('Slack channel routing', () => {
    it('routes task events to project channel', async () => {
      const slack = makeMockSlack();
      service.setSlackBridge(slack);
      await service.send({
        type: 'task_completed',
        projectId: 'my-project',
        summary: 'Done',
        timestamp: new Date(),
      });
      expect(slack.sendToChannel).toHaveBeenCalledWith('project-my-project', 'Done');
    });

    it('routes task events to general when no project', async () => {
      const slack = makeMockSlack();
      service.setSlackBridge(slack);
      await service.send({
        type: 'task_completed',
        summary: 'Done',
        timestamp: new Date(),
      });
      expect(slack.sendToChannel).toHaveBeenCalledWith('general', 'Done');
    });

    it('routes agent events to hr-hiring', async () => {
      const slack = makeMockSlack();
      service.setSlackBridge(slack);
      await service.send({
        type: 'agent_hired',
        summary: 'New dev',
        timestamp: new Date(),
      });
      expect(slack.sendToChannel).toHaveBeenCalledWith('hr-hiring', 'New dev');
    });

    it('routes cost alerts to alerts channel', async () => {
      const slack = makeMockSlack();
      service.setSlackBridge(slack);
      await service.send({
        type: 'cost_alert',
        summary: 'Budget warning',
        timestamp: new Date(),
      });
      expect(slack.sendToChannel).toHaveBeenCalledWith('alerts', 'Budget warning');
    });
  });
});

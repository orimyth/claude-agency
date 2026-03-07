import { describe, it, expect, vi } from 'vitest';
import { TaskEstimator } from './task-estimator.js';

function mockStore(history: Array<{ agentId: string; taskType: string; durationMs: number; costUsd: number }> = []) {
  return {
    getTaskCompletionHistory: vi.fn().mockResolvedValue(history),
    getTasksByProject: vi.fn().mockResolvedValue([]),
  } as any;
}

const sampleHistory = [
  { agentId: 'eve', taskType: 'frontend', durationMs: 120_000, costUsd: 0.05 },
  { agentId: 'eve', taskType: 'frontend', durationMs: 180_000, costUsd: 0.08 },
  { agentId: 'eve', taskType: 'frontend', durationMs: 150_000, costUsd: 0.06 },
  { agentId: 'eve', taskType: 'frontend', durationMs: 200_000, costUsd: 0.10 },
  { agentId: 'eve', taskType: 'frontend', durationMs: 140_000, costUsd: 0.05 },
  { agentId: 'eve', taskType: 'backend', durationMs: 300_000, costUsd: 0.15 },
  { agentId: 'eve', taskType: 'backend', durationMs: 250_000, costUsd: 0.12 },
  { agentId: 'frank', taskType: 'design', durationMs: 90_000, costUsd: 0.04 },
  { agentId: 'frank', taskType: 'design', durationMs: 110_000, costUsd: 0.05 },
  { agentId: 'frank', taskType: 'design', durationMs: 100_000, costUsd: 0.04 },
];

describe('TaskEstimator', () => {
  describe('estimate', () => {
    it('returns agent+type match with confidence intervals', async () => {
      const estimator = new TaskEstimator(mockStore(sampleHistory));
      const result = await estimator.estimate('eve', 'Frontend: build navbar');

      expect(result.basis).toBe('agent+type');
      expect(result.sampleCount).toBe(5);
      expect(result.confidence).toBe('medium');
      expect(result.estimatedMs).toBeGreaterThan(0);
      expect(result.lowerBoundMs).toBeLessThanOrEqual(result.estimatedMs);
      expect(result.upperBoundMs).toBeGreaterThanOrEqual(result.estimatedMs);
      expect(result.estimatedCostUsd).toBeGreaterThan(0);
    });

    it('falls back to agent-level when type has no data', async () => {
      const estimator = new TaskEstimator(mockStore(sampleHistory));
      const result = await estimator.estimate('eve', 'Security audit scan');

      // Eve has no 'security' tasks, but has 7 total
      expect(result.basis).toBe('agent');
      expect(result.sampleCount).toBe(7);
    });

    it('falls back to type-level when agent has no data', async () => {
      const estimator = new TaskEstimator(mockStore(sampleHistory));
      const result = await estimator.estimate('charlie', 'Design: new logo');

      // Charlie has no data, but 'design' type has 3 from frank
      expect(result.basis).toBe('type');
      expect(result.sampleCount).toBe(3);
    });

    it('falls back to global when nothing matches', async () => {
      const estimator = new TaskEstimator(mockStore(sampleHistory));
      const result = await estimator.estimate('unknown', 'random task xyz');

      expect(result.basis).toBe('global');
      expect(result.sampleCount).toBe(10);
    });

    it('returns none confidence when no data', async () => {
      const estimator = new TaskEstimator(mockStore([]));
      const result = await estimator.estimate('eve', 'Frontend: something');

      expect(result.confidence).toBe('none');
      expect(result.estimatedMs).toBe(0);
      expect(result.sampleCount).toBe(0);
    });

    it('returns high confidence with 10+ samples', async () => {
      const many = Array.from({ length: 15 }, (_, i) => ({
        agentId: 'eve',
        taskType: 'frontend',
        durationMs: 100_000 + i * 10_000,
        costUsd: 0.05 + i * 0.01,
      }));
      const estimator = new TaskEstimator(mockStore(many));
      const result = await estimator.estimate('eve', 'Frontend: big feature');

      expect(result.confidence).toBe('high');
      expect(result.sampleCount).toBe(15);
    });

    it('caches historical data', async () => {
      const store = mockStore(sampleHistory);
      const estimator = new TaskEstimator(store);

      await estimator.estimate('eve', 'Frontend: a');
      await estimator.estimate('eve', 'Frontend: b');

      expect(store.getTaskCompletionHistory).toHaveBeenCalledTimes(1);
    });
  });

  describe('estimateProject', () => {
    it('estimates project with parallelism', async () => {
      const store = mockStore(sampleHistory);
      store.getTasksByProject = vi.fn().mockResolvedValue([
        { id: 't1', title: 'Frontend: header', status: 'in_progress', assignedTo: 'eve' },
        { id: 't2', title: 'Design: footer', status: 'assigned', assignedTo: 'frank' },
        { id: 't3', title: 'Backend: API', status: 'backlog', assignedTo: null },
      ]);

      const estimator = new TaskEstimator(store);
      const result = await estimator.estimateProject('proj1');

      expect(result.projectId).toBe('proj1');
      expect(result.tasks).toHaveLength(3);
      expect(result.parallelism).toBe(2); // eve + frank active
      expect(result.totalRemainingMs).toBeGreaterThan(0);
    });

    it('excludes done and cancelled tasks', async () => {
      const store = mockStore(sampleHistory);
      store.getTasksByProject = vi.fn().mockResolvedValue([
        { id: 't1', title: 'Frontend: done', status: 'done', assignedTo: 'eve' },
        { id: 't2', title: 'Frontend: cancelled', status: 'cancelled', assignedTo: 'eve' },
        { id: 't3', title: 'Frontend: pending', status: 'backlog', assignedTo: null },
      ]);

      const estimator = new TaskEstimator(store);
      const result = await estimator.estimateProject('proj1');

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].taskId).toBe('t3');
    });
  });
});

import { describe, it, expect, vi } from 'vitest';
import { AgentScoringEngine } from './agent-scoring.js';
import type { AgentBlueprint } from './types.js';

// Mock StateStore
function mockStore(overrides: Record<string, any> = {}) {
  return {
    getAgentPerformance: vi.fn().mockResolvedValue({
      tasksCompleted: 10,
      tasksBlocked: 2,
      bugsIntroduced: 1,
      reworkPercent: 8.3,
      avgDurationMs: 120_000, // 2 min
      totalCostUsd: 0.50,
    }),
    getAgentWorkloads: vi.fn().mockResolvedValue([
      { agentId: 'eve', totalPending: 3 },
      { agentId: 'frank', totalPending: 0 },
    ]),
    ...overrides,
  } as any;
}

const blueprints: AgentBlueprint[] = [
  {
    id: 'eve',
    role: 'Senior Developer',
    name: 'Eve',
    systemPrompt: '',
    skills: ['TypeScript', 'React', 'Node.js', 'testing'],
    filePatterns: ['*.ts', '*.tsx'],
    slackChannels: [],
    kpis: [],
    reportsTo: 'diana',
    canCollabWith: [],
    blacklistOverrides: [],
  },
  {
    id: 'frank',
    role: 'UI/UX Designer',
    name: 'Frank',
    systemPrompt: '',
    skills: ['CSS', 'Figma', 'accessibility', 'design'],
    filePatterns: ['*.css', '*.scss'],
    slackChannels: [],
    kpis: [],
    reportsTo: 'diana',
    canCollabWith: [],
    blacklistOverrides: [],
  },
];

describe('AgentScoringEngine', () => {
  describe('computeScore', () => {
    it('returns a score between 0-100', async () => {
      const engine = new AgentScoringEngine(mockStore());
      const score = await engine.computeScore('eve', blueprints[0]);
      expect(score.efficiency).toBeGreaterThanOrEqual(0);
      expect(score.efficiency).toBeLessThanOrEqual(100);
      expect(score.name).toBe('Eve');
      expect(score.agentId).toBe('eve');
    });

    it('computes completion rate correctly', async () => {
      const engine = new AgentScoringEngine(mockStore());
      const score = await engine.computeScore('eve');
      // 10 completed out of 12 total (10 + 2 blocked)
      expect(score.completionRate).toBeCloseTo(0.83, 1);
    });

    it('computes avg cost per task', async () => {
      const engine = new AgentScoringEngine(mockStore());
      const score = await engine.computeScore('eve');
      // $0.50 / 10 tasks = $0.05
      expect(score.avgCostPerTask).toBeCloseTo(0.05, 2);
    });

    it('handles zero tasks gracefully', async () => {
      const store = mockStore({
        getAgentPerformance: vi.fn().mockResolvedValue({
          tasksCompleted: 0, tasksBlocked: 0, bugsIntroduced: 0,
          reworkPercent: 0, avgDurationMs: 0, totalCostUsd: 0,
        }),
      });
      const engine = new AgentScoringEngine(store);
      const score = await engine.computeScore('newbie');
      expect(score.efficiency).toBeGreaterThanOrEqual(0);
      expect(score.completionRate).toBe(0);
      expect(score.avgCostPerTask).toBe(0);
    });

    it('penalizes high rework rate', async () => {
      const goodStore = mockStore({
        getAgentPerformance: vi.fn().mockResolvedValue({
          tasksCompleted: 10, tasksBlocked: 0, bugsIntroduced: 0,
          reworkPercent: 0, avgDurationMs: 120_000, totalCostUsd: 0.50,
        }),
      });
      const badStore = mockStore({
        getAgentPerformance: vi.fn().mockResolvedValue({
          tasksCompleted: 10, tasksBlocked: 0, bugsIntroduced: 5,
          reworkPercent: 50, avgDurationMs: 120_000, totalCostUsd: 0.50,
        }),
      });
      const goodScore = await new AgentScoringEngine(goodStore).computeScore('a');
      const badScore = await new AgentScoringEngine(badStore).computeScore('b');
      expect(goodScore.efficiency).toBeGreaterThan(badScore.efficiency);
    });
  });

  describe('scoreAll', () => {
    it('returns all agents sorted by efficiency', async () => {
      const engine = new AgentScoringEngine(mockStore());
      const scores = await engine.scoreAll(blueprints);
      expect(scores).toHaveLength(2);
      // Both use the same mock data so scores should be equal
      expect(scores[0].efficiency).toBe(scores[1].efficiency);
    });
  });

  describe('routeTask', () => {
    it('ranks developer higher for TypeScript task', async () => {
      const engine = new AgentScoringEngine(mockStore({
        getAgentWorkloads: vi.fn().mockResolvedValue([]),
      }));
      const results = await engine.routeTask(
        blueprints,
        'Build TypeScript API',
        'Create a Node.js REST API with TypeScript and testing',
      );
      expect(results).toHaveLength(2);
      expect(results[0].agentId).toBe('eve');
      expect(results[0].skillMatch).toBeGreaterThan(results[1].skillMatch);
    });

    it('ranks designer higher for CSS/design task', async () => {
      const engine = new AgentScoringEngine(mockStore());
      const results = await engine.routeTask(
        blueprints,
        'Design new landing page',
        'Create CSS styles and improve accessibility with new design',
      );
      expect(results).toHaveLength(2);
      expect(results[0].agentId).toBe('frank');
    });

    it('excludes specified agents', async () => {
      const engine = new AgentScoringEngine(mockStore());
      const results = await engine.routeTask(
        blueprints,
        'Build API',
        'TypeScript REST API',
        ['eve'],
      );
      expect(results).toHaveLength(1);
      expect(results[0].agentId).toBe('frank');
    });

    it('applies workload penalty', async () => {
      const engine = new AgentScoringEngine(mockStore());
      const results = await engine.routeTask(
        blueprints,
        'General task with no specific skills',
        'Do something generic',
      );
      // Frank has 0 pending, Eve has 3 → Frank should get a boost
      const eve = results.find(r => r.agentId === 'eve')!;
      const frank = results.find(r => r.agentId === 'frank')!;
      // Eve gets -15 workload penalty (3 * 5), Frank gets 0
      expect(frank.routingScore).toBeGreaterThan(eve.routingScore);
    });
  });
});

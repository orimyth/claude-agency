import type { AgentBlueprint } from './types.js';
import type { StateStore } from './state-store.js';
import { Logger } from './logger.js';

const log = new Logger({ component: 'agent-scoring' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentScore {
  agentId: string;
  name: string;
  /** Composite score 0-100. Higher = better. */
  efficiency: number;
  /** Task completion rate (done / total assigned). */
  completionRate: number;
  /** Average cost per completed task (USD). */
  avgCostPerTask: number;
  /** Average duration per completed task (ms). */
  avgDurationMs: number;
  /** How many tasks completed total. */
  tasksCompleted: number;
  /** Bug/rework rate (0-1). Lower = better. */
  reworkRate: number;
  /** Skill match score for a specific task (0-1). */
  skillMatch: number;
  /** Composite routing score for task assignment. */
  routingScore: number;
}

// ---------------------------------------------------------------------------
// Scoring weights (tunable)
// ---------------------------------------------------------------------------

const WEIGHTS = {
  completionRate: 30,   // 30% weight
  speed: 20,            // 20% weight
  costEfficiency: 20,   // 20% weight
  reliability: 15,      // 15% weight (low rework)
  skillMatch: 15,       // 15% weight
} as const;

// ---------------------------------------------------------------------------
// Agent Scoring Engine
// ---------------------------------------------------------------------------

export class AgentScoringEngine {
  private store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  /**
   * Compute a composite efficiency score for an agent (0-100).
   * Used for performance dashboards and ranking.
   */
  async computeScore(agentId: string, blueprint?: AgentBlueprint): Promise<AgentScore> {
    const perf = await this.store.getAgentPerformance(agentId);
    const name = blueprint?.name ?? agentId;

    const totalAssigned = perf.tasksCompleted + perf.tasksBlocked;
    const completionRate = totalAssigned > 0
      ? perf.tasksCompleted / totalAssigned
      : 0;

    const avgCostPerTask = perf.tasksCompleted > 0
      ? perf.totalCostUsd / perf.tasksCompleted
      : 0;

    const reworkRate = perf.reworkPercent / 100;

    // Normalize each metric to 0-1 scale
    const completionScore = completionRate;
    const reliabilityScore = 1 - Math.min(reworkRate, 1);

    // Speed score: faster is better. Assume 5 min is excellent, 30 min is poor.
    const speedScore = perf.avgDurationMs > 0
      ? Math.max(0, 1 - (perf.avgDurationMs - 300_000) / 1_500_000)
      : 0.5; // no data → neutral

    // Cost score: cheaper is better. Assume $0.05/task is great, $2/task is poor.
    const costScore = avgCostPerTask > 0
      ? Math.max(0, 1 - (avgCostPerTask - 0.05) / 2)
      : 0.5; // no data → neutral

    // Composite (no skill match for general scoring)
    const efficiency = Math.round(
      completionScore * WEIGHTS.completionRate +
      speedScore * WEIGHTS.speed +
      costScore * WEIGHTS.costEfficiency +
      reliabilityScore * WEIGHTS.reliability +
      0.5 * WEIGHTS.skillMatch // neutral skill match for general score
    );

    return {
      agentId,
      name,
      efficiency: Math.min(100, Math.max(0, efficiency)),
      completionRate: Math.round(completionRate * 100) / 100,
      avgCostPerTask: Math.round(avgCostPerTask * 10000) / 10000,
      avgDurationMs: perf.avgDurationMs,
      tasksCompleted: perf.tasksCompleted,
      reworkRate: Math.round(reworkRate * 100) / 100,
      skillMatch: 0,
      routingScore: 0,
    };
  }

  /**
   * Score all agents and return sorted by efficiency (descending).
   */
  async scoreAll(blueprints: AgentBlueprint[]): Promise<AgentScore[]> {
    const scores = await Promise.all(
      blueprints.map(bp => this.computeScore(bp.id, bp))
    );
    return scores.sort((a, b) => b.efficiency - a.efficiency);
  }

  /**
   * Smart task routing: find the best agent for a task using
   * skill match + historical performance + current workload.
   */
  async routeTask(
    blueprints: AgentBlueprint[],
    taskTitle: string,
    taskDescription: string,
    excludeIds: string[] = [],
  ): Promise<AgentScore[]> {
    const text = `${taskTitle} ${taskDescription}`.toLowerCase();

    // Get workloads for all agents
    let workloads: Array<{ agentId: string; totalPending: number }> = [];
    try {
      workloads = await this.store.getAgentWorkloads();
    } catch {
      // Method may not exist yet
    }

    const candidates = blueprints.filter(bp => !excludeIds.includes(bp.id));
    const results: AgentScore[] = [];

    for (const bp of candidates) {
      const score = await this.computeScore(bp.id, bp);

      // Skill match scoring
      let skillScore = 0;
      let maxPossible = 0;
      const matchedSkills: string[] = [];

      for (const skill of bp.skills) {
        maxPossible++;
        if (text.includes(skill.toLowerCase())) {
          skillScore++;
          matchedSkills.push(skill);
        }
      }

      // File pattern hints
      for (const pattern of bp.filePatterns) {
        const ext = pattern.replace('*', '').toLowerCase();
        if (text.includes(ext)) skillScore += 0.5;
        maxPossible += 0.5;
      }

      // Role keyword match (strongest signal)
      const roleWords = bp.role.toLowerCase().split(/\s+/);
      for (const word of roleWords) {
        if (word.length > 3 && text.includes(word)) {
          skillScore += 2;
        }
        maxPossible += 2;
      }

      score.skillMatch = maxPossible > 0
        ? Math.round((skillScore / maxPossible) * 100) / 100
        : 0;

      // Workload penalty: agents with fewer pending tasks get a boost
      const wl = workloads.find(w => w.agentId === bp.id);
      const workloadPenalty = wl ? Math.min(wl.totalPending * 5, 20) : 0;

      // Composite routing score
      score.routingScore = Math.round(
        score.skillMatch * WEIGHTS.skillMatch * 2 +     // double weight for skill match in routing
        score.completionRate * WEIGHTS.completionRate +
        (1 - score.reworkRate) * WEIGHTS.reliability +
        (score.efficiency / 100) * WEIGHTS.speed -
        workloadPenalty
      );

      results.push(score);
    }

    results.sort((a, b) => b.routingScore - a.routingScore);

    if (results.length > 0) {
      log.info('Task routed', {
        task: taskTitle.slice(0, 60),
        bestAgent: results[0].name,
        routingScore: results[0].routingScore,
        skillMatch: results[0].skillMatch,
      });
    }

    return results;
  }
}

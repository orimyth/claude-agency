import type { StateStore } from './state-store.js';
import { Logger } from './logger.js';

const log = new Logger({ component: 'task-estimator' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskEstimate {
  /** Point estimate in milliseconds */
  estimatedMs: number;
  /** Lower bound (p25) */
  lowerBoundMs: number;
  /** Upper bound (p75) */
  upperBoundMs: number;
  /** Confidence level based on sample size */
  confidence: 'none' | 'low' | 'medium' | 'high';
  /** Number of historical data points used */
  sampleCount: number;
  /** What the estimate is based on */
  basis: 'agent+type' | 'agent' | 'type' | 'global';
  /** Estimated cost based on historical avg */
  estimatedCostUsd: number | null;
}

export interface ProjectEstimate {
  projectId: string;
  /** Total estimated time for remaining tasks */
  totalRemainingMs: number;
  /** Estimated completion date */
  estimatedCompletionAt: Date | null;
  /** Per-task breakdown */
  tasks: Array<{
    taskId: string;
    title: string;
    assignedTo: string | null;
    estimate: TaskEstimate;
  }>;
  /** Overall confidence */
  confidence: 'none' | 'low' | 'medium' | 'high';
  /** Parallelism factor (how many agents working concurrently) */
  parallelism: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

function confidenceFromSamples(n: number): TaskEstimate['confidence'] {
  if (n >= 10) return 'high';
  if (n >= 5) return 'medium';
  if (n >= 2) return 'low';
  return 'none';
}

function classifyTask(title: string): string {
  const t = title.toLowerCase();
  if (t.startsWith('qa review:') || t.includes('qa review')) return 'qa_review';
  if (t.startsWith('fix bugs:') || t.includes('bug fix')) return 'bug_fix';
  if (t.startsWith('code review:') || t.includes('code review')) return 'code_review';
  if (t.startsWith('code review fixes:')) return 'code_review_fix';
  if (t.startsWith('help ') || t.includes('handoff')) return 'handoff';
  if (t.startsWith('design:') || t.includes('design')) return 'design';
  if (t.startsWith('frontend:') || t.includes('frontend') || t.includes('ui')) return 'frontend';
  if (t.startsWith('backend:') || t.includes('backend') || t.includes('api')) return 'backend';
  if (t.startsWith('security') || t.includes('security')) return 'security';
  if (t.startsWith('architecture:') || t.includes('architecture')) return 'architecture';
  if (t.includes('test') || t.includes('testing')) return 'testing';
  if (t.includes('deploy') || t.includes('ci/cd')) return 'devops';
  if (t.includes('docs') || t.includes('documentation')) return 'documentation';
  return 'general';
}

// ---------------------------------------------------------------------------
// Task Estimator
// ---------------------------------------------------------------------------

interface HistoricalDataPoint {
  agentId: string;
  taskType: string;
  durationMs: number;
  costUsd: number;
}

export class TaskEstimator {
  private store: StateStore;
  private cache: HistoricalDataPoint[] | null = null;
  private cacheExpiry = 0;
  private readonly CACHE_TTL = 60_000; // 1 minute

  constructor(store: StateStore) {
    this.store = store;
  }

  /**
   * Fetch historical task completion data with caching.
   */
  private async getHistoricalData(): Promise<HistoricalDataPoint[]> {
    if (this.cache && Date.now() < this.cacheExpiry) return this.cache;

    try {
      const data = await this.store.getTaskCompletionHistory();
      this.cache = data;
      this.cacheExpiry = Date.now() + this.CACHE_TTL;
      return data;
    } catch {
      return this.cache ?? [];
    }
  }

  /**
   * Estimate duration and cost for a task, with confidence intervals.
   */
  async estimate(agentId: string | null, taskTitle: string): Promise<TaskEstimate> {
    const history = await this.getHistoricalData();
    const taskType = classifyTask(taskTitle);

    // Try progressively broader matches
    const strategies: Array<{
      filter: (d: HistoricalDataPoint) => boolean;
      basis: TaskEstimate['basis'];
    }> = [
      { filter: d => d.agentId === agentId && d.taskType === taskType, basis: 'agent+type' },
      { filter: d => d.agentId === agentId, basis: 'agent' },
      { filter: d => d.taskType === taskType, basis: 'type' },
      { filter: () => true, basis: 'global' },
    ];

    for (const { filter, basis } of strategies) {
      const matching = history.filter(filter);
      if (matching.length < 2) continue;

      const durations = matching.map(d => d.durationMs).sort((a, b) => a - b);
      const costs = matching.map(d => d.costUsd).filter(c => c > 0);

      const p25 = percentile(durations, 25);
      const p50 = percentile(durations, 50);
      const p75 = percentile(durations, 75);
      const avgCost = costs.length > 0
        ? costs.reduce((s, c) => s + c, 0) / costs.length
        : null;

      return {
        estimatedMs: Math.round(p50),
        lowerBoundMs: Math.round(p25),
        upperBoundMs: Math.round(p75),
        confidence: confidenceFromSamples(matching.length),
        sampleCount: matching.length,
        basis,
        estimatedCostUsd: avgCost ? Math.round(avgCost * 10000) / 10000 : null,
      };
    }

    return {
      estimatedMs: 0,
      lowerBoundMs: 0,
      upperBoundMs: 0,
      confidence: 'none',
      sampleCount: 0,
      basis: 'global',
      estimatedCostUsd: null,
    };
  }

  /**
   * Estimate completion time for an entire project.
   */
  async estimateProject(projectId: string): Promise<ProjectEstimate> {
    const tasks = await this.store.getTasksByProject(projectId);
    const remaining = tasks.filter(t =>
      !['done', 'cancelled'].includes(t.status)
    );

    const taskEstimates = await Promise.all(
      remaining.map(async t => ({
        taskId: t.id,
        title: t.title,
        assignedTo: t.assignedTo,
        estimate: await this.estimate(t.assignedTo, t.title),
      }))
    );

    // Count unique active agents for parallelism factor
    const activeAgents = new Set(
      remaining
        .filter(t => t.assignedTo && ['in_progress', 'assigned'].includes(t.status))
        .map(t => t.assignedTo!)
    );
    const parallelism = Math.max(activeAgents.size, 1);

    const totalMs = taskEstimates.reduce((s, t) => s + t.estimate.estimatedMs, 0);
    const effectiveMs = Math.round(totalMs / parallelism);

    // Determine overall confidence (worst of individual)
    const confidences: TaskEstimate['confidence'][] = taskEstimates.map(t => t.estimate.confidence);
    const confOrder = ['none', 'low', 'medium', 'high'] as const;
    const worstIdx = Math.min(...confidences.map(c => confOrder.indexOf(c)));

    const estimatedCompletion = effectiveMs > 0
      ? new Date(Date.now() + effectiveMs)
      : null;

    log.info('Project estimate computed', {
      projectId,
      remainingTasks: remaining.length,
      totalMs,
      parallelism,
      effectiveMs,
      confidence: confOrder[worstIdx],
    });

    return {
      projectId,
      totalRemainingMs: effectiveMs,
      estimatedCompletionAt: estimatedCompletion,
      tasks: taskEstimates,
      confidence: confOrder[worstIdx],
      parallelism,
    };
  }
}

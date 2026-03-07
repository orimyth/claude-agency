import type { StateStore } from './state-store.js';
import type { AgentManager } from './agent-manager.js';
import type { Task } from './types.js';

// ---------------------------------------------------------------------------
// Priority inference keywords
// ---------------------------------------------------------------------------

const URGENT_KEYWORDS = /\b(urgent|asap|critical|blocking|blocker|hotfix|emergency|immediately|showstopper)\b/i;
const HIGH_KEYWORDS = /\b(important|high.?priority|soon|needed|regression|broken|security)\b/i;
const LOW_KEYWORDS = /\b(nice.?to.?have|backlog|eventually|low.?priority|when.?you.?can|someday|minor|cosmetic)\b/i;

/** Infer priority 1-10 from title + description keywords. */
function inferPriority(title: string, description: string): number {
  const text = `${title} ${description}`;
  if (URGENT_KEYWORDS.test(text)) return 10;
  if (HIGH_KEYWORDS.test(text)) return 8;
  if (LOW_KEYWORDS.test(text)) return 3;
  return 6; // default — mid-range instead of max
}

// ---------------------------------------------------------------------------
// Route classification (keyword-based, no LLM needed)
// ---------------------------------------------------------------------------

type RouteTarget = 'ceo' | 'pm';

const SIMPLE_PATTERNS = /\b(fix typo|rename|update (readme|docs|config|version)|bump version|add comment|remove unused|change (color|text|label|title|icon)|refactor|lint|format)\b/i;

/**
 * Decide whether an idea needs CEO evaluation or can go directly to PM.
 * Simple/routine tasks skip the CEO to avoid bottleneck.
 */
function classifyRoute(title: string, description: string): RouteTarget {
  const text = `${title} ${description}`;
  // Short, simple tasks → PM can handle directly
  if (SIMPLE_PATTERNS.test(text) && description.length < 300) {
    return 'pm';
  }
  // Default: CEO evaluates
  return 'ceo';
}

// ---------------------------------------------------------------------------
// Duplicate similarity threshold
// ---------------------------------------------------------------------------

/** Minimum word overlap ratio to consider two tasks duplicates. */
const DUPLICATE_THRESHOLD = 0.65;

/** Normalize text for comparison: lowercase, strip punctuation, split to word set. */
function toWordSet(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2)
  );
}

/** Jaccard similarity between two word sets (0-1). */
function wordSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const word of a) {
    if (b.has(word)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface SubmitResult {
  taskId: string;
  /** Whether the task was routed to CEO or PM. */
  routedTo: RouteTarget;
  /** Inferred priority. */
  priority: number;
  /** If a duplicate was detected, the existing task ID + title. */
  duplicate?: { taskId: string; title: string; similarity: number };
}

/**
 * Routes incoming tasks/ideas from the investor.
 *
 * Features:
 * - **Smart routing**: simple tasks go to PM, complex to CEO
 * - **Priority inference**: keywords in title/description set priority automatically
 * - **Duplicate detection**: warns if a similar task already exists (still creates the task)
 */
export class TaskRouter {
  private store: StateStore;
  private agentManager: AgentManager;

  constructor(store: StateStore, agentManager: AgentManager) {
    this.store = store;
    this.agentManager = agentManager;
  }

  /**
   * Submit a new idea/task from the investor.
   * Classifies, deduplicates, infers priority, and routes to the right agent.
   */
  async submitIdea(title: string, description: string): Promise<SubmitResult> {
    const taskId = crypto.randomUUID();
    const priority = inferPriority(title, description);
    const routedTo = classifyRoute(title, description);

    // --- Duplicate detection ---
    const duplicate = await this.findDuplicate(title, description);

    // --- Build task ---
    const instructions = routedTo === 'ceo'
      ? [
          `The investor has submitted a new idea:`,
          ``,
          `"${description}"`,
          ``,
          `As CEO, evaluate this idea:`,
          `1. If it's straightforward, break it into tasks and assign to the team`,
          `2. If it's complex, consult with Charlie (architect) and create a plan for investor approval`,
          `3. Create subtasks and assign them to the right agents`,
        ]
      : [
          `The investor has submitted a routine task (auto-routed to PM):`,
          ``,
          `"${description}"`,
          ``,
          `As PM, handle this directly:`,
          `1. Break it into subtasks if needed`,
          `2. Assign to the appropriate developer(s)`,
          `3. No CEO review needed — this is a straightforward change`,
        ];

    if (duplicate) {
      instructions.push(
        ``,
        `⚠ NOTE: A similar task already exists: "${duplicate.title}" (${duplicate.taskId}, ${Math.round(duplicate.similarity * 100)}% similar).`,
        `Check if this is a duplicate before proceeding.`,
      );
    }

    const task: Task = {
      id: taskId,
      title: `[Investor Idea] ${title}`,
      description: instructions.join('\n'),
      status: 'assigned',
      projectId: null,
      assignedTo: routedTo,
      createdBy: 'investor',
      parentTaskId: null,
      dependsOn: null,
      priority,
      deadline: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    await this.store.createTask(task);
    await this.agentManager.assignTask(routedTo, task);

    return { taskId, routedTo, priority, duplicate: duplicate ?? undefined };
  }

  /**
   * Find the most similar existing non-done task. Returns null if no close match.
   */
  private async findDuplicate(
    title: string,
    description: string,
  ): Promise<{ taskId: string; title: string; similarity: number } | null> {
    // Only compare against recent active tasks (not done/archived)
    const activeTasks = await this.store.getActiveTasksForDedup();
    if (activeTasks.length === 0) return null;

    const inputWords = toWordSet(`${title} ${description}`);
    let bestMatch: { taskId: string; title: string; similarity: number } | null = null;

    for (const existing of activeTasks) {
      const existingWords = toWordSet(`${existing.title} ${existing.description ?? ''}`);
      const sim = wordSimilarity(inputWords, existingWords);
      if (sim >= DUPLICATE_THRESHOLD && (!bestMatch || sim > bestMatch.similarity)) {
        bestMatch = { taskId: existing.id, title: existing.title, similarity: sim };
      }
    }

    return bestMatch;
  }
}

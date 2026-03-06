import { query, type SDKResultMessage } from '@anthropic-ai/claude-code';
import type { StateStore } from './state-store.js';
import { dirname } from 'path';

// Same PATH fix as other modules
const nodeDir = dirname(process.execPath);
const memEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) memEnv[k] = v;
}
if (!memEnv.PATH?.includes(nodeDir)) {
  memEnv.PATH = `${nodeDir}:${memEnv.PATH || ''}`;
}

/** Max tokens of memory context to inject per agent call */
const MAX_CONTEXT_TOKENS = 2000;
/** Rough chars-per-token estimate */
const CHARS_PER_TOKEN = 4;
const MAX_CONTEXT_CHARS = MAX_CONTEXT_TOKENS * CHARS_PER_TOKEN;
/** When a scope+category has this many entries, auto-summarize */
const SUMMARIZE_THRESHOLD = 15;

/**
 * Lightweight model for utility tasks (JSON extraction, summarization).
 * Uses Haiku for simple structured output tasks — ~15x cheaper than Opus.
 */
const UTILITY_MODEL = 'claude-haiku-4-5-20251001';

/**
 * Role → relevant memory categories mapping.
 * Agents only see memories relevant to their function.
 */
const ROLE_CATEGORIES: Record<string, string[]> = {
  ceo: ['strategy', 'decisions', 'architecture', 'process', 'lessons', 'general'],
  hr: ['team', 'process', 'general'],
  architect: ['architecture', 'decisions', 'patterns', 'tech', 'security', 'lessons'],
  pm: ['process', 'sprint', 'decisions', 'lessons', 'general'],
  developer: ['patterns', 'tech', 'debugging', 'architecture', 'coding-standards'],
  'frontend-developer': ['patterns', 'tech', 'debugging', 'ui', 'coding-standards'],
  'backend-developer': ['patterns', 'tech', 'debugging', 'api', 'coding-standards'],
  designer: ['ui', 'design', 'patterns', 'accessibility'],
  researcher: ['tech', 'architecture', 'decisions', 'general'],
  security: ['security', 'patterns', 'architecture', 'coding-standards', 'debugging'],
  devops: ['infrastructure', 'tech', 'architecture', 'deployment', 'debugging'],
  qa: ['testing', 'patterns', 'debugging', 'coding-standards', 'lessons'],
};

export class MemoryManager {
  private store: StateStore;

  constructor(store: StateStore) {
    this.store = store;
  }

  /**
   * Save a memory entry. Called by agents after completing tasks or learning something.
   */
  async remember(opts: {
    type: 'decision' | 'lesson' | 'pattern' | 'context' | 'note';
    scope: string; // 'company' or 'project:{id}'
    category: string;
    title: string;
    content: string;
    importance?: number;
    createdBy?: string;
  }): Promise<string> {
    const id = crypto.randomUUID();
    await this.store.saveMemory({
      id,
      type: opts.type,
      scope: opts.scope,
      category: opts.category,
      title: opts.title,
      content: opts.content,
      importance: opts.importance ?? 5,
      createdBy: opts.createdBy ?? null,
    });

    // Check if we need to auto-summarize this scope+category
    const count = await this.store.countMemories(opts.scope, opts.category);
    if (count >= SUMMARIZE_THRESHOLD) {
      await this.summarizeCategory(opts.scope, opts.category);
    }

    return id;
  }

  /**
   * Build context string for an agent, filtered by role and project.
   * Stays within token budget.
   */
  async buildContext(agentId: string, projectId?: string | null): Promise<string> {
    const categories = ROLE_CATEGORIES[agentId] ?? ['general'];

    // Scopes to search: always include company, optionally include project
    const scopes = ['company'];
    if (projectId) scopes.push(`project:${projectId}`);

    const memories = await this.store.queryMemories({
      scopes,
      categories,
      limit: 30,
      minImportance: 3,
    });

    if (memories.length === 0) return '';

    // Build context within token budget
    const parts: string[] = [];
    let charCount = 0;

    for (const mem of memories) {
      const entry = `**[${mem.category}] ${mem.title}**: ${mem.content}`;
      if (charCount + entry.length > MAX_CONTEXT_CHARS) break;
      parts.push(entry);
      charCount += entry.length;
    }

    if (parts.length === 0) return '';

    return [
      '## Organizational Memory',
      'Key context from previous work and decisions:',
      '',
      ...parts,
    ].join('\n');
  }

  /**
   * Extract and save learnings from a completed task.
   * Called automatically after task completion.
   */
  async extractLearnings(agentId: string, taskTitle: string, taskResult: string, projectId?: string | null): Promise<void> {
    // Only extract if the result is substantial
    if (!taskResult || taskResult.length < 50) return;

    const scope = projectId ? `project:${projectId}` : 'company';

    // Use a quick Claude call to extract structured learnings
    try {
      const prompt = [
        `You just completed a task: "${taskTitle}"`,
        `Result: ${taskResult.slice(0, 1000)}`,
        '',
        'Extract 0-3 key learnings worth remembering for future work.',
        'For each, respond with JSON array:',
        '[{"category":"<tech|patterns|debugging|architecture|process|security>",',
        '  "title":"<short title>",',
        '  "content":"<1-2 sentence takeaway>",',
        '  "importance":<1-10>}]',
        '',
        'If nothing worth remembering, respond with [].',
        'Only output the JSON array, nothing else.',
      ].join('\n');

      const stream = query({
        prompt,
        options: {
          model: UTILITY_MODEL,
          allowedTools: [],
          maxTurns: 1,
          permissionMode: 'bypassPermissions',
          env: memEnv,
        },
      });

      let result = '';
      for await (const msg of stream) {
        if (msg.type === 'result') {
          const r = msg as SDKResultMessage;
          if (r.subtype === 'success') result = r.result;
        }
      }

      // Parse learnings
      const match = result.match(/\[[\s\S]*\]/);
      if (!match) return;

      const learnings = JSON.parse(match[0]);
      if (!Array.isArray(learnings)) return;

      for (const learning of learnings) {
        if (!learning.title || !learning.content) continue;
        await this.remember({
          type: 'lesson',
          scope,
          category: learning.category ?? 'general',
          title: learning.title,
          content: learning.content,
          importance: learning.importance ?? 5,
          createdBy: agentId,
        });
      }
    } catch {
      // Non-critical — don't break task flow for memory extraction
    }
  }

  /**
   * Auto-summarize old memories in a scope+category.
   * Compresses many small entries into fewer summaries.
   */
  private async summarizeCategory(scope: string, category: string): Promise<void> {
    try {
      const memories = await this.store.queryMemories({
        scope, category, limit: 50, minImportance: 1,
      });

      // Only summarize entries that aren't already summaries
      const toSummarize = memories.filter(m => m.type !== 'summary');
      if (toSummarize.length < SUMMARIZE_THRESHOLD) return;

      // Keep the top 5 most important as-is, summarize the rest
      const sorted = [...toSummarize].sort((a, b) => b.importance - a.importance);
      const keep = sorted.slice(0, 5);
      const compress = sorted.slice(5);

      if (compress.length < 5) return; // Not enough to bother

      const entriesText = compress
        .map(m => `- [${m.type}] ${m.title}: ${m.content}`)
        .join('\n');

      const prompt = [
        `Summarize these ${compress.length} organizational memories into 2-3 concise summary entries.`,
        `Category: ${category}, Scope: ${scope}`,
        '',
        entriesText,
        '',
        'Respond with JSON array: [{"title":"...","content":"1-2 sentences","importance":<avg>}]',
        'Only output the JSON array.',
      ].join('\n');

      const stream = query({
        prompt,
        options: { model: UTILITY_MODEL, allowedTools: [], maxTurns: 1, permissionMode: 'bypassPermissions', env: memEnv },
      });

      let result = '';
      for await (const msg of stream) {
        if (msg.type === 'result') {
          const r = msg as SDKResultMessage;
          if (r.subtype === 'success') result = r.result;
        }
      }

      const match = result.match(/\[[\s\S]*\]/);
      if (!match) return;

      const summaries = JSON.parse(match[0]);
      if (!Array.isArray(summaries)) return;

      // Save summaries and mark old entries as superseded
      const compressIds = compress.map(m => m.id);

      for (const summary of summaries) {
        const summaryId = crypto.randomUUID();
        await this.store.saveMemory({
          id: summaryId,
          type: 'summary',
          scope,
          category,
          title: summary.title ?? `${category} summary`,
          content: summary.content ?? '',
          importance: summary.importance ?? 5,
          createdBy: 'system',
        });
        // Mark the compressed entries as superseded
        await this.store.supersedMemories(compressIds, summaryId);
        break; // Only need to link to one summary
      }

      console.log(`[Memory] Summarized ${compress.length} entries in ${scope}/${category}`);
    } catch (err: any) {
      console.error(`[Memory] Summarization failed: ${err.message}`);
    }
  }

  /**
   * Get all active memories (for dashboard display).
   */
  async getAll(scope?: string) {
    return this.store.getAllMemories(scope);
  }
}

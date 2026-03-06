import type { AgentBlueprint } from './types.js';
import type { AgentManager } from './agent-manager.js';
import type { StateStore } from './state-store.js';

// Avatar pool counters — track which avatars are assigned
let nextMaleAvatar = 7;   // m1-m6 used by defaults
let nextFemaleAvatar = 7; // f1-f6 used by defaults
const MAX_AVATARS = 15;

export class HRManager {
  private agentManager: AgentManager;
  private store: StateStore;

  constructor(agentManager: AgentManager, store: StateStore) {
    this.agentManager = agentManager;
    this.store = store;
  }

  /**
   * Hire a new agent — saves blueprint to MySQL and registers with agent manager.
   */
  async hire(blueprint: AgentBlueprint): Promise<AgentBlueprint> {
    if (!blueprint.role && blueprint.name) {
      blueprint.role = blueprint.name;
    }

    if (!blueprint.id || !blueprint.role || !blueprint.name || !blueprint.systemPrompt) {
      throw new Error('Blueprint missing required fields: id, role, name, systemPrompt');
    }

    if (this.agentManager.getBlueprint(blueprint.id)) {
      throw new Error(`Agent with id '${blueprint.id}' already exists`);
    }

    blueprint.systemPrompt = this.injectCommunicationStyle(blueprint);

    blueprint.skills = blueprint.skills ?? [];
    blueprint.filePatterns = blueprint.filePatterns ?? ['**/*'];
    blueprint.slackChannels = blueprint.slackChannels ?? ['general'];
    blueprint.kpis = blueprint.kpis ?? [];
    blueprint.canCollabWith = blueprint.canCollabWith ?? [];
    blueprint.blacklistOverrides = blueprint.blacklistOverrides ?? [];

    if (!blueprint.avatar) {
      blueprint.gender = blueprint.gender ?? 'male';
      blueprint.avatar = this.assignAvatar(blueprint.gender);
    }

    // Save to unified blueprints table (not default)
    await this.store.saveBlueprint(blueprint, false);

    this.agentManager.registerBlueprint(blueprint);
    await this.agentManager.initializeAgent(blueprint);

    return blueprint;
  }

  /**
   * Fork an existing blueprint to create a variation.
   */
  async fork(sourceId: string, overrides: Partial<AgentBlueprint> & { id: string; name: string }): Promise<AgentBlueprint> {
    const source = this.agentManager.getBlueprint(sourceId);
    if (!source) throw new Error(`Source blueprint '${sourceId}' not found`);

    const newBlueprint: AgentBlueprint = { ...source, ...overrides };
    return this.hire(newBlueprint);
  }

  /**
   * Retire (deactivate) an agent — soft delete in MySQL.
   */
  async retire(agentId: string): Promise<void> {
    await this.agentManager.pauseAgent(agentId);
    await this.store.updateAgentStatus(agentId, 'paused');
    await this.store.deactivateBlueprint(agentId);
  }

  /**
   * Update an existing agent's blueprint (e.g., change system prompt).
   */
  async updateAgent(id: string, updates: Partial<AgentBlueprint>): Promise<AgentBlueprint> {
    const existing = this.agentManager.getBlueprint(id);
    if (!existing) throw new Error(`Agent '${id}' not found`);

    const updated: AgentBlueprint = { ...existing, ...updates, id }; // id can't change
    await this.store.updateBlueprint(id, updated);
    this.agentManager.registerBlueprint(updated); // re-register with new data

    return updated;
  }

  getRoster(): AgentBlueprint[] {
    return this.agentManager.getAllBlueprints();
  }

  /**
   * Get non-default (hired) agents.
   */
  async getHiredAgents(): Promise<AgentBlueprint[]> {
    return this.store.getHiredBlueprints();
  }

  private assignAvatar(gender: 'male' | 'female'): string {
    if (gender === 'male') {
      const idx = nextMaleAvatar <= MAX_AVATARS ? nextMaleAvatar++ : Math.ceil(Math.random() * MAX_AVATARS);
      return `/avatars/male/m${idx}.jpg`;
    } else {
      const idx = nextFemaleAvatar <= MAX_AVATARS ? nextFemaleAvatar++ : Math.ceil(Math.random() * MAX_AVATARS);
      return `/avatars/female/f${idx}.jpg`;
    }
  }

  private injectCommunicationStyle(blueprint: AgentBlueprint): string {
    const styleGuide = `

IMPORTANT — COMMUNICATION STYLE:
- Write like a real human coworker on Slack. Short, casual messages.
- NO bullet lists. NO markdown headers. NO AI-style verbose responses.
- Use multiple short messages instead of one wall of text.
- Be direct and decisive. Don't hedge with "perhaps" or "it might be beneficial".
- Examples of good messages:
  "done with the auth module, pushing now"
  "hey charlie, can you review the db schema? something feels off with the relations"
  "blocked — need access to the API keys, who has them?"`;

    if (blueprint.systemPrompt.includes('COMMUNICATION STYLE')) {
      return blueprint.systemPrompt;
    }
    return blueprint.systemPrompt + styleGuide;
  }

  /**
   * Parse a blueprint from HR agent output.
   */
  static parseBlueprint(agentOutput: string): AgentBlueprint | null {
    const codeBlockMatch = agentOutput.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const rawJsonMatch = agentOutput.match(/(\{[\s\S]*"id"[\s\S]*"systemPrompt"[\s\S]*\})/);
    const rawJsonMatch2 = agentOutput.match(/(\{[\s\S]*"systemPrompt"[\s\S]*"id"[\s\S]*\})/);

    const jsonStr = codeBlockMatch?.[1] ?? rawJsonMatch?.[0] ?? rawJsonMatch2?.[0];
    if (!jsonStr) return null;

    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.id && parsed.name && parsed.systemPrompt) {
        return parsed as AgentBlueprint;
      }
      return null;
    } catch {
      try {
        const cleaned = jsonStr.replace(/,\s*([\]}])/g, '$1');
        const parsed = JSON.parse(cleaned);
        if (parsed.id && parsed.name && parsed.systemPrompt) {
          return parsed as AgentBlueprint;
        }
      } catch { /* give up */ }
      return null;
    }
  }
}

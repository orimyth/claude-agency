import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AgentBlueprint } from './types.js';
import type { AgentManager } from './agent-manager.js';
import type { StateStore } from './state-store.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CUSTOM_BLUEPRINTS_DIR = resolve(__dirname, '../../../data/blueprints');

// Avatar pool counters — track which avatars are assigned
let nextMaleAvatar = 5;   // m1-m4 used by defaults (Bob, Charlie, Frank, Alex)
let nextFemaleAvatar = 6; // f1-f5 used by defaults (Alice, Diana, Eve, Grace, Maya)
const MAX_AVATARS = 15;

export class HRManager {
  private agentManager: AgentManager;
  private store: StateStore;
  private customBlueprints: Map<string, AgentBlueprint> = new Map();

  constructor(agentManager: AgentManager, store: StateStore) {
    this.agentManager = agentManager;
    this.store = store;
    this.loadCustomBlueprints();
  }

  private loadCustomBlueprints(): void {
    if (!existsSync(CUSTOM_BLUEPRINTS_DIR)) {
      mkdirSync(CUSTOM_BLUEPRINTS_DIR, { recursive: true });
      return;
    }

    const files = readdirSync(CUSTOM_BLUEPRINTS_DIR).filter(f => f.endsWith('.json'));
    for (const file of files) {
      try {
        const content = readFileSync(resolve(CUSTOM_BLUEPRINTS_DIR, file), 'utf-8');
        const blueprint = JSON.parse(content) as AgentBlueprint;
        this.customBlueprints.set(blueprint.id, blueprint);
      } catch {
        // Skip invalid files
      }
    }
  }

  /**
   * Create a new agent from a blueprint definition.
   * Called by the HR agent when it outputs a blueprint JSON.
   */
  async hire(blueprint: AgentBlueprint): Promise<AgentBlueprint> {
    // Set role from name if missing
    if (!blueprint.role && blueprint.name) {
      blueprint.role = blueprint.name;
    }

    // Validate required fields
    if (!blueprint.id || !blueprint.role || !blueprint.name || !blueprint.systemPrompt) {
      throw new Error('Blueprint missing required fields: id, role, name, systemPrompt');
    }

    // Check for duplicate IDs
    if (this.agentManager.getBlueprint(blueprint.id)) {
      throw new Error(`Agent with id '${blueprint.id}' already exists`);
    }

    // Inject the human-like communication style into the system prompt
    blueprint.systemPrompt = this.injectCommunicationStyle(blueprint);

    // Set defaults
    blueprint.skills = blueprint.skills ?? [];
    blueprint.filePatterns = blueprint.filePatterns ?? ['**/*'];
    blueprint.slackChannels = blueprint.slackChannels ?? ['general'];
    blueprint.kpis = blueprint.kpis ?? [];
    blueprint.canCollabWith = blueprint.canCollabWith ?? [];
    blueprint.blacklistOverrides = blueprint.blacklistOverrides ?? [];

    // Assign avatar if not set
    if (!blueprint.avatar) {
      blueprint.gender = blueprint.gender ?? 'male';
      blueprint.avatar = this.assignAvatar(blueprint.gender);
    }

    // Save to disk
    const filePath = resolve(CUSTOM_BLUEPRINTS_DIR, `${blueprint.id}.json`);
    writeFileSync(filePath, JSON.stringify(blueprint, null, 2));

    // Register with agent manager
    this.agentManager.registerBlueprint(blueprint);
    await this.agentManager.initializeAgent(blueprint);
    this.customBlueprints.set(blueprint.id, blueprint);

    return blueprint;
  }

  /**
   * Fork an existing blueprint to create a new one.
   * Used by HR to quickly create similar roles.
   */
  async fork(sourceId: string, overrides: Partial<AgentBlueprint> & { id: string; name: string }): Promise<AgentBlueprint> {
    const source = this.agentManager.getBlueprint(sourceId);
    if (!source) throw new Error(`Source blueprint '${sourceId}' not found`);

    const newBlueprint: AgentBlueprint = {
      ...source,
      ...overrides,
    };

    return this.hire(newBlueprint);
  }

  /**
   * Retire an agent — mark as inactive, remove from active roster.
   */
  async retire(agentId: string): Promise<void> {
    await this.agentManager.pauseAgent(agentId);
    await this.store.updateAgentStatus(agentId, 'paused');

    // Remove custom blueprint file if it exists
    const filePath = resolve(CUSTOM_BLUEPRINTS_DIR, `${agentId}.json`);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    this.customBlueprints.delete(agentId);
  }

  /**
   * Get all agents (default + custom).
   */
  getRoster(): AgentBlueprint[] {
    return this.agentManager.getAllBlueprints();
  }

  getCustomBlueprints(): AgentBlueprint[] {
    return Array.from(this.customBlueprints.values());
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

    // Prepend to existing prompt if not already there
    if (blueprint.systemPrompt.includes('COMMUNICATION STYLE')) {
      return blueprint.systemPrompt;
    }
    return blueprint.systemPrompt + styleGuide;
  }

  /**
   * Parse a blueprint from HR agent output.
   * The HR agent outputs JSON when creating new roles.
   */
  static parseBlueprint(agentOutput: string): AgentBlueprint | null {
    // Try to extract the largest JSON object from the output
    // Look for JSON blocks (possibly wrapped in ```json ... ```)
    const codeBlockMatch = agentOutput.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    const rawJsonMatch = agentOutput.match(/(\{[\s\S]*"id"[\s\S]*"systemPrompt"[\s\S]*\})/);
    const rawJsonMatch2 = agentOutput.match(/(\{[\s\S]*"systemPrompt"[\s\S]*"id"[\s\S]*\})/);

    const jsonStr = codeBlockMatch?.[1] ?? rawJsonMatch?.[0] ?? rawJsonMatch2?.[0];
    if (!jsonStr) return null;

    try {
      const parsed = JSON.parse(jsonStr);
      // Validate minimum fields
      if (parsed.id && parsed.name && parsed.systemPrompt) {
        return parsed as AgentBlueprint;
      }
      return null;
    } catch {
      // Try to fix common JSON issues (trailing commas, etc.)
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

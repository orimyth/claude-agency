import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, join } from 'path';

/**
 * Two-layer memory system:
 * 1. Project memory — per-project context, decisions, patterns
 * 2. Company knowledge base — shared institutional knowledge
 */
export class MemoryManager {
  private knowledgeBasePath: string;

  constructor(agencyRootPath: string) {
    this.knowledgeBasePath = resolve(agencyRootPath, 'data', 'knowledge-base');
    mkdirSync(this.knowledgeBasePath, { recursive: true });
  }

  // --- Project Memory ---

  getProjectMemoryPath(workspacePath: string): string {
    const memPath = join(workspacePath, '.agency', 'memory');
    mkdirSync(memPath, { recursive: true });
    return memPath;
  }

  readProjectMemory(workspacePath: string, key: string): string | null {
    const filePath = join(this.getProjectMemoryPath(workspacePath), `${key}.md`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  writeProjectMemory(workspacePath: string, key: string, content: string): void {
    const filePath = join(this.getProjectMemoryPath(workspacePath), `${key}.md`);
    writeFileSync(filePath, content);
  }

  listProjectMemories(workspacePath: string): string[] {
    const memPath = this.getProjectMemoryPath(workspacePath);
    if (!existsSync(memPath)) return [];
    return readdirSync(memPath)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''));
  }

  getProjectContext(workspacePath: string): string {
    const memories = this.listProjectMemories(workspacePath);
    if (memories.length === 0) return '';

    const sections = memories.map(key => {
      const content = this.readProjectMemory(workspacePath, key);
      return `## ${key}\n${content}`;
    });

    return `# Project Context\n\n${sections.join('\n\n')}`;
  }

  // --- Company Knowledge Base ---

  readKnowledge(topic: string): string | null {
    const filePath = join(this.knowledgeBasePath, `${topic}.md`);
    if (!existsSync(filePath)) return null;
    return readFileSync(filePath, 'utf-8');
  }

  writeKnowledge(topic: string, content: string): void {
    const filePath = join(this.knowledgeBasePath, `${topic}.md`);
    writeFileSync(filePath, content);
  }

  appendKnowledge(topic: string, entry: string): void {
    const existing = this.readKnowledge(topic) ?? '';
    const timestamp = new Date().toISOString().split('T')[0];
    const updated = existing + `\n\n### ${timestamp}\n${entry}`;
    this.writeKnowledge(topic, updated.trim());
  }

  listKnowledge(): string[] {
    if (!existsSync(this.knowledgeBasePath)) return [];
    return readdirSync(this.knowledgeBasePath)
      .filter(f => f.endsWith('.md'))
      .map(f => f.replace('.md', ''));
  }

  getKnowledgeContext(relevantTopics?: string[]): string {
    const topics = relevantTopics ?? this.listKnowledge();
    if (topics.length === 0) return '';

    const sections = topics
      .map(topic => {
        const content = this.readKnowledge(topic);
        if (!content) return null;
        return `## ${topic}\n${content}`;
      })
      .filter(Boolean);

    return `# Company Knowledge Base\n\n${sections.join('\n\n')}`;
  }

  // --- Context injection for agent prompts ---

  buildContextForAgent(agentRole: string, workspacePath?: string): string {
    const parts: string[] = [];

    // Add relevant knowledge base entries based on role
    const roleTopics = this.getRelevantTopics(agentRole);
    const kbContext = this.getKnowledgeContext(roleTopics);
    if (kbContext) parts.push(kbContext);

    // Add project memory if workspace provided
    if (workspacePath) {
      const projectContext = this.getProjectContext(workspacePath);
      if (projectContext) parts.push(projectContext);
    }

    return parts.join('\n\n---\n\n');
  }

  private getRelevantTopics(role: string): string[] {
    const allTopics = this.listKnowledge();
    // Roles see different slices of the knowledge base
    const roleRelevance: Record<string, string[]> = {
      ceo: allTopics, // CEO sees everything
      architect: allTopics.filter(t => ['architecture', 'tech-decisions', 'patterns', 'lessons'].some(k => t.includes(k))),
      pm: allTopics.filter(t => ['processes', 'sprint', 'retrospective', 'lessons'].some(k => t.includes(k))),
      developer: allTopics.filter(t => ['patterns', 'tech-decisions', 'coding-standards', 'debugging'].some(k => t.includes(k))),
      designer: allTopics.filter(t => ['design', 'ui', 'ux', 'accessibility', 'components'].some(k => t.includes(k))),
      researcher: allTopics,
      hr: allTopics.filter(t => ['team', 'roles', 'processes'].some(k => t.includes(k))),
    };
    return roleRelevance[role] ?? allTopics.slice(0, 5);
  }
}

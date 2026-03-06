import type { WebClient } from '@slack/web-api';

export const DEFAULT_CHANNELS = [
  { name: 'agency-general', topic: 'Company-wide announcements and updates' },
  { name: 'agency-ceo-investor', topic: 'Direct line between investor and CEO (Alice)' },
  { name: 'agency-leadership', topic: 'CEO + managers coordination' },
  { name: 'agency-approvals', topic: 'Plans and decisions awaiting investor approval' },
  { name: 'agency-hr-hiring', topic: 'New agent roles and onboarding' },
] as const;

export type ChannelName = (typeof DEFAULT_CHANNELS)[number]['name'] | `agency-project-${string}`;

export class ChannelManager {
  private client: WebClient;
  private channelMap: Map<string, string> = new Map(); // name -> channelId
  private botUserId: string | null = null;

  constructor(client: WebClient) {
    this.client = client;
  }

  async initialize(): Promise<void> {
    // Get bot user ID
    const authResult = await this.client.auth.test();
    this.botUserId = authResult.user_id as string;

    // Discover existing channels
    await this.syncExistingChannels();
  }

  private async syncExistingChannels(): Promise<void> {
    let cursor: string | undefined;
    do {
      const result = await this.client.conversations.list({
        limit: 200,
        cursor,
        types: 'public_channel,private_channel',
      });
      for (const channel of result.channels ?? []) {
        if (channel.name && channel.id) {
          this.channelMap.set(channel.name, channel.id);
        }
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
  }

  async ensureDefaultChannels(): Promise<Map<string, string>> {
    for (const ch of DEFAULT_CHANNELS) {
      await this.ensureChannel(ch.name, ch.topic);
    }
    return new Map(this.channelMap);
  }

  async ensureChannel(name: string, topic?: string): Promise<string> {
    const existing = this.channelMap.get(name);
    if (existing) return existing;

    try {
      const result = await this.client.conversations.create({ name });
      const channelId = result.channel?.id;
      if (!channelId) throw new Error(`Failed to create channel #${name}`);

      this.channelMap.set(name, channelId);

      if (topic) {
        await this.client.conversations.setTopic({ channel: channelId, topic }).catch(() => {});
      }

      return channelId;
    } catch (err: any) {
      if (err.data?.error === 'name_taken') {
        // Channel exists but we didn't find it earlier — refresh and retry
        await this.syncExistingChannels();
        const id = this.channelMap.get(name);
        if (id) return id;
      }
      throw err;
    }
  }

  async createProjectChannel(projectName: string): Promise<string> {
    const channelName = `agency-project-${projectName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 60)}`;
    return this.ensureChannel(channelName, `Project: ${projectName}`);
  }

  getChannelId(name: string): string | undefined {
    return this.channelMap.get(name);
  }

  getChannelName(id: string): string | undefined {
    for (const [name, channelId] of this.channelMap) {
      if (channelId === id) return name;
    }
    return undefined;
  }

  getAllChannels(): Map<string, string> {
    return new Map(this.channelMap);
  }
}

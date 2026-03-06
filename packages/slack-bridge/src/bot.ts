import { App } from '@slack/bolt';

interface SlackBridgeConfig {
  botToken: string;
  signingSecret: string;
  appToken: string;
}

export class SlackBridge {
  private app: App;
  private channels: Map<string, string> = new Map(); // name -> channelId

  constructor(config: SlackBridgeConfig) {
    this.app = new App({
      token: config.botToken,
      signingSecret: config.signingSecret,
      socketMode: true,
      appToken: config.appToken,
    });
  }

  async start(): Promise<void> {
    await this.app.start();
    console.log('Slack bridge connected');
  }

  async sendMessage(channel: string, text: string, agentName?: string): Promise<void> {
    const channelId = this.channels.get(channel);
    if (!channelId) {
      console.warn(`Slack channel '${channel}' not found`);
      return;
    }

    await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      username: agentName,
    });
  }

  async createChannel(name: string): Promise<string | null> {
    try {
      const result = await this.app.client.conversations.create({
        name: name.toLowerCase().replace(/\s+/g, '-'),
      });
      const channelId = result.channel?.id;
      if (channelId) {
        this.channels.set(name, channelId);
      }
      return channelId ?? null;
    } catch (err: any) {
      if (err.data?.error === 'name_taken') {
        // Channel already exists, find it
        const list = await this.app.client.conversations.list({ limit: 1000 });
        const existing = list.channels?.find(c => c.name === name);
        if (existing?.id) {
          this.channels.set(name, existing.id);
          return existing.id;
        }
      }
      console.error(`Failed to create channel '${name}':`, err.message);
      return null;
    }
  }

  onMessage(handler: (channel: string, userId: string, text: string) => void): void {
    this.app.message(async ({ message, say }) => {
      if (message.subtype) return; // Skip bot messages, edits, etc.
      const msg = message as any;
      handler(msg.channel, msg.user, msg.text);
    });
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

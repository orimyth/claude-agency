import { App } from '@slack/bolt';
import { EventEmitter } from 'events';
import { ChannelManager } from './channels.js';
import { formatAgentMessage, formatApprovalRequest, formatStatusUpdate, avatarToPublicUrl } from './message-formatter.js';

export interface SlackBridgeConfig {
  botToken: string;
  signingSecret: string;
  appToken: string;
}

export interface InvestorMessage {
  channel: string;
  channelName: string;
  userId: string;
  text: string;
  threadTs?: string;
  mentionedAgents?: string[];
}

export class SlackBridge extends EventEmitter {
  private app: App;
  private channelManager: ChannelManager;
  private config: SlackBridgeConfig;
  private investorUserId: string | null = null;

  constructor(config: SlackBridgeConfig) {
    super();
    this.config = config;
    this.app = new App({
      token: config.botToken,
      signingSecret: config.signingSecret,
      socketMode: true,
      appToken: config.appToken,
    });
    this.channelManager = new ChannelManager(this.app.client);
    this.setupListeners();
  }

  async start(): Promise<void> {
    await this.app.start();
    await this.channelManager.initialize();
    await this.channelManager.ensureDefaultChannels();
    console.log('[Slack] Connected and channels ready');
  }

  // Agent name → id mapping for mention detection
  private agentNames: Map<string, string> = new Map();

  setAgentNames(agents: { id: string; name: string }[]): void {
    this.agentNames.clear();
    for (const a of agents) {
      this.agentNames.set(a.name.toLowerCase(), a.id);
    }
  }

  private parseMentionedAgents(text: string): string[] {
    const mentioned: string[] = [];
    const lower = text.toLowerCase();
    for (const [name, id] of this.agentNames) {
      // Match @name or just the name when clearly addressing them
      if (lower.includes(`@${name}`) || new RegExp(`\\b${name}\\b`).test(lower)) {
        mentioned.push(id);
      }
    }
    return mentioned;
  }

  private setupListeners(): void {
    // Listen for messages in all channels
    this.app.message(async ({ message, say }) => {
      // Skip bot messages
      if ((message as any).bot_id || message.subtype) return;

      const msg = message as any;
      const channelName = this.channelManager.getChannelName(msg.channel);
      const text = msg.text ?? '';

      const investorMsg: InvestorMessage = {
        channel: msg.channel,
        channelName: channelName ?? msg.channel,
        userId: msg.user,
        text,
        threadTs: msg.thread_ts,
        mentionedAgents: this.parseMentionedAgents(text),
      };

      // Route based on channel
      if (channelName === 'agency-ceo-investor') {
        this.emit('investor:message', investorMsg);
      } else if (channelName === 'agency-approvals') {
        this.emit('investor:approval_response', investorMsg);
      } else if (channelName?.startsWith('agency-')) {
        this.emit('channel:message', investorMsg);
      }
    });

    // Handle approval button clicks
    this.app.action('approval_approve', async ({ ack, body, client }) => {
      await ack();
      const actionBody = body as any;
      const approvalId = actionBody.message?.metadata?.event_payload?.approval_id;
      const channel = actionBody.channel?.id;
      this.emit('approval:resolve', {
        approvalId,
        status: 'approved',
        userId: actionBody.user.id,
        messageTs: actionBody.message?.ts,
        channel,
      });
      if (channel) {
        await client.chat.postMessage({ channel, text: 'Approved :white_check_mark:', thread_ts: actionBody.message?.ts });
      }
    });

    this.app.action('approval_reject', async ({ ack, body, client }) => {
      await ack();
      const actionBody = body as any;
      const approvalId = actionBody.message?.metadata?.event_payload?.approval_id;
      const channel = actionBody.channel?.id;
      this.emit('approval:resolve', {
        approvalId,
        status: 'rejected',
        userId: actionBody.user.id,
        messageTs: actionBody.message?.ts,
        channel,
      });
      if (channel) {
        await client.chat.postMessage({ channel, text: 'Rejected :x:', thread_ts: actionBody.message?.ts });
      }
    });

    this.app.action('approval_modify', async ({ ack, body, client }) => {
      await ack();
      const actionBody = body as any;
      const channel = actionBody.channel?.id;
      if (channel) {
        await client.chat.postMessage({
          channel,
          text: 'Please reply in this thread with your modifications.',
          thread_ts: actionBody.message?.ts,
        });
      }
    });
  }

  // --- Sending messages ---

  async sendAgentMessage(channelName: string, agentName: string, role: string, content: string, avatar?: string | null): Promise<void> {
    const channelId = this.channelManager.getChannelId(channelName);
    if (!channelId) {
      console.warn(`[Slack] Channel '${channelName}' not found, skipping message`);
      return;
    }

    const publicAvatarUrl = avatarToPublicUrl(avatar);
    const formatted = formatAgentMessage(agentName, role, content, publicAvatarUrl);

    const msgPayload: Record<string, unknown> = {
      channel: channelId,
      text: formatted.text,
      username: formatted.username,
    };

    if (formatted.icon_url) {
      msgPayload.icon_url = formatted.icon_url;
    } else if (formatted.icon_emoji) {
      msgPayload.icon_emoji = formatted.icon_emoji;
    }

    await this.app.client.chat.postMessage(msgPayload as any);
  }

  async sendApprovalRequest(approvalId: string, title: string, description: string, agentName: string): Promise<void> {
    const channelId = this.channelManager.getChannelId('agency-approvals');
    if (!channelId) return;

    const blocks = formatApprovalRequest(title, description, agentName);
    await this.app.client.chat.postMessage({
      channel: channelId,
      text: `Approval needed: ${title}`,
      blocks: blocks as any,
      metadata: {
        event_type: 'approval_request',
        event_payload: { approval_id: approvalId },
      },
    });

    // Also notify in CEO-investor channel
    const investorChannel = this.channelManager.getChannelId('agency-ceo-investor');
    if (investorChannel) {
      await this.app.client.chat.postMessage({
        channel: investorChannel,
        text: `hey, need your sign-off on something — check #agency-approvals for "${title}"`,
        username: `${agentName} (CEO)`,
        icon_emoji: ':briefcase:',
      });
    }
  }

  async sendStatusUpdate(agents: { name: string; role: string; status: string }[]): Promise<void> {
    const channelId = this.channelManager.getChannelId('agency-general');
    if (!channelId) return;

    const blocks = formatStatusUpdate(agents);
    await this.app.client.chat.postMessage({
      channel: channelId,
      text: 'Agency Status Update',
      blocks: blocks as any,
    });
  }

  async createProjectChannel(projectName: string): Promise<string> {
    return this.channelManager.createProjectChannel(projectName);
  }

  getChannelManager(): ChannelManager {
    return this.channelManager;
  }

  async stop(): Promise<void> {
    await this.app.stop();
  }
}

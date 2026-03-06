/**
 * Formats agent messages for Slack display.
 * Agents write like humans, but we add subtle context (name, role).
 */

export interface AgentIdentity {
  name: string;
  role: string;
  emoji: string;
}

const AGENT_EMOJIS: Record<string, string> = {
  ceo: ':briefcase:',
  hr: ':busts_in_silhouette:',
  architect: ':building_construction:',
  pm: ':clipboard:',
  developer: ':computer:',
  designer: ':art:',
  researcher: ':mag:',
  security: ':lock:',
  devops: ':gear:',
  qa: ':white_check_mark:',
};

export function getAgentEmoji(role: string): string {
  return AGENT_EMOJIS[role.toLowerCase()] ?? ':robot_face:';
}

/**
 * Convert a local avatar path to a public URL.
 * Local: /avatars/female/f1.jpg → https://randomuser.me/api/portraits/women/1.jpg
 * Local: /avatars/male/m3.jpg   → https://randomuser.me/api/portraits/men/3.jpg
 */
export function avatarToPublicUrl(avatarPath: string | null | undefined): string | null {
  if (!avatarPath) return null;

  const femaleMatch = avatarPath.match(/\/avatars\/female\/f(\d+)\.jpg/);
  if (femaleMatch) {
    return `https://randomuser.me/api/portraits/women/${femaleMatch[1]}.jpg`;
  }

  const maleMatch = avatarPath.match(/\/avatars\/male\/m(\d+)\.jpg/);
  if (maleMatch) {
    return `https://randomuser.me/api/portraits/men/${maleMatch[1]}.jpg`;
  }

  // If it's already a full URL, use it directly
  if (avatarPath.startsWith('http')) return avatarPath;

  return null;
}

export function formatAgentMessage(agentName: string, role: string, content: string, avatarUrl?: string | null): {
  text: string;
  username: string;
  icon_emoji?: string;
  icon_url?: string;
} {
  const result: {
    text: string;
    username: string;
    icon_emoji?: string;
    icon_url?: string;
  } = {
    text: content,
    username: `${agentName} (${role})`,
  };

  if (avatarUrl) {
    result.icon_url = avatarUrl;
  } else {
    result.icon_emoji = getAgentEmoji(role);
  }

  return result;
}

export function formatApprovalRequest(title: string, description: string, agentName: string): object[] {
  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: `Approval needed: ${title}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: description },
    },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `Requested by *${agentName}*` },
      ],
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve' },
          style: 'primary',
          action_id: 'approval_approve',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Reject' },
          style: 'danger',
          action_id: 'approval_reject',
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Modify' },
          action_id: 'approval_modify',
        },
      ],
    },
  ];
}

export function formatStatusUpdate(agents: { name: string; role: string; status: string }[]): object[] {
  const lines = agents.map(a => {
    const emoji = a.status === 'active' ? ':large_green_circle:'
      : a.status === 'on_break' ? ':coffee:'
      : a.status === 'error' ? ':red_circle:'
      : ':white_circle:';
    return `${emoji} *${a.name}* (${a.role}) — ${a.status}`;
  });

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Agency Status' },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: lines.join('\n') },
    },
  ];
}

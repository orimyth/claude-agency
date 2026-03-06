import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebClient } from '@slack/web-api';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

async function main() {
  console.log(`
  =============================================
   Slack Setup Wizard for Claude Agency
  =============================================

  This wizard will help you connect your Slack workspace.

  Before starting, you need to create a Slack App:

  1. Go to https://api.slack.com/apps
  2. Click "Create New App" > "From scratch"
  3. Name it "Claude Agency" and select your workspace
  4. Under "Socket Mode" — enable it, create an app-level token with
     connections:write scope. Save this as your App Token (xapp-...)
  5. Under "OAuth & Permissions" add these Bot Token Scopes:
     - chat:write
     - chat:write.customize
     - channels:manage
     - channels:read
     - channels:history
     - channels:join
     - groups:read
     - groups:history
     - users:read
     - reactions:write
     - metadata.message:read
  6. Under "Event Subscriptions" — enable and subscribe to:
     - message.channels
     - message.groups
  7. Under "Interactivity & Shortcuts" — enable interactivity
  8. Install the app to your workspace
  9. Copy the Bot User OAuth Token (xoxb-...) and Signing Secret

  Press Enter when you have these ready...
`);

  await ask('');

  const botToken = await ask('  Bot User OAuth Token (xoxb-...): ');
  const signingSecret = await ask('  Signing Secret: ');
  const appToken = await ask('  App-Level Token (xapp-...): ');

  if (!botToken.startsWith('xoxb-')) {
    console.log('\n  Warning: Bot token should start with xoxb-');
  }
  if (!appToken.startsWith('xapp-')) {
    console.log('\n  Warning: App token should start with xapp-');
  }

  // Test the connection
  console.log('\n  Testing connection...');
  const client = new WebClient(botToken);

  try {
    const auth = await client.auth.test();
    console.log(`  Connected as: ${auth.user} in workspace: ${auth.team}`);
  } catch (err: any) {
    console.error(`\n  Failed to connect: ${err.message}`);
    console.log('  Please check your tokens and try again.');
    rl.close();
    process.exit(1);
  }

  // Create default channels
  console.log('\n  Creating default channels...');
  const channels = [
    { name: 'agency-general', topic: 'Company-wide announcements and updates' },
    { name: 'agency-ceo-investor', topic: 'Direct line between investor and CEO' },
    { name: 'agency-leadership', topic: 'CEO + managers coordination' },
    { name: 'agency-approvals', topic: 'Plans awaiting investor approval' },
    { name: 'agency-hr-hiring', topic: 'New agent roles and onboarding' },
  ];

  for (const ch of channels) {
    try {
      const result = await client.conversations.create({ name: ch.name });
      await client.conversations.setTopic({ channel: result.channel!.id!, topic: ch.topic });
      console.log(`    Created #${ch.name}`);
    } catch (err: any) {
      if (err.data?.error === 'name_taken') {
        console.log(`    #${ch.name} already exists`);
      } else {
        console.log(`    Failed to create #${ch.name}: ${err.message}`);
      }
    }
  }

  // Update .env file
  const envPath = resolve(__dirname, '../../../.env');
  if (existsSync(envPath)) {
    let envContent = readFileSync(envPath, 'utf-8');
    envContent = envContent.replace(/SLACK_BOT_TOKEN=.*/, `SLACK_BOT_TOKEN=${botToken}`);
    envContent = envContent.replace(/SLACK_SIGNING_SECRET=.*/, `SLACK_SIGNING_SECRET=${signingSecret}`);
    envContent = envContent.replace(/SLACK_APP_TOKEN=.*/, `SLACK_APP_TOKEN=${appToken}`);
    writeFileSync(envPath, envContent);
    console.log(`\n  Updated .env with Slack credentials`);
  } else {
    console.log(`\n  Warning: .env file not found at ${envPath}`);
    console.log('  Run `pnpm setup` first to create the .env file.');
  }

  // Send test message
  const doTest = await ask('\n  Send a test message to #agency-general? (y/N): ');
  if (doTest.toLowerCase() === 'y') {
    try {
      const channelList = await client.conversations.list({ limit: 200 });
      const general = channelList.channels?.find(c => c.name === 'agency-general');
      if (general?.id) {
        await client.chat.postMessage({
          channel: general.id,
          text: 'Claude Agency is online. All systems operational.',
          username: 'Agency System',
          icon_emoji: ':rocket:',
        });
        console.log('  Test message sent!');
      }
    } catch (err: any) {
      console.log(`  Test message failed: ${err.message}`);
    }
  }

  console.log(`
  Slack setup complete!

  Your agency channels:
    #agency-general        — Company announcements
    #agency-ceo-investor   — Your DM channel with the CEO
    #agency-leadership     — CEO + managers
    #agency-approvals      — Approval queue
    #agency-hr-hiring      — HR & hiring

  Run \`pnpm dev\` to start the agency with Slack integration.
`);

  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  rl.close();
  process.exit(1);
});

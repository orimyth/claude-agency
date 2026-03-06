import { createInterface } from 'readline';
import { writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

async function main() {
  console.log('\n  Claude Agency — Setup Wizard\n');
  console.log('  This will configure your agency. Press Enter for defaults.\n');

  // Step 1: Claude Code auth
  console.log('  --- Step 1: Claude Code ---');
  let claudeAuth = 'cli';
  try {
    execSync('claude --version', { stdio: 'ignore' });
    console.log('  Claude CLI detected.');
  } catch {
    console.log('  Claude CLI not found. You\'ll need an API key.');
    claudeAuth = 'api_key';
  }

  let apiKey = '';
  if (claudeAuth === 'api_key') {
    apiKey = await ask('  Claude API Key: ');
  }

  // Step 2: MySQL
  console.log('\n  --- Step 2: MySQL ---');
  const mysqlHost = (await ask('  MySQL Host [localhost]: ')) || 'localhost';
  const mysqlPort = (await ask('  MySQL Port [3306]: ')) || '3306';
  const mysqlUser = (await ask('  MySQL User [claude_agency]: ')) || 'claude_agency';
  const mysqlPassword = await ask('  MySQL Password: ');
  const mysqlDatabase = (await ask('  MySQL Database [claude_agency]: ')) || 'claude_agency';

  // Step 3: Workspace
  console.log('\n  --- Step 3: Workspace ---');
  const workspace = (await ask('  Workspace directory [./workspace]: ')) || './workspace';

  // Step 4: Concurrency
  console.log('\n  --- Step 4: Agency Settings ---');
  const maxConcurrency = (await ask('  Max concurrent agents [5]: ')) || '5';
  const dashboardPort = (await ask('  Dashboard port [3000]: ')) || '3000';
  const wsPort = (await ask('  WebSocket port [3001]: ')) || '3001';

  // Step 5: Slack (optional for now)
  console.log('\n  --- Step 5: Slack (optional, run `pnpm setup:slack` later) ---');
  const slackBotToken = (await ask('  Slack Bot Token [skip]: ')) || '';
  const slackSigningSecret = (await ask('  Slack Signing Secret [skip]: ')) || '';
  const slackAppToken = (await ask('  Slack App Token [skip]: ')) || '';

  // Write .env file
  const envPath = resolve(__dirname, '../../.env');
  const envContent = [
    `# Claude Code`,
    `CLAUDE_API_KEY=${apiKey}`,
    ``,
    `# MySQL`,
    `MYSQL_HOST=${mysqlHost}`,
    `MYSQL_PORT=${mysqlPort}`,
    `MYSQL_USER=${mysqlUser}`,
    `MYSQL_PASSWORD=${mysqlPassword}`,
    `MYSQL_DATABASE=${mysqlDatabase}`,
    ``,
    `# Slack`,
    `SLACK_BOT_TOKEN=${slackBotToken}`,
    `SLACK_SIGNING_SECRET=${slackSigningSecret}`,
    `SLACK_APP_TOKEN=${slackAppToken}`,
    ``,
    `# Agency`,
    `WORKSPACE_DIR=${workspace}`,
    `MAX_CONCURRENCY=${maxConcurrency}`,
    `DASHBOARD_PORT=${dashboardPort}`,
    `WS_PORT=${wsPort}`,
  ].join('\n');

  writeFileSync(envPath, envContent + '\n');
  console.log(`\n  .env file written to ${envPath}`);

  // Try to initialize DB
  console.log('\n  Initializing database...');
  try {
    const { StateStore } = await import('./state-store.js');
    const store = new StateStore({
      host: mysqlHost,
      port: parseInt(mysqlPort, 10),
      user: mysqlUser,
      password: mysqlPassword,
      database: mysqlDatabase,
    });
    await store.initialize();
    await store.close();
    console.log('  Database tables created successfully!');
  } catch (err: any) {
    console.log(`  Warning: Could not connect to MySQL: ${err.message}`);
    console.log('  Make sure MySQL is running and the database exists.');
    console.log(`  Create it with: CREATE DATABASE ${mysqlDatabase};`);
  }

  console.log('\n  Setup complete! Run `pnpm dev` to start the agency.\n');
  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});

import { config as dotenvConfig } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AgencyConfig } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: resolve(__dirname, '../../../../.env') });

function env(key: string, fallback?: string): string {
  const val = process.env[key] ?? fallback;
  if (val === undefined) throw new Error(`Missing env var: ${key}`);
  return val;
}

export const agencyConfig: AgencyConfig = {
  workspace: env('WORKSPACE_DIR', './workspace'),
  maxConcurrency: parseInt(env('MAX_CONCURRENCY', '5'), 10),
  mysql: {
    host: env('MYSQL_HOST', 'localhost'),
    port: parseInt(env('MYSQL_PORT', '3306'), 10),
    user: env('MYSQL_USER', 'claude_agency'),
    password: env('MYSQL_PASSWORD', ''),
    database: env('MYSQL_DATABASE', 'claude_agency'),
  },
  slack: {
    botToken: env('SLACK_BOT_TOKEN', ''),
    signingSecret: env('SLACK_SIGNING_SECRET', ''),
    appToken: env('SLACK_APP_TOKEN', ''),
  },
  dashboardPort: parseInt(env('DASHBOARD_PORT', '3000'), 10),
  wsPort: parseInt(env('WS_PORT', '3001'), 10),
  maxCostPerTask: parseFloat(env('MAX_COST_PER_TASK', '2.00')),
};

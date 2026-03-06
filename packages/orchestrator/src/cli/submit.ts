import { createInterface } from 'readline';
import { agencyConfig } from '../config/agency.config.js';
import { StateStore } from '../state-store.js';
import { PermissionEngine } from '../permission-engine.js';
import { AgentManager } from '../agent-manager.js';
import { TaskRouter } from '../task-router.js';
import { defaultBlacklist } from '../config/blacklist.js';
import { defaultBlueprints } from '../config/blueprints/index.js';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    // Interactive mode
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q: string) => new Promise<string>(resolve => rl.question(q, resolve));

    console.log('\n  Claude Agency — Submit an Idea\n');
    const title = await ask('  Title: ');
    const description = await ask('  Description: ');
    rl.close();

    await submit(title, description);
  } else {
    // CLI args mode: pnpm submit "title" "description"
    const title = args[0];
    const description = args.slice(1).join(' ') || title;
    await submit(title, description);
  }
}

async function submit(title: string, description: string) {
  const store = new StateStore(agencyConfig.mysql);
  await store.initialize();

  const permissions = new PermissionEngine(defaultBlacklist);
  const agentManager = new AgentManager(store, permissions, agencyConfig);

  for (const bp of defaultBlueprints) {
    agentManager.registerBlueprint(bp);
  }

  const router = new TaskRouter(store, agentManager);
  const result = await router.submitIdea(title, description);

  console.log(`\n  Idea submitted!`);
  console.log(`  Project: ${result.projectId}`);
  console.log(`  Task:    ${result.taskId}`);
  console.log(`  Status:  Assigned to CEO (Alice)\n`);

  await store.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});

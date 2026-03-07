import { query, type SDKResultMessage } from '@anthropic-ai/claude-code';
import { dirname } from 'path';

// Shared PATH-fixed env for all SDK calls
const nodeDir = dirname(process.execPath);
const baseEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) {
  if (v !== undefined) baseEnv[k] = v;
}
if (!baseEnv.PATH?.includes(nodeDir)) {
  baseEnv.PATH = `${nodeDir}:${baseEnv.PATH || ''}`;
}

/** Pre-built env with node in PATH. Clone or use directly for SDK calls. */
export const sdkEnv = baseEnv;

/**
 * Run a simple (no-tool, single-turn) Claude query and return the result text.
 * Eliminates the repeated query → for-await → extract-result boilerplate.
 */
export async function quickQuery(prompt: string, model: string, env?: Record<string, string>): Promise<string> {
  const stream = query({
    prompt,
    options: {
      model,
      allowedTools: [],
      maxTurns: 1,
      permissionMode: 'bypassPermissions',
      env: env ?? sdkEnv,
    },
  });

  let result = '';
  for await (const msg of stream) {
    if (msg.type === 'result') {
      const r = msg as SDKResultMessage;
      if (r.subtype === 'success') result = r.result;
    }
  }
  return result;
}

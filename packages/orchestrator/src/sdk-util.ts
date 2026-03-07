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

// ---------------------------------------------------------------------------
// Query result with metadata
// ---------------------------------------------------------------------------

export interface QueryResult {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Options for quickQuery
// ---------------------------------------------------------------------------

export interface QuickQueryOptions {
  /** Override environment variables for the SDK call. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. Default: 120_000 (2 min). */
  timeoutMs?: number;
  /** Number of retry attempts on transient errors. Default: 2. */
  maxRetries?: number;
  /** Base backoff in ms (doubles each retry). Default: 3000. */
  backoffMs?: number;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class SDKQueryError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = 'SDKQueryError';
  }
}

export class SDKTimeoutError extends SDKQueryError {
  constructor(timeoutMs: number) {
    super(`SDK query timed out after ${timeoutMs}ms`, undefined, true);
    this.name = 'SDKTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRetryable(err: unknown): boolean {
  if (err instanceof SDKTimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  // Rate limits / overloaded / network errors
  return /429|rate.?limit|overloaded|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Aggregate metrics for all quickQuery calls in this process
// ---------------------------------------------------------------------------

export interface SDKMetrics {
  totalCalls: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalRetries: number;
  totalTimeouts: number;
  totalErrors: number;
  avgDurationMs: number;
}

const metrics = {
  totalCalls: 0,
  totalCostUsd: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalRetries: 0,
  totalTimeouts: 0,
  totalErrors: 0,
  totalDurationMs: 0,
};

/** Returns a snapshot of aggregate SDK call metrics. */
export function getSDKMetrics(): SDKMetrics {
  return {
    ...metrics,
    avgDurationMs: metrics.totalCalls > 0 ? Math.round(metrics.totalDurationMs / metrics.totalCalls) : 0,
  };
}

/** Reset metrics (useful for testing). */
export function resetSDKMetrics(): void {
  metrics.totalCalls = 0;
  metrics.totalCostUsd = 0;
  metrics.totalInputTokens = 0;
  metrics.totalOutputTokens = 0;
  metrics.totalCacheReadTokens = 0;
  metrics.totalRetries = 0;
  metrics.totalTimeouts = 0;
  metrics.totalErrors = 0;
  metrics.totalDurationMs = 0;
}

// ---------------------------------------------------------------------------
// Core: single attempt (internal)
// ---------------------------------------------------------------------------

async function executeQuery(
  prompt: string,
  model: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<QueryResult> {
  const start = Date.now();

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), timeoutMs);

  try {
    const stream = query({
      prompt,
      options: {
        model,
        allowedTools: [],
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        env,
        abortController,
      },
    });

    let result = '';
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;

    for await (const msg of stream) {
      if (msg.type === 'result') {
        const r = msg as SDKResultMessage;
        if (r.subtype === 'success') result = r.result;
        costUsd = r.total_cost_usd ?? 0;
        inputTokens = r.usage?.input_tokens ?? 0;
        outputTokens = r.usage?.output_tokens ?? 0;
        cacheReadTokens = r.usage?.cache_read_input_tokens ?? 0;
      }
    }

    const durationMs = Date.now() - start;
    return { text: result, costUsd, inputTokens, outputTokens, cacheReadTokens, durationMs };
  } catch (err) {
    if (abortController.signal.aborted) {
      throw new SDKTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run a simple (no-tool, single-turn) Claude query and return the result text.
 * Includes retry with exponential backoff, timeout, and aggregate metrics.
 *
 * Backwards-compatible: callers using the old (prompt, model, env?) signature
 * continue to work. New callers can pass a QuickQueryOptions object as the 3rd arg.
 */
export async function quickQuery(prompt: string, model: string, opts?: Record<string, string> | QuickQueryOptions): Promise<string> {
  // Distinguish old-style env object from new QuickQueryOptions
  let options: QuickQueryOptions;
  if (opts && ('timeoutMs' in opts || 'maxRetries' in opts || 'backoffMs' in opts)) {
    options = opts as QuickQueryOptions;
  } else {
    options = { env: opts as Record<string, string> | undefined };
  }

  const env = options.env ?? sdkEnv;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxRetries = options.maxRetries ?? 2;
  const backoffMs = options.backoffMs ?? 3_000;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      metrics.totalRetries++;
      const delay = backoffMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }

    try {
      const result = await executeQuery(prompt, model, env, timeoutMs);

      // Track metrics
      metrics.totalCalls++;
      metrics.totalCostUsd += result.costUsd;
      metrics.totalInputTokens += result.inputTokens;
      metrics.totalOutputTokens += result.outputTokens;
      metrics.totalCacheReadTokens += result.cacheReadTokens;
      metrics.totalDurationMs += result.durationMs;

      return result.text;
    } catch (err) {
      lastErr = err;
      if (err instanceof SDKTimeoutError) metrics.totalTimeouts++;

      if (!isRetryable(err) || attempt === maxRetries) {
        metrics.totalErrors++;
        break;
      }
      console.warn(`[sdk-util] quickQuery attempt ${attempt + 1} failed (retrying): ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new SDKQueryError(
    `quickQuery failed after ${maxRetries + 1} attempts: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
    lastErr,
    false,
  );
}

/**
 * Like quickQuery but returns full result metadata (cost, tokens, duration).
 */
export async function detailedQuery(prompt: string, model: string, opts?: QuickQueryOptions): Promise<QueryResult> {
  const env = opts?.env ?? sdkEnv;
  const timeoutMs = opts?.timeoutMs ?? 120_000;
  const maxRetries = opts?.maxRetries ?? 2;
  const backoffMs = opts?.backoffMs ?? 3_000;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      metrics.totalRetries++;
      const delay = backoffMs * Math.pow(2, attempt - 1);
      await sleep(delay);
    }

    try {
      const result = await executeQuery(prompt, model, env, timeoutMs);

      metrics.totalCalls++;
      metrics.totalCostUsd += result.costUsd;
      metrics.totalInputTokens += result.inputTokens;
      metrics.totalOutputTokens += result.outputTokens;
      metrics.totalCacheReadTokens += result.cacheReadTokens;
      metrics.totalDurationMs += result.durationMs;

      return result;
    } catch (err) {
      lastErr = err;
      if (err instanceof SDKTimeoutError) metrics.totalTimeouts++;

      if (!isRetryable(err) || attempt === maxRetries) {
        metrics.totalErrors++;
        break;
      }
      console.warn(`[sdk-util] detailedQuery attempt ${attempt + 1} failed (retrying): ${err instanceof Error ? err.message : err}`);
    }
  }

  throw new SDKQueryError(
    `detailedQuery failed after ${maxRetries + 1} attempts: ${lastErr instanceof Error ? lastErr.message : lastErr}`,
    lastErr,
    false,
  );
}

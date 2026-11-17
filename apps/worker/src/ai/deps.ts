import type { Env } from '../env';
import { logRequest, type LogEntry } from '../lib/log';
import { createQuotaClient, type QuotaClient } from './quota-client';
import type { QuotaStore } from './quota-store';

/**
 * Everything the AI routes need from the outside world, passed in as one
 * object. `defaultDeps` below is the only place that reads the clock or wires
 * the global `fetch` and the Cloudflare bindings; tests build their own `Deps`
 * from fakes.
 */

/** The part of the Workers Rate Limiting binding that the routes use. */
export type Limiter = {
  limit(args: { key: string }): Promise<{ success: boolean }>;
};

export type Deps = {
  /** Milliseconds since the epoch. */
  now: () => number;
  fetch: typeof fetch;
  /** The burst limiter (10 requests per 60 seconds per key, set in `wrangler.jsonc`). */
  limiter: Limiter;
  quota: QuotaClient;
  /** Writes the one log line of a request. */
  log: (entry: LogEntry) => void;
  /** Timer functions for the deadlines. Default: the global ones. Tests inject fakes. */
  setTimeout?: (handler: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Timeout of one upstream call. Default 25 s. */
  upstreamTimeoutMs?: number;
  /** Deadline of the whole provider loop of one request. Default 55 s. */
  totalTimeoutMs?: number;
};

export function defaultDeps(env: Env): Deps {
  return {
    now: () => Date.now(),
    // Looked up per call: calling a detached `fetch` throws "Illegal invocation" in Workers.
    fetch: (input, init) => globalThis.fetch(input, init),
    limiter: { limit: (args) => env.AI_BURST.limit(args) },
    // The binding type is the untyped namespace; the class is known from `wrangler.jsonc`.
    quota: createQuotaClient(env.QUOTA as DurableObjectNamespace<QuotaStore>),
    log: (entry) => {
      logRequest(entry);
    },
  };
}

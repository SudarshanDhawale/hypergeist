import { AI_WIRE_LIMITS, ChatRequestSchema, type ChatRequest } from '@hypergeist/shared/ai-wire';
import { parseConfig, type AiConfig } from '../lib/config';
import { readLimitedBody } from '../lib/body';
import { errorResponse, type ErrorCode, type ErrorResponseOptions } from '../lib/errors';
import { checkOrigin } from '../lib/origin';
import { secondsUntilUtcMidnight, utcDate } from '../lib/time';
import { visitorKey } from '../lib/visitor';
import type { Deps } from './deps';
import { adaptRequest } from './providers';
import type { Limits } from './quota-logic';
import { callUpstream, type UpstreamOutcome } from './upstream';

/**
 * `POST /api/ai/chat` as a plain function from a `Request` to a `Response`, so
 * it can be tested without Hono (task 5.3 mounts it).
 *
 * The pipeline runs in a fixed order and stops at the first failure:
 * configuration, origin, content type, body size, JSON, schema, model, burst
 * limit, quota reservation, provider loop, token accounting, reply. The
 * request is counted against the caps only after the burst limit, and every
 * check before it is free. Every error leaves through `errorResponse`.
 *
 * Fail closed: when the limiter or the quota throws, or the quota answers
 * with something unexpected, the answer is `UPSTREAM_FAILED` and no provider
 * is called, so the hosted key is never used without a limit in force.
 */

/** Whole-request deadline of the provider loop. */
export const TOTAL_TIMEOUT_MS = 55_000;

/** `Retry-After` of a burst denial: the window of the Rate Limiting binding. */
export const BURST_RETRY_AFTER_SECONDS = 60;

/** What the log line needs besides the status and the code. */
type Trace = {
  provider: string;
  kind: string;
  /** True once the quota reservation succeeded. */
  counted: boolean;
};

type Handled = { readonly response: Response; readonly code: string };

function reject(code: ErrorCode, options?: ErrorResponseOptions): Handled {
  return { response: errorResponse(code, options), code };
}

/** The clock for the log only. A failing clock must not change the answer. */
function readClock(deps: Deps, fallback: number): number {
  try {
    const value = deps.now();
    return Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** `application/json`, with or without parameters (`; charset=utf-8`). Case-insensitive. */
function isJsonContentType(header: string | null): boolean {
  if (header === null) return false;
  const mediaType = header.split(';')[0] ?? '';
  return mediaType.trim().toLowerCase() === 'application/json';
}

function limitsFrom(config: AiConfig): Limits {
  return {
    visitorDaily: config.visitorDailyCap,
    daily: config.dailyCap,
    dailyTokens: config.dailyTokenCap,
    lifetime: config.lifetimeCap,
    lifetimeTokens: config.lifetimeTokenCap,
  };
}

function successResponse(reply: unknown): Response {
  return new Response(JSON.stringify(reply), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Tries the providers in order. A retryable failure moves to the next one, a
 * non-retryable failure (a 4xx, or the whole-request deadline) stops. Returns
 * the first success, or `undefined`.
 */
async function runProviders(
  request: ChatRequest,
  config: AiConfig,
  deps: Deps,
  trace: Trace,
): Promise<Extract<UpstreamOutcome, { ok: true }> | undefined> {
  const startTimer =
    deps.setTimeout ?? ((handler: () => void, ms: number) => globalThis.setTimeout(handler, ms));
  const stopTimer =
    deps.clearTimeout ??
    ((handle: unknown) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  const deadline = new AbortController();
  const timer = startTimer(() => deadline.abort(), deps.totalTimeoutMs ?? TOTAL_TIMEOUT_MS);
  try {
    for (const [index, provider] of config.providers.entries()) {
      trace.provider = provider.name;
      const outcome = await callUpstream({
        provider,
        body: adaptRequest(provider, request, config, { isFirst: index === 0 }),
        fetch: deps.fetch,
        signal: deadline.signal,
        timeoutMs: deps.upstreamTimeoutMs,
        setTimeout: startTimer,
        clearTimeout: stopTimer,
      });
      trace.kind = outcome.kind;
      if (outcome.ok) return outcome;
      if (!outcome.retryable) return undefined;
    }
    return undefined;
  } finally {
    stopTimer(timer);
  }
}

/** Counts the tokens of a finished request. Best effort: a failure never changes the answer. */
async function addTokensQuietly(deps: Deps, key: string, tokens: number): Promise<void> {
  try {
    // The date is read now, not at reservation: a request that crosses midnight is counted on
    // the new day. Sending the old date would make the store roll its counters back.
    await deps.quota.addTokens({ visitorKey: key, date: utcDate(deps.now()), tokens });
  } catch {
    // Deliberately empty: the reply is already paid for, and the next reservation still sees
    // every token that was counted.
  }
}

async function runPipeline(
  request: Request,
  env: Readonly<Record<string, unknown>>,
  deps: Deps,
  trace: Trace,
): Promise<Handled> {
  const parsedConfig = parseConfig(env);
  if (!parsedConfig.ok || !parsedConfig.config.enabled) return reject('AI_DISABLED');
  const config = parsedConfig.config;

  if (!checkOrigin(request.headers, config.origins)) return reject('FORBIDDEN_ORIGIN');

  if (!isJsonContentType(request.headers.get('content-type'))) return reject('BAD_REQUEST');

  const body = await readLimitedBody(request, AI_WIRE_LIMITS.maxBodyBytes);
  if (!body.ok) return reject(body.reason === 'too-large' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST');

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    return reject('BAD_REQUEST');
  }
  const parsed = ChatRequestSchema.safeParse(json);
  if (!parsed.success) return reject('BAD_REQUEST');
  const chat = parsed.data;

  if (chat.model !== 'auto' && !config.allowedModels.includes(chat.model)) {
    return reject('MODEL_NOT_ALLOWED');
  }

  const now = deps.now();
  const date = utcDate(now);
  const key = await visitorKey(request.headers.get('cf-connecting-ip'), config.salt, date);

  // Burst limit. Anything but a clear yes or no is a failure of the limiter.
  let burstAllowed: boolean;
  try {
    const verdict = await deps.limiter.limit({ key: `chat:${key}` });
    if (verdict.success !== true && verdict.success !== false) return reject('UPSTREAM_FAILED');
    burstAllowed = verdict.success;
  } catch {
    return reject('UPSTREAM_FAILED');
  }
  if (!burstAllowed) {
    return reject('RATE_LIMITED', { retryAfterSeconds: BURST_RETRY_AFTER_SECONDS });
  }

  // Quota reservation. From here on the request is counted.
  try {
    const reservation = await deps.quota.reserve({
      visitorKey: key,
      date,
      limits: limitsFrom(config),
    });
    if (reservation.ok === true) {
      trace.counted = true;
    } else if (reservation.ok === false && reservation.reason !== 'invalid-input') {
      return reject('DAILY_CAP', { retryAfterSeconds: secondsUntilUtcMidnight(now) });
    } else {
      return reject('UPSTREAM_FAILED');
    }
  } catch {
    return reject('UPSTREAM_FAILED');
  }

  const success = await runProviders(chat, config, deps, trace);
  if (success === undefined) return reject('UPSTREAM_FAILED');

  await addTokensQuietly(deps, key, success.tokens);
  return { response: successResponse(success.reply), code: 'ok' };
}

export async function handleChat(
  request: Request,
  env: Record<string, unknown>,
  deps: Deps,
): Promise<Response> {
  const started = readClock(deps, 0);
  const trace: Trace = { provider: 'none', kind: 'none', counted: false };

  let handled: Handled;
  try {
    handled = await runPipeline(request, env, deps, trace);
  } catch {
    // The only catch-all of the route. Everything that can fail on purpose (limiter, quota,
    // upstream, token accounting) is handled where it happens; this catches a programmer
    // error or a hostile environment. The thrown value is dropped: it may carry request,
    // upstream or key text, and the client gets the closed code `INTERNAL` only.
    handled = reject('INTERNAL');
  }

  try {
    deps.log({
      route: 'chat',
      status: handled.response.status,
      code: handled.code,
      provider: trace.provider,
      kind: trace.kind,
      ms: Math.max(0, readClock(deps, started) - started),
      counted: trace.counted,
    });
  } catch {
    // A failing log writer must not change the answer to the visitor.
  }
  return handled.response;
}

// GET /api/ai/quota: the numbers behind the demo-quota counter in the app's menu bar.
//
// Pipeline: config, origin, visitor key, burst limiter (key `quota:` + visitor key), snapshot.
// The route only reads. It never calls `reserve` or `addTokens`, so it counts against no cap.
// The body carries request counts and the reset time only: no token counts, no provider name.
// Every error goes through `errorResponse`, the one door for error bodies.

import { parseConfig, type AiConfig } from '../lib/config';
import { errorResponse, type ErrorCode } from '../lib/errors';
import { checkOrigin } from '../lib/origin';
import { utcDate } from '../lib/time';
import { visitorKey } from '../lib/visitor';
import type { Deps } from './deps';
import type { Limits, QuotaSnapshot } from './quota-logic';

const MS_PER_DAY = 86_400_000;

/** The route name in the log line. */
const ROUTE = 'quota';

type Outcome = { response: Response; code: ErrorCode | 'ok' };

function fail(code: ErrorCode, retryAfterSeconds?: number): Outcome {
  return {
    response: errorResponse(
      code,
      retryAfterSeconds === undefined ? undefined : { retryAfterSeconds },
    ),
    code,
  };
}

/** ISO string of the next 00:00:00 UTC after `ms`. Throws a RangeError for a non-finite `ms`. */
function nextUtcMidnightIso(ms: number): string {
  return new Date((Math.floor(ms / MS_PER_DAY) + 1) * MS_PER_DAY).toISOString();
}

function limitsOf(config: AiConfig): Limits {
  return {
    visitorDaily: config.visitorDailyCap,
    daily: config.dailyCap,
    dailyTokens: config.dailyTokenCap,
    lifetime: config.lifetimeCap,
    lifetimeTokens: config.lifetimeTokenCap,
  };
}

async function run(request: Request, env: Record<string, unknown>, deps: Deps): Promise<Outcome> {
  const parsed = parseConfig(env);
  if (!parsed.ok || !parsed.config.enabled) {
    return fail('AI_DISABLED');
  }
  const config = parsed.config;

  if (!checkOrigin(request.headers, config.origins, request.method)) {
    return fail('FORBIDDEN_ORIGIN');
  }

  const nowMs = deps.now();
  const date = utcDate(nowMs);
  const key = await visitorKey(request.headers.get('cf-connecting-ip'), config.salt, date);

  try {
    const burst = await deps.limiter.limit({ key: `quota:${key}` });
    if (!burst.success) {
      return fail('RATE_LIMITED', 60);
    }
  } catch {
    // Fail closed: a broken limiter means no answer, never an unlimited one.
    return fail('UPSTREAM_FAILED');
  }

  let snap: QuotaSnapshot;
  try {
    snap = await deps.quota.snapshot({ visitorKey: key, date, limits: limitsOf(config) });
  } catch {
    return fail('UPSTREAM_FAILED');
  }

  // Built by picking named fields, so nothing else the store returns can reach the body.
  const body = {
    dailyLimit: snap.dailyLimit,
    dailyUsed: snap.dailyUsed,
    visitorLimit: snap.visitorLimit,
    visitorUsed: snap.visitorUsed,
    resetsAt: nextUtcMidnightIso(nowMs),
  };
  return {
    response: new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      },
    }),
    code: 'ok',
  };
}

/** Never throws. Writes one log line (`counted` is always false here). */
export async function handleQuota(
  request: Request,
  env: Record<string, unknown>,
  deps: Deps,
): Promise<Response> {
  let startMs = 0;
  try {
    startMs = deps.now();
  } catch {
    // A broken clock is handled below: `run` calls `now` again and the catch answers INTERNAL.
  }

  let outcome: Outcome;
  try {
    outcome = await run(request, env, deps);
  } catch {
    // The one catch-all: any unexpected exception becomes INTERNAL. The exception text is
    // dropped on purpose; `errorResponse` is the only thing that builds the body.
    outcome = fail('INTERNAL');
  }

  try {
    deps.log({
      route: ROUTE,
      status: outcome.response.status,
      code: outcome.code,
      provider: 'none',
      kind: 'none',
      ms: deps.now() - startMs,
      counted: false,
    });
  } catch {
    // Logging must not change the answer.
  }
  return outcome.response;
}

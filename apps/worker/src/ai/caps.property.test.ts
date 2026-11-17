import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import type { Env } from '../env';
import { visitorKey } from '../lib/visitor';
import type { Deps } from './deps';
import { createMemoryQuotaClient } from './quota-client';
import { createMemoryKv } from './quota-logic';

/*
 * The shared `packages/shared/test-support/seed.ts` cannot be used here: it reads
 * `globalThis.crypto`, which the Worker's `tsc` project (Workers types, no DOM lib) does not
 * declare, so importing it breaks `pnpm --filter @hypergeist/worker typecheck`. This is a small
 * twin with the same behavior: the seed comes from `HYPERGEIST_TEST_SEED` (a signed 32-bit
 * integer) or is drawn at random once per file, and it is printed on failure with a replay line.
 */
const SEED_VARIABLE = 'HYPERGEIST_TEST_SEED';
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

function resolveSeed(): number {
  const raw = process.env[SEED_VARIABLE];
  if (raw === undefined || raw === '') {
    return crypto.getRandomValues(new Int32Array(1))[0] ?? 0;
  }
  const value = Number(raw);
  if (
    !/^-?\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < INT32_MIN ||
    value > INT32_MAX
  ) {
    throw new Error(`Invalid ${SEED_VARIABLE} value "${raw}": not a signed 32-bit integer`);
  }
  return value + 0;
}

const TEST_SEED = resolveSeed();

async function assertAsyncProperty<T>(
  property: fc.IAsyncProperty<T>,
  overrides?: Partial<fc.Parameters<T>>,
): Promise<void> {
  try {
    await fc.assert(property, { numRuns: 100, ...overrides, seed: TEST_SEED });
  } catch (error: unknown) {
    console.error(`Property failed with ${SEED_VARIABLE}=${TEST_SEED}`);
    console.error(
      `Replay with: ${SEED_VARIABLE}=${TEST_SEED} pnpm exec vitest run apps/worker/src/ai/caps.property.test.ts`,
    );
    throw error;
  }
}

/** Explicit test timeout. A parallel full-suite run is slower than a single file run. */
const TEST_TIMEOUT_MS = 60_000;

const ORIGIN = 'http://localhost:8787';
const SALT = 'test-secret-salt-0000';
const MS_PER_MINUTE = 60_000;
/** 2026-11-15 06:00:00 UTC: the start of every sequence. */
const START = Date.UTC(2026, 10, 15, 6, 0, 0);

/** The UTC date of a time, computed here on purpose: the test does not trust the code under test. */
function dateOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ---- Property 3: Caps hold ------------------------------------------------

type Caps = {
  readonly visitor: number;
  readonly daily: number;
  readonly dailyTokens: number;
  readonly lifetime: number;
  readonly lifetimeTokens: number;
};

type Step = {
  /** The last octet of the visitor's address (1 to 6). */
  readonly ip: number;
  /** Minutes the clock moves forward before the request. */
  readonly advanceMinutes: number;
  /** `usage.total_tokens` of the reply, if the request is forwarded. */
  readonly tokens: number;
};

const arbCaps: fc.Arbitrary<Caps> = fc.record({
  visitor: fc.integer({ min: 1, max: 5 }),
  daily: fc.integer({ min: 1, max: 12 }),
  dailyTokens: fc.integer({ min: 50, max: 2000 }),
  lifetime: fc.integer({ min: 5, max: 40 }),
  lifetimeTokens: fc.integer({ min: 200, max: 6000 }),
});

const arbStep: fc.Arbitrary<Step> = fc.record({
  ip: fc.integer({ min: 1, max: 6 }),
  advanceMinutes: fc.integer({ min: 0, max: 1500 }),
  tokens: fc.integer({ min: 0, max: 800 }),
});

// `size: 'max'` lets the length range over the whole 1 to 60, not only the short end.
const arbSteps = fc.array(arbStep, { minLength: 1, maxLength: 60, size: 'max' });

type DenialKind = 'lifetime' | 'lifetime-tokens' | 'daily' | 'daily-tokens' | 'visitor';

/** What the whole file saw, for the coverage assertions and the printed distribution. */
const stats = {
  runs: 0,
  requests: 0,
  served: 0,
  denied: 0,
  /** Served requests on a date that differs from the date of the previous request. */
  servedAfterRollover: 0,
  /** Denied requests by the first cap that was reached, as counted by the test. */
  deniedByKind: { lifetime: 0, 'lifetime-tokens': 0, daily: 0, 'daily-tokens': 0, visitor: 0 },
};

function baseEnv(caps: Caps): Record<string, unknown> {
  return {
    AI_ALLOWED_ORIGINS: ORIGIN,
    AI_PROVIDERS: 'sarvam',
    AI_SARVAM_MODEL: 'sarvam-model',
    SARVAM_API_KEY: 'test-secret-sarvam-0000',
    QUOTA_SALT: SALT,
    AI_VISITOR_DAILY_CAP: String(caps.visitor),
    AI_DAILY_CAP: String(caps.daily),
    AI_DAILY_TOKEN_CAP: String(caps.dailyTokens),
    AI_LIFETIME_CAP: String(caps.lifetime),
    AI_LIFETIME_TOKEN_CAP: String(caps.lifetimeTokens),
  };
}

function chatRequest(ip: number): Request {
  return new Request('http://localhost:8787/api/ai/chat', {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'cf-connecting-ip': `203.0.113.${ip}`,
    },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hello' }] }),
  });
}

function upstreamReply(totalTokens: number): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { total_tokens: totalTokens },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Runs one generated sequence through the app and checks every step from the outside. */
async function runSequence(caps: Caps, steps: readonly Step[]): Promise<void> {
  const clock = { now: START };
  let upstreamCalls = 0;
  // The counts below are kept by this test alone, from what it sent and what it got back.
  const forwardedPerDay = new Map<string, number>();
  const forwardedPerVisitorDay = new Map<string, number>();
  const tokensPerDay = new Map<string, number>();
  let forwardedTotal = 0;
  let tokensTotal = 0;
  let nextTokens = 0;

  const deps: Partial<Deps> = {
    now: () => clock.now,
    fetch: () => {
      upstreamCalls += 1;
      return Promise.resolve(upstreamReply(nextTokens));
    },
    limiter: { limit: () => Promise.resolve({ success: true }) },
    quota: createMemoryQuotaClient(createMemoryKv()),
    log: () => undefined,
  };
  const app = buildApp(deps);
  // Only the configuration values are read from the environment of this test; the bindings
  // (`ASSETS`, `QUOTA`, `AI_BURST`) are replaced by `deps`, so the cast names the shape honestly.
  const env = baseEnv(caps) as unknown as Env;

  let previousDate: string | undefined;
  for (const [index, step] of steps.entries()) {
    clock.now += step.advanceMinutes * MS_PER_MINUTE;
    const date = dateOf(clock.now);
    const visitorId = `${date}|${step.ip}`;
    const label = `step ${index} (${date}, ip ${step.ip})`;

    const dayCount = forwardedPerDay.get(date) ?? 0;
    const visitorCount = forwardedPerVisitorDay.get(visitorId) ?? 0;
    const dayTokens = tokensPerDay.get(date) ?? 0;

    // The first cap that is already reached, in the documented order of the checks.
    let denial: DenialKind | undefined;
    if (forwardedTotal >= caps.lifetime) denial = 'lifetime';
    else if (tokensTotal >= caps.lifetimeTokens) denial = 'lifetime-tokens';
    else if (dayCount >= caps.daily) denial = 'daily';
    else if (dayTokens >= caps.dailyTokens) denial = 'daily-tokens';
    else if (visitorCount >= caps.visitor) denial = 'visitor';

    nextTokens = step.tokens;
    const callsBefore = upstreamCalls;
    const response = await app.request(chatRequest(step.ip), undefined, env);
    const text = await response.text();
    const forwarded = upstreamCalls - callsBefore;
    const rolledOver = previousDate !== undefined && previousDate !== date;
    previousDate = date;

    stats.requests += 1;
    expect(forwarded === 0 || forwarded === 1, `${label}: upstream calls of one request`).toBe(
      true,
    );

    if (forwarded === 1) {
      // Served. It must not have been forwarded after a token cap was already reached
      // (one reply may overshoot; the next request may not).
      expect(response.status, label).toBe(200);
      expect(dayTokens, `${label}: forwarded after the daily token cap`).toBeLessThan(
        caps.dailyTokens,
      );
      expect(tokensTotal, `${label}: forwarded after the lifetime token cap`).toBeLessThan(
        caps.lifetimeTokens,
      );
      expect(denial, `${label}: forwarded although a cap was reached`).toBeUndefined();

      forwardedPerDay.set(date, dayCount + 1);
      forwardedPerVisitorDay.set(visitorId, visitorCount + 1);
      tokensPerDay.set(date, dayTokens + step.tokens);
      forwardedTotal += 1;
      tokensTotal += step.tokens;
      stats.served += 1;
      if (rolledOver) stats.servedAfterRollover += 1;
    } else {
      // Denied: 429 DAILY_CAP, a usable Retry-After, and no upstream call (checked above).
      expect(response.status, label).toBe(429);
      expect(JSON.parse(text), label).toEqual({ error: { code: 'DAILY_CAP' } });
      const retryAfter = response.headers.get('retry-after');
      expect(retryAfter, `${label}: Retry-After`).toMatch(/^[0-9]+$/);
      const seconds = Number(retryAfter);
      expect(seconds, `${label}: Retry-After value`).toBeGreaterThanOrEqual(1);
      expect(seconds, `${label}: Retry-After value`).toBeLessThanOrEqual(86_400);
      // A denial needs a reason: some cap was reached. This also covers the daily reset: a
      // visitor or day that was at its cap yesterday has a count of 0 today, so only a
      // lifetime cap can still deny.
      expect(denial, `${label}: denied although no cap was reached`).toBeDefined();
      stats.denied += 1;
      if (denial !== undefined) stats.deniedByKind[denial] += 1;
    }

    // The caps themselves, after every step.
    for (const [key, count] of forwardedPerVisitorDay) {
      expect(count, `${label}: visitor cap of ${key}`).toBeLessThanOrEqual(caps.visitor);
    }
    for (const [key, count] of forwardedPerDay) {
      expect(count, `${label}: daily cap of ${key}`).toBeLessThanOrEqual(caps.daily);
    }
    expect(forwardedTotal, `${label}: lifetime cap`).toBeLessThanOrEqual(caps.lifetime);
    expect(forwardedTotal, `${label}: own count and upstream calls agree`).toBe(upstreamCalls);
  }
  stats.runs += 1;
}

describe('caps (property)', () => {
  it(
    'Feature: worker-backend, Property 3: Caps hold',
    async () => {
      // **Validates: Requirements 4.1 to 4.7, 9.3**
      await assertAsyncProperty(
        fc.asyncProperty(arbCaps, arbSteps, async (caps, steps) => {
          await runSequence(caps, steps);
        }),
        { numRuns: 200 },
      );

      // Coverage: the property must have seen both outcomes, a token-cap denial, and a day
      // rollover followed by served requests.
      const tokenDenials =
        stats.deniedByKind['daily-tokens'] + stats.deniedByKind['lifetime-tokens'];
      process.stderr.write(
        `[caps] seed ${TEST_SEED}: ${stats.runs} runs, ${stats.requests} requests, ` +
          `${stats.served} served, ${stats.denied} denied, ` +
          `${stats.servedAfterRollover} served after a day rollover; denied by ` +
          `visitor ${stats.deniedByKind.visitor}, daily ${stats.deniedByKind.daily}, ` +
          `daily-tokens ${stats.deniedByKind['daily-tokens']}, ` +
          `lifetime ${stats.deniedByKind.lifetime}, ` +
          `lifetime-tokens ${stats.deniedByKind['lifetime-tokens']}\n`,
      );
      expect(stats.served, 'served requests occur').toBeGreaterThan(0);
      expect(stats.denied, 'denied requests occur').toBeGreaterThan(0);
      expect(stats.servedAfterRollover, 'served after a day rollover').toBeGreaterThan(0);
      expect(tokenDenials, 'denied by a token cap').toBeGreaterThan(0);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---- Property 6: Visitor key ----------------------------------------------

const HEX_CHARS = '0123456789abcdef'.split('');

const arbHex = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...HEX_CHARS), { minLength, maxLength }).map((chars) => chars.join(''));

const arbIpv4 = fc
  .tuple(
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
    fc.integer({ min: 0, max: 255 }),
  )
  .map((parts) => parts.join('.'));

const arbIpv6 = fc
  .array(arbHex(1, 4), { minLength: 2, maxLength: 8 })
  .map((groups) => groups.join(':'));

/**
 * Addresses, including hex-only strings of 8 to 16 characters: those could appear inside a hex
 * key if the key ever carried the address, so the "never contains the IP" check has teeth.
 */
const arbIp: fc.Arbitrary<string> = fc.oneof(arbIpv4, arbIpv6, arbHex(8, 16));

/** At least 8 characters; hex-only for the same reason. */
const arbSalt: fc.Arbitrary<string> = arbHex(8, 32);

const arbDate: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 20_000 })
  .map((day) => dateOf(day * 86_400_000));

const HEX_KEY = /^[0-9a-f]{32}$/;

describe('visitor key (property)', () => {
  it(
    'Feature: worker-backend, Property 6: Visitor key',
    async () => {
      // **Validates: Requirements 4.6**
      await assertAsyncProperty(
        fc.asyncProperty(
          arbIp,
          arbIp,
          arbSalt,
          arbDate,
          arbDate,
          async (ip, otherIp, salt, date, otherDate) => {
            const key = await visitorKey(ip, salt, date);

            // 32 lowercase hex characters.
            expect(key).toMatch(HEX_KEY);

            // Deterministic: the same inputs give the same key.
            expect(await visitorKey(ip, salt, date)).toBe(key);

            // Never contains the address or the salt.
            expect(key).not.toContain(ip);
            expect(key).not.toContain(salt);

            // Different IPs on the same day give different keys.
            if (ip !== otherIp) {
              expect(await visitorKey(otherIp, salt, date)).not.toBe(key);
            }

            // The same IP on different days gives different keys.
            if (date !== otherDate) {
              expect(await visitorKey(ip, salt, otherDate)).not.toBe(key);
            }
          },
        ),
      );
    },
    TEST_TIMEOUT_MS,
  );
});

import { AI_WIRE_LIMITS, PublicReplySchema } from '@hypergeist/shared/ai-wire';
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { ERROR_CODES, ERROR_STATUS, type ErrorCode } from '../lib/errors';
import type { LogEntry } from '../lib/log';
import { TOTAL_TIMEOUT_MS } from './chat-route';
import type { Deps, Limiter } from './deps';
import {
  createMemoryQuotaClient,
  type GuardedReserveResult,
  type QuotaClient,
} from './quota-client';
import { createMemoryKv } from './quota-logic';
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from './upstream';

/*
 * Property tests of the AI proxy through `buildApp` and `app.request`, with a fake limiter, the
 * memory quota client, a fake `fetch`, fake timers and an injected clock. Nothing here touches
 * the network, a real key or a real provider.
 *
 * Where the fake secrets are placed. The secrets (`SECRETS`) are put into everything the Worker
 * must never copy: every ignored field of an upstream reply (id, usage, reasoning, fingerprint,
 * extra choices, tool-call extras, role), the body and the headers of failed upstream replies,
 * and the message of every thrown error. They are NOT put into `content`, `finish_reason` or the
 * tool-call fields, because those are the model's answer and the Worker passes them on by design
 * (the Worker has no redaction step; a provider does not echo the key into model text).
 *
 * The shared `packages/shared/test-support/seed.ts` cannot be imported here: it reads
 * `globalThis.crypto`, which the Worker's `tsc` project (Workers types, no DOM lib) does not
 * declare, so importing it breaks `pnpm --filter @hypergeist/worker typecheck`. The block below
 * is a small twin with the same behavior (same variable, same range, same replay message), like
 * the one in `caps.property.test.ts`. The shared helper is async-unaware anyway, so the async
 * wrapper would be local in any case.
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
      `Replay with: ${SEED_VARIABLE}=${TEST_SEED} pnpm exec vitest run apps/worker/src/ai/proxy.property.test.ts`,
    );
    throw error;
  }
}

/** Explicit test timeout. A parallel full-suite run is slower than a single file run. */
const TEST_TIMEOUT_MS = 60_000;

// ---- constants -----------------------------------------------------------

const ORIGIN = 'http://localhost:8787';
const ORIGIN_2 = 'http://localhost:5173';
const SARVAM_KEY = 'test-secret-sarvam-0000';
const OPENAI_KEY = 'test-secret-openai-0000';
const SALT = 'test-secret-salt-0000';
const SECRETS: readonly string[] = [SARVAM_KEY, OPENAI_KEY, SALT];
const SECRET_BLOB = SECRETS.join('|');

type ProviderName = 'sarvam' | 'openai';
const KEYS: Readonly<Record<ProviderName, string>> = { sarvam: SARVAM_KEY, openai: OPENAI_KEY };
const URLS: Readonly<Record<ProviderName, string>> = {
  sarvam: 'https://api.sarvam.ai/v2/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};
const DEFAULT_MAX_OUTPUT = 2_048;
const ALLOWED_MODEL = 'allowed-model-a';

/** A text that carries every fake secret, so a copy anywhere is caught. */
function leaky(marker: string): string {
  return `${marker}:${SECRET_BLOB}`;
}

/** One unique marker per ignored upstream field. None may appear in any response. */
const MARKERS = {
  id: 'IGNORED-id-xyz',
  object: 'IGNORED-object-xyz',
  model: 'IGNORED-model-xyz',
  fingerprint: 'IGNORED-fingerprint-xyz',
  tier: 'IGNORED-service-tier-xyz',
  usage: 'IGNORED-usage-xyz',
  logprobs: 'IGNORED-logprobs-xyz',
  role: 'IGNORED-role-xyz',
  reasoning: 'IGNORED-reasoning-xyz',
  refusal: 'IGNORED-refusal-xyz',
  annotations: 'IGNORED-annotations-xyz',
  functionCall: 'IGNORED-function-call-xyz',
  toolType: 'IGNORED-toolcall-type-xyz',
  toolExtra: 'IGNORED-toolcall-extra-xyz',
  functionExtra: 'IGNORED-function-extra-xyz',
  choiceExtra: 'IGNORED-extra-choice-xyz',
  header: 'IGNORED-header-xyz',
  errorBody: 'IGNORED-error-body-xyz',
  thrown: 'IGNORED-thrown-xyz',
} as const;
const MARKER_LIST: readonly string[] = Object.values(MARKERS);

// ---- arbitrary helpers ---------------------------------------------------

function pick<T>(entries: readonly (readonly [number, T])[]): fc.Arbitrary<T> {
  return fc.oneof(...entries.map(([weight, value]) => ({ weight, arbitrary: fc.constant(value) })));
}

const printable = fc.stringMatching(/^[!-~]{0,24}$/);
const callId = fc.stringMatching(/^[a-z0-9_-]{1,20}$/);
const fnName = fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/);
const shortText = fc.string({ maxLength: 40 });

// ---- request bodies ------------------------------------------------------

const arbToolCall = fc.record({
  id: callId,
  type: fc.constant('function'),
  function: fc.record({ name: fnName, arguments: fc.string({ maxLength: 30 }) }),
});

const arbMessage = fc.oneof(
  fc.record({ role: fc.constant('system'), content: shortText }),
  fc.record({ role: fc.constant('user'), content: shortText }),
  fc.record(
    {
      role: fc.constant('assistant'),
      content: fc.option(shortText, { nil: null }),
      tool_calls: fc.array(arbToolCall, { maxLength: 3 }),
    },
    { requiredKeys: ['role', 'content'] },
  ),
  fc.record({ role: fc.constant('tool'), tool_call_id: callId, content: shortText }),
);

const arbTool = fc.record(
  {
    type: fc.constant('function'),
    function: fc.record(
      {
        name: fnName,
        description: shortText,
        parameters: fc.dictionary(
          fc.stringMatching(/^[a-z]{1,6}$/),
          fc.jsonValue({ maxDepth: 2 }),
          {
            maxKeys: 4,
          },
        ),
      },
      { requiredKeys: ['name', 'parameters'] },
    ),
  },
  { requiredKeys: ['type', 'function'] },
);

const arbModel = pick<string>([
  [7, 'auto'],
  [2, ALLOWED_MODEL],
  [1, 'forbidden-model'],
]);

const arbValidRequest: fc.Arbitrary<Record<string, unknown>> = fc.record(
  {
    model: arbModel,
    messages: fc.array(arbMessage, { minLength: 1, maxLength: 5 }),
    tools: fc.array(arbTool, { maxLength: 3 }),
    tool_choice: fc.constantFrom('auto', 'none'),
    stream: fc.constant(false),
    temperature: fc.double({ min: 0, max: 2, noNaN: true }),
    max_tokens: fc.integer({ min: 1, max: 100_000 }),
  },
  { requiredKeys: ['model', 'messages'] },
);

type MutationKind = 'wrong-type' | 'missing-field' | 'extra-field' | 'oversize';

type BodySpec =
  | { readonly kind: 'valid'; readonly request: Record<string, unknown> }
  | {
      readonly kind: 'mutated';
      readonly base: Record<string, unknown>;
      readonly mutation: MutationKind;
      readonly index: number;
      readonly key: string;
    }
  | { readonly kind: 'json'; readonly value: unknown }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'bytes'; readonly bytes: Uint8Array }
  | { readonly kind: 'near-limit'; readonly total: number };

const arbMutated: fc.Arbitrary<BodySpec> = fc.record({
  kind: fc.constant('mutated' as const),
  base: arbValidRequest,
  mutation: fc.constantFrom<MutationKind>('wrong-type', 'missing-field', 'extra-field', 'oversize'),
  index: fc.nat(1000),
  key: fc.stringMatching(/^[a-z]{3,8}$/),
});

const LIMIT = AI_WIRE_LIMITS.maxBodyBytes;

const arbBody: fc.Arbitrary<BodySpec> = fc.oneof(
  {
    weight: 64,
    arbitrary: arbValidRequest.map((request): BodySpec => ({ kind: 'valid', request })),
  },
  { weight: 16, arbitrary: arbMutated },
  {
    weight: 8,
    arbitrary: fc.jsonValue().map((value): BodySpec => ({ kind: 'json', value })),
  },
  {
    weight: 4,
    arbitrary: fc
      .string({ maxLength: 200, unit: 'binary' })
      .map((text): BodySpec => ({ kind: 'text', text })),
  },
  {
    weight: 4,
    arbitrary: fc
      .uint8Array({ maxLength: 300 })
      .map((bytes): BodySpec => ({ kind: 'bytes', bytes })),
  },
  {
    weight: 7,
    arbitrary: fc
      .constantFrom(LIMIT - 1, LIMIT, LIMIT + 1, LIMIT + 2, LIMIT + 1000, LIMIT * 2)
      .map((total): BodySpec => ({ kind: 'near-limit', total })),
  },
);

/** A valid request whose model `arbGoodEnv` allows, so it is never refused for its model. */
const arbServedBody: fc.Arbitrary<BodySpec> = fc
  .tuple(arbValidRequest, fc.constantFrom('auto', ALLOWED_MODEL))
  .map(([request, model]): BodySpec => ({ kind: 'valid', request: { ...request, model } }));

function validTool(index: number): Record<string, unknown> {
  return {
    type: 'function',
    function: { name: `tool_${index}`, parameters: { type: 'object' } },
  };
}

/** One mutation that always makes the request invalid for `ChatRequestSchema`. */
function mutate(
  base: Record<string, unknown>,
  kind: MutationKind,
  index: number,
  key: string,
): Record<string, unknown> {
  const messages: unknown[] = Array.isArray(base['messages']) ? base['messages'] : [];
  const options: Record<string, unknown>[] = [];
  switch (kind) {
    case 'wrong-type':
      options.push(
        { ...base, model: 42 },
        { ...base, messages: 'hello' },
        { ...base, tools: 'x' },
        { ...base, tool_choice: 'required' },
        { ...base, stream: true },
        { ...base, temperature: 'hot' },
        { ...base, temperature: 3 },
        { ...base, max_tokens: 1.5 },
        { ...base, max_tokens: 0 },
        { ...base, messages: [{ role: 'user', content: 7 }, ...messages] },
        { ...base, messages: [{ role: 'robot', content: 'x' }] },
        { ...base, messages: [] },
      );
      break;
    case 'missing-field': {
      const withoutModel = { ...base };
      delete withoutModel['model'];
      const withoutMessages = { ...base };
      delete withoutMessages['messages'];
      options.push(withoutModel, withoutMessages, { ...base, messages: [{ content: 'x' }] });
      break;
    }
    case 'extra-field':
      options.push(
        { ...base, n: 2 },
        { ...base, stop: ['x'] },
        { ...base, user: 'someone' },
        { ...base, response_format: { type: 'json_object' } },
        { ...base, [`extra_${key}`]: key },
        { ...base, ['__proto__']: { polluted: true } },
        { ...base, messages: [{ role: 'user', content: 'x', name: key }] },
        { ...base, tools: [{ ...validTool(0), extra: key }] },
      );
      break;
    case 'oversize':
      options.push(
        { ...base, messages: [{ role: 'user', content: 'x'.repeat(40_001) }] },
        { ...base, model: 'm'.repeat(101) },
        { ...base, messages: Array.from({ length: 61 }, () => ({ role: 'user', content: 'x' })) },
        { ...base, tools: Array.from({ length: 13 }, (_, i) => validTool(i)) },
        { ...base, max_tokens: 100_001 },
        { ...base, messages: [{ role: 'tool', tool_call_id: 'c'.repeat(201), content: 'x' }] },
      );
      break;
  }
  return options[index % options.length] ?? { model: 42 };
}

function nearLimitBody(total: number): string {
  const request = {
    model: 'auto',
    messages: Array.from({ length: 4 }, () => ({ role: 'user', content: 'a'.repeat(30_000) })),
  };
  const base = JSON.stringify(request);
  // JSON allows trailing whitespace, so the body is still a valid request at every size.
  return base + ' '.repeat(Math.max(0, total - base.length));
}

function materializeBody(spec: BodySpec): string | Uint8Array {
  switch (spec.kind) {
    case 'valid':
      return JSON.stringify(spec.request);
    case 'mutated':
      return JSON.stringify(mutate(spec.base, spec.mutation, spec.index, spec.key));
    case 'json':
      return JSON.stringify(spec.value);
    case 'text':
      return spec.text;
    case 'bytes':
      return spec.bytes;
    case 'near-limit':
      return nearLimitBody(spec.total);
  }
}

// ---- methods, headers, environment ---------------------------------------

type Method = 'POST' | 'GET' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

const arbMethod = pick<Method>([
  [92, 'POST'],
  [2, 'GET'],
  [1, 'PUT'],
  [1, 'DELETE'],
  [1, 'PATCH'],
  [1, 'OPTIONS'],
  [1, 'HEAD'],
]);

type HeaderSpec = {
  readonly origin: string | null;
  readonly fetchSite: string | null;
  readonly contentType: string | null;
  readonly contentLength: string | null;
  readonly ip: string | null;
};

const arbIp = fc.oneof(
  { weight: 80, arbitrary: fc.ipV4() },
  { weight: 10, arbitrary: fc.constant(null) },
  { weight: 10, arbitrary: printable },
);

const arbHeaders: fc.Arbitrary<HeaderSpec> = fc.record({
  origin: fc.oneof(
    { weight: 60, arbitrary: fc.constant<string | null>(ORIGIN) },
    { weight: 20, arbitrary: fc.constant<string | null>(ORIGIN_2) },
    { weight: 4, arbitrary: fc.constant<string | null>(`${ORIGIN}/`) },
    { weight: 4, arbitrary: fc.constant<string | null>(`${ORIGIN}.evil.example`) },
    { weight: 4, arbitrary: fc.constant<string | null>('https://evil.example') },
    { weight: 3, arbitrary: fc.constant<string | null>('null') },
    { weight: 3, arbitrary: fc.constant<string | null>(null) },
    { weight: 2, arbitrary: fc.constant<string | null>('') },
    { weight: 2, arbitrary: printable },
  ),
  fetchSite: pick<string | null>([
    [76, null],
    [16, 'same-origin'],
    [3, 'same-site'],
    [3, 'cross-site'],
    [1, 'none'],
    [1, 'garbage'],
  ]),
  contentType: fc.oneof(
    { weight: 70, arbitrary: fc.constant<string | null>('application/json') },
    { weight: 12, arbitrary: fc.constant<string | null>('application/json; charset=utf-8') },
    { weight: 4, arbitrary: fc.constant<string | null>('APPLICATION/JSON') },
    { weight: 4, arbitrary: fc.constant<string | null>('text/plain') },
    { weight: 3, arbitrary: fc.constant<string | null>(null) },
    { weight: 3, arbitrary: fc.constant<string | null>('application/jsonx') },
    { weight: 4, arbitrary: printable },
  ),
  contentLength: pick<string | null>([
    [76, null],
    [5, '999999999'],
    [4, `${LIMIT + 1}`],
    [5, '3'],
    [3, 'abc'],
    [3, '-5'],
    [5, '0'],
  ]),
  ip: arbIp,
});

/** Headers that pass the origin, content-type and size checks. */
const arbGoodHeaders: fc.Arbitrary<HeaderSpec> = fc.record({
  origin: pick<string | null>([
    [3, ORIGIN],
    [1, ORIGIN_2],
  ]),
  fetchSite: pick<string | null>([
    [3, null],
    [1, 'same-origin'],
  ]),
  contentType: pick<string | null>([
    [4, 'application/json'],
    [1, 'application/json; charset=utf-8'],
    [1, 'APPLICATION/JSON'],
  ]),
  // A lie below the limit is ignored: the bytes actually read decide.
  contentLength: pick<string | null>([
    [3, null],
    [1, '3'],
    [1, '0'],
    [1, 'abc'],
  ]),
  ip: arbIp,
});

type Breakage = 'none' | 'disabled' | 'no-salt' | 'missing-key' | 'bad-cap' | 'no-origins';

type EnvSpec = {
  readonly providers: readonly ProviderName[];
  readonly allowedModels: readonly string[];
  readonly maxOutput: number | undefined;
  readonly effort: 'minimal' | 'low' | 'medium' | 'high' | undefined;
  readonly breakage: Breakage;
};

const arbEnvSpec = (
  breakage: fc.Arbitrary<Breakage>,
  allowedModels: fc.Arbitrary<readonly string[]> = pick<readonly string[]>([
    [1, []],
    [2, [ALLOWED_MODEL, 'allowed-model-b']],
  ]),
): fc.Arbitrary<EnvSpec> =>
  fc.record({
    providers: pick<readonly ProviderName[]>([
      [5, ['sarvam', 'openai']],
      [3, ['openai', 'sarvam']],
      [1, ['sarvam']],
      [1, ['openai']],
    ]),
    allowedModels,
    maxOutput: fc.oneof(
      { weight: 3, arbitrary: fc.constant<number | undefined>(undefined) },
      { weight: 5, arbitrary: fc.integer({ min: 1, max: 4_096 }) },
    ),
    effort: pick<EnvSpec['effort']>([
      [4, undefined],
      [1, 'minimal'],
      [1, 'low'],
      [1, 'medium'],
      [1, 'high'],
    ]),
    breakage,
  });

const arbEnv = arbEnvSpec(
  pick<Breakage>([
    [90, 'none'],
    [2, 'disabled'],
    [2, 'no-salt'],
    [2, 'missing-key'],
    [2, 'bad-cap'],
    [2, 'no-origins'],
  ]),
);
/** Every model a valid request may ask for is allowed, so none is refused for its model. */
const arbGoodEnv = arbEnvSpec(
  fc.constant<Breakage>('none'),
  fc.constant<readonly string[]>([ALLOWED_MODEL, 'allowed-model-b']),
);

function buildEnv(spec: EnvSpec): Record<string, unknown> {
  const env: Record<string, unknown> = {
    AI_ALLOWED_ORIGINS: `${ORIGIN},${ORIGIN_2}`,
    AI_PROVIDERS: spec.providers.join(','),
    AI_SARVAM_MODEL: 'sarvam-model',
    AI_OPENAI_MODEL: 'openai-model',
    AI_ALLOWED_MODELS: spec.allowedModels.join(','),
    SARVAM_API_KEY: SARVAM_KEY,
    OPENAI_API_KEY: OPENAI_KEY,
    QUOTA_SALT: SALT,
  };
  if (spec.maxOutput !== undefined) env['AI_MAX_OUTPUT_TOKENS'] = String(spec.maxOutput);
  if (spec.effort !== undefined) env['AI_REASONING_EFFORT'] = spec.effort;
  switch (spec.breakage) {
    case 'none':
      break;
    case 'disabled':
      env['AI_ENABLED'] = 'false';
      break;
    case 'no-salt':
      delete env['QUOTA_SALT'];
      break;
    case 'missing-key': {
      const first = spec.providers[0] ?? 'sarvam';
      delete env[first === 'sarvam' ? 'SARVAM_API_KEY' : 'OPENAI_API_KEY'];
      break;
    }
    case 'bad-cap':
      env['AI_DAILY_CAP'] = 'many';
      break;
    case 'no-origins':
      delete env['AI_ALLOWED_ORIGINS'];
      break;
  }
  return env;
}

// ---- fake limiter, quota, clock ------------------------------------------

type Fault = 'throw-sync' | 'reject' | 'garbage';

type LimiterSpec =
  | { readonly kind: 'ok' }
  | { readonly kind: 'deny' }
  | { readonly kind: 'fail'; readonly fault: Fault; readonly garbage: unknown };

/** Answers that are neither `{ success: true }` nor `{ success: false }`. */
const LIMITER_GARBAGE: readonly unknown[] = [
  undefined,
  null,
  {},
  { success: 'yes' },
  { success: 1 },
  { success: null },
  'ok',
  42,
  [],
];

const arbLimiterFail: fc.Arbitrary<LimiterSpec> = fc.record({
  kind: fc.constant('fail' as const),
  fault: fc.constantFrom<Fault>('throw-sync', 'reject', 'garbage'),
  garbage: fc.constantFrom(...LIMITER_GARBAGE),
});

const arbLimiter: fc.Arbitrary<LimiterSpec> = fc.oneof(
  { weight: 80, arbitrary: fc.constant<LimiterSpec>({ kind: 'ok' }) },
  { weight: 12, arbitrary: fc.constant<LimiterSpec>({ kind: 'deny' }) },
  { weight: 8, arbitrary: arbLimiterFail },
);

type DenialReason = 'visitor' | 'daily' | 'daily-tokens' | 'lifetime' | 'lifetime-tokens';

type QuotaSpec =
  | { readonly kind: 'memory' }
  | { readonly kind: 'denied'; readonly reason: DenialReason }
  | { readonly kind: 'fail'; readonly fault: Fault; readonly garbage: unknown };

/**
 * Answers that claim neither success nor a denial. (`{ ok: false, reason: 'x' }` is a denial and
 * answers `DAILY_CAP`; it appears under `denied`, not here.)
 */
const QUOTA_GARBAGE: readonly unknown[] = [
  undefined,
  null,
  {},
  { ok: 'true' },
  { ok: 1 },
  { ok: null },
  'ok',
  42,
  [],
  { ok: false, reason: 'invalid-input' },
];

const arbQuotaFail: fc.Arbitrary<QuotaSpec> = fc.record({
  kind: fc.constant('fail' as const),
  fault: fc.constantFrom<Fault>('throw-sync', 'reject', 'garbage'),
  garbage: fc.constantFrom(...QUOTA_GARBAGE),
});

const arbQuota: fc.Arbitrary<QuotaSpec> = fc.oneof(
  { weight: 78, arbitrary: fc.constant<QuotaSpec>({ kind: 'memory' }) },
  {
    weight: 14,
    arbitrary: fc.record({
      kind: fc.constant('denied' as const),
      reason: fc.constantFrom<DenialReason>(
        'visitor',
        'daily',
        'daily-tokens',
        'lifetime',
        'lifetime-tokens',
      ),
    }),
  },
  { weight: 10, arbitrary: arbQuotaFail },
);

type TokensSpec = 'ok' | 'throw-sync' | 'reject';
const arbTokens = pick<TokensSpec>([
  [8, 'ok'],
  [1, 'throw-sync'],
  [1, 'reject'],
]);

type ClockSpec =
  | { readonly kind: 'fixed'; readonly ms: number }
  | { readonly kind: 'throws' }
  | { readonly kind: 'nan' };

const arbFixedClock: fc.Arbitrary<ClockSpec> = fc.record({
  kind: fc.constant('fixed' as const),
  ms: fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2027, 11, 31) }),
});

const arbClock: fc.Arbitrary<ClockSpec> = fc.oneof(
  { weight: 96, arbitrary: arbFixedClock },
  { weight: 2, arbitrary: fc.constant<ClockSpec>({ kind: 'throws' }) },
  { weight: 2, arbitrary: fc.constant<ClockSpec>({ kind: 'nan' }) },
);

function thrown(marker: string = MARKERS.thrown): Error {
  return new Error(leaky(marker));
}

function makeLimiter(spec: LimiterSpec): Limiter {
  return {
    limit: () => {
      switch (spec.kind) {
        case 'ok':
          return Promise.resolve({ success: true });
        case 'deny':
          return Promise.resolve({ success: false });
        case 'fail':
          if (spec.fault === 'throw-sync') throw thrown();
          if (spec.fault === 'reject') return Promise.reject(thrown());
          return Promise.resolve(spec.garbage as { success: boolean });
      }
    },
  };
}

function makeQuota(spec: QuotaSpec, tokens: TokensSpec, memory: QuotaClient): QuotaClient {
  return {
    reserve: (args) => {
      switch (spec.kind) {
        case 'memory':
          return memory.reserve(args);
        case 'denied':
          return Promise.resolve<GuardedReserveResult>({ ok: false, reason: spec.reason });
        case 'fail':
          if (spec.fault === 'throw-sync') throw thrown();
          if (spec.fault === 'reject') return Promise.reject(thrown());
          return Promise.resolve(spec.garbage as GuardedReserveResult);
      }
    },
    addTokens: (args) => {
      if (tokens === 'throw-sync') throw thrown();
      if (tokens === 'reject') return Promise.reject(thrown());
      return memory.addTokens(args);
    },
    snapshot: (args) => memory.snapshot(args),
  };
}

// ---- fake upstream -------------------------------------------------------

type ToolCallSpec = {
  readonly id: string | null | undefined;
  readonly name: string;
  readonly args: string;
};

type ReplySpec = {
  readonly content: string | null | undefined;
  readonly finish: string | null | undefined;
  readonly toolCalls: readonly ToolCallSpec[] | null | undefined;
  readonly usageShape: 'object' | 'null' | 'absent' | 'string' | 'array';
  readonly totalTokens: unknown;
  readonly extraChoices: number;
};

type Behavior =
  | { readonly kind: 'reply'; readonly reply: ReplySpec }
  | { readonly kind: 'status'; readonly status: number }
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'throw'; readonly how: 'sync' | 'reject' | 'reject-string' }
  | { readonly kind: 'slow'; readonly which: 'upstream' | 'total' };

const arbToolCallSpec: fc.Arbitrary<ToolCallSpec> = fc.record({
  id: fc.oneof(
    { weight: 6, arbitrary: callId },
    { weight: 1, arbitrary: fc.constant<string | null | undefined>('') },
    { weight: 1, arbitrary: fc.constant<string | null | undefined>(null) },
    { weight: 1, arbitrary: fc.constant<string | null | undefined>(undefined) },
    { weight: 1, arbitrary: fc.string({ minLength: 201, maxLength: 210 }) },
  ),
  name: fc.oneof(
    { weight: 9, arbitrary: fc.stringMatching(/^[a-z_]{1,30}$/) },
    { weight: 1, arbitrary: fc.string({ maxLength: 80 }) },
  ),
  args: fc.string({ maxLength: 60 }),
});

const arbReplySpec: fc.Arbitrary<ReplySpec> = fc.record({
  content: fc.oneof(
    { weight: 6, arbitrary: fc.string({ maxLength: 60 }) },
    { weight: 1, arbitrary: fc.constant<string | null | undefined>(null) },
    { weight: 1, arbitrary: fc.constant<string | null | undefined>(undefined) },
  ),
  finish: fc.oneof(
    { weight: 5, arbitrary: fc.constantFrom('stop', 'length', 'tool_calls') },
    { weight: 1, arbitrary: fc.string({ maxLength: 60 }) },
    { weight: 1, arbitrary: fc.constant<string | null | undefined>(null) },
    { weight: 1, arbitrary: fc.constant<string | null | undefined>(undefined) },
  ),
  toolCalls: fc.oneof(
    { weight: 4, arbitrary: fc.constant<readonly ToolCallSpec[] | null | undefined>(undefined) },
    { weight: 1, arbitrary: fc.constant<readonly ToolCallSpec[] | null | undefined>(null) },
    { weight: 4, arbitrary: fc.array(arbToolCallSpec, { maxLength: 3 }) },
  ),
  usageShape: pick<ReplySpec['usageShape']>([
    [10, 'object'],
    [1, 'null'],
    [1, 'absent'],
    [1, 'string'],
    [1, 'array'],
  ]),
  totalTokens: fc.constantFrom<unknown>(
    undefined,
    null,
    0,
    1,
    42,
    1_000,
    1_000_000,
    1.5,
    -5,
    'x',
    1e308,
    9e15,
    1e16,
  ),
  extraChoices: fc.nat(2),
});

const ERROR_STATUSES = [
  400, 401, 402, 403, 404, 408, 413, 422, 429, 429, 500, 500, 502, 503, 504, 529, 599,
] as const;

const arbBehavior: fc.Arbitrary<Behavior> = fc.oneof(
  {
    weight: 50,
    arbitrary: arbReplySpec.map((reply): Behavior => ({ kind: 'reply', reply })),
  },
  {
    weight: 20,
    arbitrary: fc
      .constantFrom<number>(...ERROR_STATUSES, 301, 302, 204)
      .map((status): Behavior => ({ kind: 'status', status })),
  },
  {
    weight: 8,
    arbitrary: fc
      .oneof(
        fc.constantFrom(
          '',
          'not json',
          '<html>bad gateway</html>',
          '{"choices":[]}',
          '[]',
          'null',
          'true',
          '"str"',
          '{"choices":[{"message":{"content":5}}]}',
          '{"choices":[{"message":{"tool_calls":[{"function":{"name":1}}]}}]}',
          '{"choices":[{"message":{}}]}',
        ),
        fc.string({ maxLength: 80 }),
      )
      .map((text): Behavior => ({ kind: 'text', text })),
  },
  {
    weight: 8,
    arbitrary: fc
      .constantFrom<'sync' | 'reject' | 'reject-string'>('sync', 'reject', 'reject-string')
      .map((how): Behavior => ({ kind: 'throw', how })),
  },
  {
    weight: 4,
    arbitrary: fc
      .constantFrom<'upstream' | 'total'>('upstream', 'total')
      .map((which): Behavior => ({ kind: 'slow', which })),
  },
);

const arbUpstream = fc.tuple(arbBehavior, arbBehavior);

/** A provider reply that carries a leaky value in every field the Worker ignores. */
function buildReply(spec: ReplySpec): unknown {
  const toolCalls =
    spec.toolCalls === undefined || spec.toolCalls === null
      ? spec.toolCalls
      : spec.toolCalls.map((call) => ({
          id: call.id,
          type: leaky(MARKERS.toolType),
          extra: leaky(MARKERS.toolExtra),
          function: { name: call.name, arguments: call.args, extra: leaky(MARKERS.functionExtra) },
        }));
  const usageBody = {
    prompt_tokens: 1,
    completion_tokens: 1,
    total_tokens: spec.totalTokens,
    details: leaky(MARKERS.usage),
  };
  const usage: Record<string, unknown> = {};
  switch (spec.usageShape) {
    case 'object':
      usage['usage'] = usageBody;
      break;
    case 'null':
      usage['usage'] = null;
      break;
    case 'string':
      usage['usage'] = leaky(MARKERS.usage);
      break;
    case 'array':
      usage['usage'] = [usageBody];
      break;
    case 'absent':
      break;
  }
  return {
    id: leaky(MARKERS.id),
    object: leaky(MARKERS.object),
    created: 1,
    model: leaky(MARKERS.model),
    system_fingerprint: leaky(MARKERS.fingerprint),
    service_tier: leaky(MARKERS.tier),
    ...usage,
    choices: [
      {
        index: 0,
        logprobs: leaky(MARKERS.logprobs),
        finish_reason: spec.finish,
        message: {
          role: leaky(MARKERS.role),
          content: spec.content,
          tool_calls: toolCalls,
          reasoning_content: leaky(MARKERS.reasoning),
          refusal: leaky(MARKERS.refusal),
          annotations: [leaky(MARKERS.annotations)],
          function_call: leaky(MARKERS.functionCall),
        },
      },
      ...Array.from({ length: spec.extraChoices }, (_, index) => ({
        index: index + 1,
        message: { role: 'assistant', content: leaky(MARKERS.choiceExtra) },
        finish_reason: leaky(MARKERS.choiceExtra),
      })),
    ],
  };
}

const NULL_BODY_STATUSES: readonly number[] = [101, 204, 205, 304];

function leakyHeaders(): Headers {
  return new Headers({
    'content-type': 'application/json',
    'x-upstream-secret': leaky(MARKERS.header),
    'www-authenticate': leaky(MARKERS.header),
  });
}

// ---- running one request -------------------------------------------------

type Scenario = {
  readonly method: Method;
  readonly headers: HeaderSpec;
  readonly body: BodySpec;
  readonly env: EnvSpec;
  readonly limiter: LimiterSpec;
  readonly quota: QuotaSpec;
  readonly tokens: TokensSpec;
  readonly clock: ClockSpec;
  readonly upstream: readonly [Behavior, Behavior];
};

type UpstreamCall = {
  readonly url: string;
  readonly headers: Headers;
  readonly bodyText: string;
  readonly body: unknown;
};

type Outcome = {
  readonly scenario: Scenario;
  /** Set when `app.request` rejected: always a failure of Property 1. */
  readonly rejected: unknown;
  readonly status: number;
  readonly text: string;
  readonly headerLines: readonly string[];
  readonly calls: readonly UpstreamCall[];
  readonly logs: readonly LogEntry[];
};

type FakeTimer = { readonly ms: number; readonly handler: () => void; cleared: boolean };

function fireTimer(timers: readonly FakeTimer[], ms: number): void {
  for (let index = timers.length - 1; index >= 0; index -= 1) {
    const timer = timers[index];
    if (timer !== undefined && timer.ms === ms && !timer.cleared) {
      timer.cleared = true;
      timer.handler();
      return;
    }
  }
}

function toInit(scenario: Scenario): RequestInit {
  const headers = new Headers();
  const { origin, fetchSite, contentType, contentLength, ip } = scenario.headers;
  if (origin !== null) headers.set('origin', origin);
  if (fetchSite !== null) headers.set('sec-fetch-site', fetchSite);
  if (contentType !== null) headers.set('content-type', contentType);
  if (contentLength !== null) headers.set('content-length', contentLength);
  if (ip !== null) headers.set('cf-connecting-ip', ip);
  const init: RequestInit = { method: scenario.method, headers };
  if (scenario.method !== 'GET' && scenario.method !== 'HEAD') {
    init.body = materializeBody(scenario.body);
  }
  return init;
}

async function runCase(scenario: Scenario): Promise<Outcome> {
  const timers: FakeTimer[] = [];
  const calls: UpstreamCall[] = [];
  const logs: LogEntry[] = [];
  const memory = createMemoryQuotaClient(createMemoryKv());
  const clock = scenario.clock;

  const deps: Partial<Deps> = {
    now: () => {
      if (clock.kind === 'throws') throw thrown();
      return clock.kind === 'nan' ? Number.NaN : clock.ms;
    },
    // Deliberately not `async`: a behavior may throw synchronously, like a broken `fetch`.
    fetch: (input, init) => {
      const bodyText = String(init?.body);
      let body: unknown;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = undefined;
      }
      calls.push({ url: String(input), headers: new Headers(init?.headers), bodyText, body });
      const behavior = scenario.upstream[Math.min(calls.length - 1, 1)] ?? scenario.upstream[0];
      switch (behavior.kind) {
        case 'reply':
          return Promise.resolve(
            new Response(JSON.stringify(buildReply(behavior.reply)), {
              status: 200,
              headers: leakyHeaders(),
            }),
          );
        case 'status':
          return Promise.resolve(
            new Response(
              NULL_BODY_STATUSES.includes(behavior.status)
                ? null
                : JSON.stringify({ error: { message: leaky(MARKERS.errorBody) } }),
              { status: behavior.status, headers: leakyHeaders() },
            ),
          );
        case 'text':
          return Promise.resolve(new Response(behavior.text, { status: 200 }));
        case 'throw':
          if (behavior.how === 'sync') throw thrown();
          if (behavior.how === 'reject') return Promise.reject(thrown());
          // A rejection with a plain string, not an Error, on purpose.
          return Promise.reject(leaky(MARKERS.thrown));
        case 'slow':
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(thrown()), { once: true });
            fireTimer(
              timers,
              behavior.which === 'upstream' ? DEFAULT_UPSTREAM_TIMEOUT_MS : TOTAL_TIMEOUT_MS,
            );
          });
      }
    },
    limiter: makeLimiter(scenario.limiter),
    quota: makeQuota(scenario.quota, scenario.tokens, memory),
    log: (entry) => {
      logs.push(entry);
    },
    setTimeout: (handler, ms) => {
      const timer: FakeTimer = { ms, handler, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      (handle as FakeTimer).cleared = true;
    },
  };

  const app = buildApp(deps);
  try {
    const response = await app.request('/api/ai/chat', toInit(scenario), buildEnv(scenario.env));
    const text = await response.text();
    const headerLines: string[] = [];
    response.headers.forEach((value, name) => headerLines.push(`${name}: ${value}`));
    return {
      scenario,
      rejected: undefined,
      status: response.status,
      text,
      headerLines,
      calls,
      logs,
    };
  } catch (error: unknown) {
    return { scenario, rejected: error, status: 0, text: '', headerLines: [], calls, logs };
  }
}

// ---- checks --------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The code of a body that is exactly `{ error: { code } }` with a known code, else undefined. */
function closedErrorCode(text: string): ErrorCode | undefined {
  const parsed = safeParse(text);
  if (!isRecord(parsed)) return undefined;
  const keys = Object.keys(parsed);
  if (keys.length !== 1 || keys[0] !== 'error') return undefined;
  const error = parsed['error'];
  if (!isRecord(error)) return undefined;
  const errorKeys = Object.keys(error);
  if (errorKeys.length !== 1 || errorKeys[0] !== 'code') return undefined;
  const code = error['code'];
  return ERROR_CODES.find((known) => known === code);
}

function secretsIn(text: string): string[] {
  return SECRETS.filter((secret) => text.includes(secret));
}

type Stats = {
  cases: number;
  ok: number;
  upstreamCalled: number;
  nonPost: number;
  codes: Map<string, number>;
};

function newStats(): Stats {
  return { cases: 0, ok: 0, upstreamCalled: 0, nonPost: 0, codes: new Map() };
}

const STATS: Record<'p1' | 'p2' | 'p4a' | 'p4b' | 'p5', Stats> = {
  p1: newStats(),
  p2: newStats(),
  p4a: newStats(),
  p4b: newStats(),
  p5: newStats(),
};

/** What every response must satisfy, whatever the request was. Records the stats. */
function checkClosed(outcome: Outcome, stats: Stats): void {
  expect(outcome.rejected, 'app.request must never reject').toBeUndefined();
  stats.cases += 1;
  if (outcome.calls.length > 0) stats.upstreamCalled += 1;

  // No secret in any response body or header, and none in a log line.
  expect(secretsIn(outcome.text), 'secret in the response body').toEqual([]);
  expect(secretsIn(outcome.headerLines.join('\n')), 'secret in a response header').toEqual([]);
  expect(secretsIn(JSON.stringify(outcome.logs)), 'secret in a log line').toEqual([]);
  for (const marker of MARKER_LIST) {
    expect(outcome.text.includes(marker), `ignored text ${marker} in the response`).toBe(false);
    expect(outcome.headerLines.join('\n').includes(marker), `${marker} in a header`).toBe(false);
  }
  // No CORS header on any response.
  for (const line of outcome.headerLines) {
    expect(line.toLowerCase().startsWith('access-control-'), `CORS header: ${line}`).toBe(false);
  }

  if (outcome.scenario.method !== 'POST') {
    // Requirement 1.3: any other method answers 404 like every unknown route.
    stats.nonPost += 1;
    stats.codes.set('404', (stats.codes.get('404') ?? 0) + 1);
    expect(outcome.status).toBe(404);
    expect(outcome.calls.length).toBe(0);
    expect(['', JSON.stringify({ error: 'Not found' })]).toContain(outcome.text);
    return;
  }

  if (outcome.status === 200) {
    stats.ok += 1;
    stats.codes.set('200', (stats.codes.get('200') ?? 0) + 1);
    const parsed = PublicReplySchema.safeParse(safeParse(outcome.text));
    expect(parsed.success, `a 200 body must parse with PublicReplySchema: ${outcome.text}`).toBe(
      true,
    );
    expect(outcome.calls.length, 'a 200 needs an upstream call').toBeGreaterThan(0);
    return;
  }

  const code = closedErrorCode(outcome.text);
  expect(code, `body must be exactly { error: { code } }: ${outcome.text}`).toBeDefined();
  if (code === undefined) return;
  stats.codes.set(code, (stats.codes.get(code) ?? 0) + 1);
  expect(outcome.status, `status of ${code}`).toBe(ERROR_STATUS[code]);
  if (ERROR_STATUS[code] === 429) {
    const retryAfter = outcome.headerLines
      .find((line) => line.startsWith('retry-after: '))
      ?.slice('retry-after: '.length);
    expect(Number(retryAfter), `Retry-After of ${code}`).toBeGreaterThanOrEqual(1);
  }
}

// ---- scenarios -----------------------------------------------------------

const arbScenario: fc.Arbitrary<Scenario> = fc.record({
  method: arbMethod,
  headers: arbHeaders,
  body: arbBody,
  env: arbEnv,
  limiter: arbLimiter,
  quota: arbQuota,
  tokens: arbTokens,
  clock: arbClock,
  upstream: arbUpstream,
});

/** A request that passes every check before the limits. Only the upstream varies a lot. */
const arbReaching: fc.Arbitrary<Scenario> = fc.record({
  method: fc.constant<Method>('POST'),
  headers: arbGoodHeaders,
  body: arbServedBody,
  env: arbGoodEnv,
  limiter: fc.constant<LimiterSpec>({ kind: 'ok' }),
  quota: fc.constant<QuotaSpec>({ kind: 'memory' }),
  tokens: arbTokens,
  clock: arbFixedClock,
  upstream: arbUpstream,
});

function formatStats(name: string, stats: Stats): string {
  const codes = [...stats.codes.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([code, count]) => `${code} ${count}`)
    .join(', ');
  return (
    `[proxy] ${name} seed ${TEST_SEED}: ${stats.cases} cases, ` +
    `${stats.upstreamCalled} reached the upstream, ${stats.ok} answered 200, ` +
    `${stats.nonPost} non-POST; ${codes}\n`
  );
}

function expectedMaxOutput(env: EnvSpec): number {
  return env.maxOutput ?? DEFAULT_MAX_OUTPUT;
}

const ALLOWED_UPSTREAM_KEYS: readonly string[] = [
  'model',
  'messages',
  'tools',
  'tool_choice',
  'stream',
  'temperature',
  'max_tokens',
  'max_completion_tokens',
  'reasoning_effort',
];

function providerOfUrl(url: string): ProviderName | undefined {
  if (url === URLS.sarvam) return 'sarvam';
  if (url === URLS.openai) return 'openai';
  return undefined;
}

function checkForwarded(outcome: Outcome): void {
  const { scenario, calls } = outcome;
  const bodyInput = materializeBody(scenario.body);
  const sent: unknown = safeParse(typeof bodyInput === 'string' ? bodyInput : '');
  expect(isRecord(sent), 'a request that reached the upstream was valid JSON').toBe(true);
  if (!isRecord(sent)) return;
  const maxOutput = expectedMaxOutput(scenario.env);
  expect(calls.length).toBeLessThanOrEqual(scenario.env.providers.length);

  calls.forEach((call, index) => {
    const provider = providerOfUrl(call.url);
    expect(provider, `upstream URL ${call.url} is one of the two table URLs`).toBeDefined();
    if (provider === undefined) return;
    expect(provider, `call ${index} goes to the provider listed at ${index}`).toBe(
      scenario.env.providers[index],
    );

    const body = call.body;
    expect(isRecord(body), 'the upstream body is a JSON object').toBe(true);
    if (!isRecord(body)) return;
    for (const key of Object.keys(body)) {
      expect(ALLOWED_UPSTREAM_KEYS, `forwarded key ${key}`).toContain(key);
    }
    expect(body['stream']).toBe(false);
    expect(body['messages']).toEqual(sent['messages']);
    if ('tools' in sent) expect(body['tools']).toEqual(sent['tools']);
    else expect('tools' in body).toBe(false);
    if ('tool_choice' in sent) expect(body['tool_choice']).toEqual(sent['tool_choice']);
    else expect('tool_choice' in body).toBe(false);
    expect(typeof body['model']).toBe('string');

    // Exactly one token parameter, by provider, clamped.
    const tokenParam = provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
    const otherParam = provider === 'openai' ? 'max_tokens' : 'max_completion_tokens';
    expect(otherParam in body, `${otherParam} must be absent for ${provider}`).toBe(false);
    const limit = body[tokenParam];
    expect(Number.isInteger(limit)).toBe(true);
    expect(limit as number).toBeGreaterThanOrEqual(1);
    expect(limit as number).toBeLessThanOrEqual(maxOutput);
    const requested = sent['max_tokens'];
    if (typeof requested === 'number') expect(limit as number).toBeLessThanOrEqual(requested);
    else expect(limit).toBe(maxOutput);

    // Temperature.
    if (provider === 'openai') {
      expect('temperature' in body, 'no temperature for openai').toBe(false);
    } else if (typeof sent['temperature'] === 'number') {
      const temperature = body['temperature'];
      expect(typeof temperature).toBe('number');
      expect(temperature as number).toBeGreaterThanOrEqual(0);
      expect(temperature as number).toBeLessThanOrEqual(1);
      expect(temperature).toBe(Math.min(1, Math.max(0, sent['temperature'])));
    } else {
      expect('temperature' in body).toBe(false);
    }

    // reasoning_effort only for openai and only when configured.
    if (provider === 'openai' && scenario.env.effort !== undefined) {
      expect(body['reasoning_effort']).toBe(scenario.env.effort);
    } else {
      expect('reasoning_effort' in body).toBe(false);
    }

    // The key header is this provider's key, and no other secret is anywhere in the call.
    const headerEntries: string[] = [];
    call.headers.forEach((value, name) => headerEntries.push(`${name}: ${value}`));
    const everything = `${call.url}\n${call.bodyText}\n${headerEntries.join('\n')}`;
    const others = SECRETS.filter((secret) => secret !== KEYS[provider]);
    for (const secret of others) {
      expect(everything.includes(secret), `${secret} must not be sent to ${provider}`).toBe(false);
    }
    expect(call.headers.get('authorization')).toBe(`Bearer ${KEYS[provider]}`);
    expect(call.bodyText.includes(KEYS[provider]), 'the key is never in the body').toBe(false);
    expect(call.url.includes(KEYS[provider]), 'the key is never in the URL').toBe(false);
  });
}

// ---- the properties ------------------------------------------------------

describe('AI proxy properties (fake limiter, quota and upstream)', () => {
  // Feature: worker-backend, Property 1: Total and closed
  // **Validates: Requirements 1.2, 1.3, 9.3**
  it(
    'Property 1: Total and closed',
    async () => {
      await assertAsyncProperty(
        fc.asyncProperty(arbScenario, async (scenario) => {
          const outcome = await runCase(scenario);
          checkClosed(outcome, STATS.p1);
          // A body that is certainly invalid never gets a 200 and never reaches the upstream.
          if (scenario.method === 'POST' && scenario.body.kind === 'mutated') {
            expect(outcome.status, 'a mutated request is never answered 200').not.toBe(200);
            expect(outcome.calls.length, 'a mutated request never reaches the upstream').toBe(0);
          }
        }),
        { numRuns: 400 },
      );
      process.stderr.write(formatStats('P1', STATS.p1));
    },
    TEST_TIMEOUT_MS,
  );

  // Feature: worker-backend, Property 2: Forwarded fields are an allowlist
  // **Validates: Requirements 2.3, 2.4, 5.7, 9.3**
  it(
    'Property 2: Forwarded fields are an allowlist',
    async () => {
      await assertAsyncProperty(
        fc.asyncProperty(arbReaching, async (scenario) => {
          const outcome = await runCase(scenario);
          checkClosed(outcome, STATS.p2);
          checkForwarded(outcome);
        }),
        { numRuns: 300 },
      );
      process.stderr.write(formatStats('P2', STATS.p2));
    },
    TEST_TIMEOUT_MS,
  );

  // Feature: worker-backend, Property 4: Fail closed
  // **Validates: Requirements 4.8, 9.3**
  it(
    'Property 4: Fail closed (a request that would otherwise be served)',
    async () => {
      const arbFault: fc.Arbitrary<Pick<Scenario, 'limiter' | 'quota'>> = fc.oneof(
        arbLimiterFail.map((limiter) => ({ limiter, quota: { kind: 'memory' } as QuotaSpec })),
        arbQuotaFail.map((quota) => ({ limiter: { kind: 'ok' } as LimiterSpec, quota })),
      );
      await assertAsyncProperty(
        fc.asyncProperty(arbReaching, arbFault, async (base, fault) => {
          const outcome = await runCase({ ...base, ...fault });
          checkClosed(outcome, STATS.p4a);
          expect(outcome.calls.length, 'the upstream must not be called').toBe(0);
          expect(outcome.status).toBe(ERROR_STATUS.UPSTREAM_FAILED);
          expect(closedErrorCode(outcome.text)).toBe('UPSTREAM_FAILED');
        }),
        { numRuns: 200 },
      );
      process.stderr.write(formatStats('P4a', STATS.p4a));
    },
    TEST_TIMEOUT_MS,
  );

  // Feature: worker-backend, Property 4: Fail closed
  // **Validates: Requirements 4.8, 9.3**
  it(
    'Property 4: Fail closed (any request at all)',
    async () => {
      const arbFault: fc.Arbitrary<Pick<Scenario, 'limiter' | 'quota'>> = fc.oneof(
        arbLimiterFail.map((limiter) => ({ limiter, quota: { kind: 'memory' } as QuotaSpec })),
        arbQuotaFail.map((quota) => ({ limiter: { kind: 'ok' } as LimiterSpec, quota })),
      );
      await assertAsyncProperty(
        fc.asyncProperty(arbScenario, arbFault, async (base, fault) => {
          const outcome = await runCase({ ...base, ...fault });
          checkClosed(outcome, STATS.p4b);
          expect(outcome.calls.length, 'the upstream must not be called').toBe(0);
          expect(outcome.status).not.toBe(200);
        }),
        { numRuns: 200 },
      );
      process.stderr.write(formatStats('P4b', STATS.p4b));
    },
    TEST_TIMEOUT_MS,
  );

  // Feature: worker-backend, Property 5: The reply allowlist
  // **Validates: Requirements 5.6, 9.3**
  it(
    'Property 5: The reply allowlist',
    async () => {
      const arbHostile: fc.Arbitrary<Scenario> = fc.record({
        method: fc.constant<Method>('POST'),
        headers: arbGoodHeaders,
        body: arbServedBody,
        env: arbGoodEnv,
        limiter: fc.constant<LimiterSpec>({ kind: 'ok' }),
        quota: fc.constant<QuotaSpec>({ kind: 'memory' }),
        tokens: arbTokens,
        clock: arbFixedClock,
        upstream: fc.tuple(
          arbReplySpec.map((reply): Behavior => ({ kind: 'reply', reply })),
          arbReplySpec.map((reply): Behavior => ({ kind: 'reply', reply })),
        ),
      });
      await assertAsyncProperty(
        fc.asyncProperty(arbHostile, async (scenario) => {
          const outcome = await runCase(scenario);
          checkClosed(outcome, STATS.p5);
          if (outcome.status !== 200) return;

          // The answering call is the last one: the loop stops at the first success.
          const answering = scenario.upstream[Math.min(outcome.calls.length - 1, 1)];
          expect(answering?.kind).toBe('reply');
          if (answering?.kind !== 'reply') return;
          const upstream = answering.reply;

          const body = safeParse(outcome.text);
          expect(PublicReplySchema.safeParse(body).success).toBe(true);
          expect(isRecord(body)).toBe(true);
          if (!isRecord(body)) return;
          expect(Object.keys(body)).toEqual(['choices']);
          const choices = body['choices'];
          expect(Array.isArray(choices) && choices.length === 1).toBe(true);
          const choice: unknown = Array.isArray(choices) ? choices[0] : undefined;
          expect(isRecord(choice)).toBe(true);
          if (!isRecord(choice)) return;
          expect(Object.keys(choice).sort()).toEqual(['finish_reason', 'message']);
          expect((upstream.finish ?? 'stop').startsWith(String(choice['finish_reason']))).toBe(
            true,
          );

          const message = choice['message'];
          expect(isRecord(message)).toBe(true);
          if (!isRecord(message)) return;
          for (const key of Object.keys(message)) {
            expect(['role', 'content', 'tool_calls'], `message key ${key}`).toContain(key);
          }
          expect(message['role']).toBe('assistant');
          expect(message['content']).toBe(upstream.content ?? null);

          const upstreamCalls = upstream.toolCalls ?? [];
          if (upstreamCalls.length === 0) {
            expect('tool_calls' in message).toBe(false);
          } else {
            const publicCalls = message['tool_calls'];
            expect(Array.isArray(publicCalls)).toBe(true);
            if (!Array.isArray(publicCalls)) return;
            expect(publicCalls.length).toBe(upstreamCalls.length);
            publicCalls.forEach((call: unknown, index) => {
              const expected = upstreamCalls[index];
              expect(isRecord(call)).toBe(true);
              if (!isRecord(call) || expected === undefined) return;
              expect(Object.keys(call).sort()).toEqual(['function', 'id', 'type']);
              expect(call['type']).toBe('function');
              const fn = call['function'];
              expect(isRecord(fn)).toBe(true);
              if (!isRecord(fn)) return;
              expect(Object.keys(fn).sort()).toEqual(['arguments', 'name']);
              expect(fn['name']).toBe(expected.name);
              expect(fn['arguments']).toBe(expected.args);
              expect(typeof call['id']).toBe('string');
              expect((call['id'] as string).length).toBeGreaterThan(0);
              if (typeof expected.id === 'string' && expected.id !== '') {
                expect(call['id']).toBe(expected.id);
              }
            });
          }
        }),
        { numRuns: 300 },
      );
      process.stderr.write(formatStats('P5', STATS.p5));
    },
    TEST_TIMEOUT_MS,
  );

  // The properties above must have exercised the interesting branches, or they prove little.
  it('coverage: the generators reached the success path and the error codes', () => {
    // Skipped when a single property was selected with `-t`.
    if (STATS.p1.cases === 0 || STATS.p5.cases === 0) return;
    const seen = (stats: Stats, code: string): number => stats.codes.get(code) ?? 0;

    for (const code of [
      '200',
      'BAD_REQUEST',
      'FORBIDDEN_ORIGIN',
      'PAYLOAD_TOO_LARGE',
      'RATE_LIMITED',
      'DAILY_CAP',
      'MODEL_NOT_ALLOWED',
      'AI_DISABLED',
      'UPSTREAM_FAILED',
      '404',
    ]) {
      expect(seen(STATS.p1, code), `P1 saw ${code}`).toBeGreaterThan(0);
    }
    expect(
      STATS.p1.upstreamCalled / STATS.p1.cases,
      'P1 share that reached the upstream',
    ).toBeGreaterThan(0.08);
    expect(
      STATS.p2.upstreamCalled / STATS.p2.cases,
      'P2 share that reached the upstream',
    ).toBeGreaterThan(0.6);
    expect(STATS.p4a.cases).toBeGreaterThan(0);
    expect(seen(STATS.p4a, 'UPSTREAM_FAILED'), 'P4a answered UPSTREAM_FAILED').toBe(
      STATS.p4a.cases,
    );
    expect(STATS.p4b.cases).toBeGreaterThan(0);
    expect(STATS.p5.ok / STATS.p5.cases, 'P5 share answered 200').toBeGreaterThan(0.6);

    process.stderr.write(formatStats('P1', STATS.p1));
  });
});

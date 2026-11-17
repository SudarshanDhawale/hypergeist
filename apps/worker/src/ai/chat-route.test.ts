import { AI_WIRE_LIMITS, PublicReplySchema } from '@hypergeist/shared/ai-wire';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../env';
import { ERROR_CODES, ERROR_STATUS, type ErrorCode } from '../lib/errors';
import type { LogEntry } from '../lib/log';
import { utcDate } from '../lib/time';
import { visitorKey } from '../lib/visitor';
import { handleChat } from './chat-route';
import { defaultDeps, type Deps } from './deps';
import {
  createMemoryQuotaClient,
  type AddTokensArgs,
  type QuotaClient,
  type ReserveArgs,
} from './quota-client';
import { createMemoryKv } from './quota-logic';

const ORIGIN = 'http://localhost:8787';
const IP = '203.0.113.7';
const SARVAM_KEY = 'test-secret-sarvam-0000';
const OPENAI_KEY = 'test-secret-openai-0000';
const SALT = 'test-secret-salt-0000';
const SECRET_PREFIX = 'test-secret-';

const BASE_ENV: Readonly<Record<string, unknown>> = {
  AI_ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
  AI_PROVIDERS: 'sarvam',
  AI_SARVAM_MODEL: 'sarvam-model',
  AI_OPENAI_MODEL: 'openai-model',
  SARVAM_API_KEY: SARVAM_KEY,
  OPENAI_API_KEY: OPENAI_KEY,
  QUOTA_SALT: SALT,
};

const TWO_PROVIDERS: Readonly<Record<string, unknown>> = {
  ...BASE_ENV,
  AI_PROVIDERS: 'sarvam,openai',
};

/** 2026-11-15 12:00:00 UTC. */
const NOON = Date.UTC(2026, 10, 15, 12, 0, 0);
/** 2026-11-15 23:59:30 UTC: 30 seconds before midnight. */
const BEFORE_MIDNIGHT = Date.UTC(2026, 10, 15, 23, 59, 30);

const PROMPT_TEXT = 'UNIQUE-PROMPT-TEXT-4711';
const REPLY_TEXT = 'UNIQUE-REPLY-TEXT-0815';

// ---- fakes ---------------------------------------------------------------

type UpstreamCall = {
  readonly url: string;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | null | undefined;
};
type Upstream = (call: UpstreamCall, index: number) => Promise<Response> | Response;

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** An upstream reply with fields that must never reach the browser. */
function upstreamReply(content: string | null = REPLY_TEXT, totalTokens = 42): unknown {
  return {
    id: 'chatcmpl-secret-id',
    system_fingerprint: 'fp-secret',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content, reasoning_content: 'hidden thoughts' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: totalTokens },
  };
}

const respondOk: Upstream = () => jsonResponse(upstreamReply());

/** Waits until the request's abort signal fires, then fails like a real aborted `fetch`. */
const hang: Upstream = (call) =>
  new Promise<Response>((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

type FakeTimer = { readonly ms: number; readonly handler: () => void; cleared: boolean };

function fakeTimers() {
  const timers: FakeTimer[] = [];
  return {
    timers,
    setTimeout: (handler: () => void, ms: number): unknown => {
      const timer: FakeTimer = { ms, handler, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle: unknown): void => {
      (handle as FakeTimer).cleared = true;
    },
  };
}

type SetupOptions = {
  upstream?: Upstream;
  limit?: (args: { key: string }) => Promise<{ success: boolean }>;
  quota?: Partial<QuotaClient>;
  time?: number;
  /** Milliseconds the clock moves forward during each upstream call. */
  upstreamMs?: number;
  timers?: boolean;
  log?: (entry: LogEntry) => void;
};

function setup(options: SetupOptions = {}) {
  const clock = { now: options.time ?? NOON };
  const memory = createMemoryQuotaClient(createMemoryKv());
  const reserveCalls: ReserveArgs[] = [];
  const addTokensCalls: AddTokensArgs[] = [];
  const limiterKeys: string[] = [];
  const upstreamCalls: UpstreamCall[] = [];
  const logs: LogEntry[] = [];
  const timers = fakeTimers();
  const upstream = options.upstream ?? respondOk;

  const quota: QuotaClient = {
    reserve: (args) => {
      reserveCalls.push(args);
      return (options.quota?.reserve ?? memory.reserve)(args);
    },
    addTokens: (args) => {
      addTokensCalls.push(args);
      return (options.quota?.addTokens ?? memory.addTokens)(args);
    },
    snapshot: (args) => (options.quota?.snapshot ?? memory.snapshot)(args),
  };

  const deps: Deps = {
    now: () => clock.now,
    fetch: async (input, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      const call: UpstreamCall = {
        url: String(input),
        headers: new Headers(init?.headers),
        body: body as Record<string, unknown>,
        signal: init?.signal,
      };
      upstreamCalls.push(call);
      clock.now += options.upstreamMs ?? 0;
      return upstream(call, upstreamCalls.length - 1);
    },
    limiter: {
      limit: (args) => {
        limiterKeys.push(args.key);
        return (options.limit ?? (() => Promise.resolve({ success: true })))(args);
      },
    },
    quota,
    log: (entry) => {
      logs.push(entry);
      options.log?.(entry);
    },
    ...(options.timers === true
      ? { setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout }
      : {}),
  };
  return { deps, clock, reserveCalls, addTokensCalls, limiterKeys, upstreamCalls, logs, timers };
}

type Harness = ReturnType<typeof setup>;

type RequestOptions = {
  /** A JSON-serializable body (default: a minimal valid request). */
  json?: unknown;
  /** A raw body; wins over `json`. */
  raw?: BodyInit | null;
  /** Header overrides. `null` removes the header. */
  headers?: Record<string, string | null>;
};

function validBody(): Record<string, unknown> {
  return { model: 'auto', messages: [{ role: 'user', content: PROMPT_TEXT }] };
}

function chatRequest(options: RequestOptions = {}): Request {
  const headers = new Headers({
    origin: ORIGIN,
    'content-type': 'application/json',
    'cf-connecting-ip': IP,
  });
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  const body =
    options.raw !== undefined ? options.raw : JSON.stringify(options.json ?? validBody());
  return new Request('http://localhost:8787/api/ai/chat', { method: 'POST', headers, body });
}

type Sent = {
  readonly response: Response;
  readonly text: string;
  readonly log: LogEntry;
};

/**
 * Sends one request and checks what must hold for every request: exactly one log line, and no
 * test secret in the body, the headers or the log line.
 */
async function send(
  harness: Harness,
  request: Request = chatRequest(),
  env: Readonly<Record<string, unknown>> = BASE_ENV,
): Promise<Sent> {
  const before = harness.logs.length;
  const response = await handleChat(request, { ...env }, harness.deps);
  const text = await response.text();
  expect(harness.logs.length - before).toBe(1);
  const log = harness.logs[harness.logs.length - 1] as LogEntry;
  expect(text).not.toContain(SECRET_PREFIX);
  expect(JSON.stringify([...response.headers])).not.toContain(SECRET_PREFIX);
  expect(JSON.stringify(log)).not.toContain(SECRET_PREFIX);
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
  return { response, text, log };
}

function expectError(sent: Sent, code: ErrorCode, extra: { retryAfter?: string } = {}): void {
  expect(sent.response.status).toBe(ERROR_STATUS[code]);
  expect(JSON.parse(sent.text)).toEqual({ error: { code } });
  expect(sent.response.headers.get('content-type')).toBe('application/json');
  expect(sent.response.headers.get('cache-control')).toBe('no-store');
  expect(sent.response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(sent.response.headers.get('retry-after')).toBe(extra.retryAfter ?? null);
  expect(sent.log.status).toBe(ERROR_STATUS[code]);
  expect(sent.log.code).toBe(code);
}

/** Nothing outside the pipeline's early steps was touched. */
function expectUntouched(harness: Harness): void {
  expect(harness.limiterKeys).toEqual([]);
  expect(harness.reserveCalls).toEqual([]);
  expect(harness.addTokensCalls).toEqual([]);
  expect(harness.upstreamCalls).toEqual([]);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---- configuration and kill switch ---------------------------------------

describe('handleChat: configuration', () => {
  it('answers AI_DISABLED when the kill switch is off, and touches nothing', async () => {
    const h = setup();
    const sent = await send(h, chatRequest(), { ...BASE_ENV, AI_ENABLED: 'false' });
    expectError(sent, 'AI_DISABLED');
    expect(sent.log).toMatchObject({ provider: 'none', kind: 'none', counted: false });
    expectUntouched(h);
  });

  it.each([
    ['an empty environment', {}],
    ['a missing key for the listed provider', { ...BASE_ENV, SARVAM_API_KEY: undefined }],
    ['a missing model for the listed provider', { ...BASE_ENV, AI_SARVAM_MODEL: undefined }],
    ['an unknown provider name', { ...BASE_ENV, AI_PROVIDERS: 'groq' }],
    ['an empty origin list', { ...BASE_ENV, AI_ALLOWED_ORIGINS: '' }],
    ['a missing salt', { ...BASE_ENV, QUOTA_SALT: undefined }],
    ['a cap that is not a number', { ...BASE_ENV, AI_DAILY_CAP: 'many' }],
    ['a cap out of range', { ...BASE_ENV, AI_DAILY_CAP: '0' }],
    ['an unknown reasoning effort', { ...BASE_ENV, AI_REASONING_EFFORT: 'extreme' }],
  ])('answers AI_DISABLED for %s, and touches nothing', async (_name, env) => {
    const h = setup();
    expectError(await send(h, chatRequest(), env), 'AI_DISABLED');
    expectUntouched(h);
  });

  it('checks the configuration before the origin', async () => {
    const h = setup();
    const request = chatRequest({ headers: { origin: 'https://evil.example' } });
    expectError(await send(h, request, {}), 'AI_DISABLED');
  });
});

// ---- origin, content type, body ------------------------------------------

describe('handleChat: origin', () => {
  it.each([
    ['a missing Origin', { origin: null }],
    ['a wrong Origin', { origin: 'https://evil.example' }],
    ['the string "null"', { origin: 'null' }],
    ['a cross-site request', { 'sec-fetch-site': 'cross-site' }],
    ['a same-site request', { 'sec-fetch-site': 'same-site' }],
  ])('answers FORBIDDEN_ORIGIN for %s, before anything else is touched', async (_name, headers) => {
    const h = setup();
    // The body is invalid on purpose: the origin check comes first.
    const sent = await send(h, chatRequest({ headers, raw: 'not json' }));
    expectError(sent, 'FORBIDDEN_ORIGIN');
    expectUntouched(h);
  });

  it('answers FORBIDDEN_ORIGIN for a POST without Origin even with Sec-Fetch-Site: same-origin', async () => {
    const h = setup();
    const sent = await send(
      h,
      chatRequest({ headers: { origin: null, 'sec-fetch-site': 'same-origin' } }),
    );
    expectError(sent, 'FORBIDDEN_ORIGIN');
    expectUntouched(h);
  });

  it('does not let a stray GET use the no-Origin exception', async () => {
    const h = setup();
    const request = new Request('http://localhost:8787/api/ai/chat', {
      method: 'GET',
      headers: { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
    });
    expectError(await send(h, request), 'FORBIDDEN_ORIGIN');
    expectUntouched(h);
  });

  it('accepts a request with Sec-Fetch-Site: same-origin', async () => {
    const h = setup();
    const sent = await send(h, chatRequest({ headers: { 'sec-fetch-site': 'same-origin' } }));
    expect(sent.response.status).toBe(200);
  });

  it('accepts the second configured origin', async () => {
    const h = setup();
    const sent = await send(h, chatRequest({ headers: { origin: 'http://localhost:5173' } }));
    expect(sent.response.status).toBe(200);
  });
});

describe('handleChat: content type and body', () => {
  it.each([
    ['no content type', { 'content-type': null }],
    ['text/plain', { 'content-type': 'text/plain' }],
    ['a form type', { 'content-type': 'application/x-www-form-urlencoded' }],
    ['a type that only starts like JSON', { 'content-type': 'application/jsonx' }],
  ])('answers BAD_REQUEST for %s', async (_name, headers) => {
    const h = setup();
    const request = new Request('http://localhost:8787/api/ai/chat', {
      method: 'POST',
      headers: new Headers(
        Object.entries({ origin: ORIGIN, ...headers }).filter(
          (entry): entry is [string, string] => entry[1] !== null,
        ),
      ),
      body: JSON.stringify(validBody()),
    });
    // `Request` adds `text/plain` for a string body; set the header explicitly when it is wanted.
    if (headers['content-type'] === null) request.headers.delete('content-type');
    expectError(await send(h, request), 'BAD_REQUEST');
    expectUntouched(h);
  });

  it.each([
    'application/json',
    'application/json; charset=utf-8',
    'Application/JSON;charset=UTF-8',
  ])('accepts the content type %s', async (contentType) => {
    const h = setup();
    const sent = await send(h, chatRequest({ headers: { 'content-type': contentType } }));
    expect(sent.response.status).toBe(200);
  });

  it('answers PAYLOAD_TOO_LARGE for a body over the limit', async () => {
    const h = setup();
    const big = JSON.stringify({ ...validBody(), model: 'x'.repeat(AI_WIRE_LIMITS.maxBodyBytes) });
    expectError(await send(h, chatRequest({ raw: big })), 'PAYLOAD_TOO_LARGE');
    expectUntouched(h);
  });

  it('answers PAYLOAD_TOO_LARGE for a content-length over the limit without reading', async () => {
    const h = setup();
    const request = chatRequest({
      headers: { 'content-length': String(AI_WIRE_LIMITS.maxBodyBytes + 1) },
    });
    expectError(await send(h, request), 'PAYLOAD_TOO_LARGE');
    expectUntouched(h);
  });

  it('answers BAD_REQUEST for a body stream that fails', async () => {
    const h = setup();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('boom'));
      },
    });
    const request = new Request('http://localhost:8787/api/ai/chat', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    expectError(await send(h, request), 'BAD_REQUEST');
    expectUntouched(h);
  });

  it.each([
    ['invalid JSON', '{"model":'],
    ['an empty body', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a string', '"hello"'],
    ['an unknown top-level field', JSON.stringify({ ...validBody(), n: 2 })],
    ['stream: true', JSON.stringify({ ...validBody(), stream: true })],
    ['an empty messages list', JSON.stringify({ model: 'auto', messages: [] })],
    ['a missing model', JSON.stringify({ messages: validBody()['messages'] })],
    [
      'too many messages',
      JSON.stringify({
        model: 'auto',
        messages: Array.from({ length: AI_WIRE_LIMITS.maxMessages + 1 }, () => ({
          role: 'user',
          content: 'x',
        })),
      }),
    ],
  ])('answers BAD_REQUEST for %s, before the limiter or the quota', async (_name, raw) => {
    const h = setup();
    expectError(await send(h, chatRequest({ raw })), 'BAD_REQUEST');
    expectUntouched(h);
  });

  it('does not echo request text in the error', async () => {
    const h = setup();
    const sent = await send(h, chatRequest({ json: { ...validBody(), extra: PROMPT_TEXT } }));
    expectError(sent, 'BAD_REQUEST');
    expect(sent.text).not.toContain(PROMPT_TEXT);
    expect(JSON.stringify(sent.log)).not.toContain(PROMPT_TEXT);
  });
});

// ---- model ---------------------------------------------------------------

describe('handleChat: model', () => {
  it('answers MODEL_NOT_ALLOWED for a model that is not on the list, before the limiter', async () => {
    const h = setup();
    const sent = await send(h, chatRequest({ json: { ...validBody(), model: 'gpt-x' } }));
    expectError(sent, 'MODEL_NOT_ALLOWED');
    expectUntouched(h);
  });

  it('accepts a model on the allowlist and sends it to the first provider only', async () => {
    const h = setup({
      upstream: (_call, index) =>
        index === 0 ? jsonResponse({}, 500) : jsonResponse(upstreamReply()),
    });
    const env = { ...TWO_PROVIDERS, AI_ALLOWED_MODELS: 'special-model, other-model' };
    const sent = await send(
      h,
      chatRequest({ json: { ...validBody(), model: 'special-model' } }),
      env,
    );
    expect(sent.response.status).toBe(200);
    expect(h.upstreamCalls.map((call) => call.body['model'])).toEqual([
      'special-model',
      'openai-model',
    ]);
  });

  it('maps "auto" to the configured model of the provider', async () => {
    const h = setup();
    await send(h);
    expect(h.upstreamCalls[0]?.body['model']).toBe('sarvam-model');
  });
});

// ---- burst limit ---------------------------------------------------------

describe('handleChat: burst limit', () => {
  it('answers RATE_LIMITED with Retry-After 60, before the quota is touched', async () => {
    const h = setup({ limit: () => Promise.resolve({ success: false }) });
    const sent = await send(h);
    expectError(sent, 'RATE_LIMITED', { retryAfter: '60' });
    expect(sent.log).toMatchObject({ provider: 'none', kind: 'none', counted: false });
    expect(h.limiterKeys).toHaveLength(1);
    expect(h.reserveCalls).toEqual([]);
    expect(h.upstreamCalls).toEqual([]);
  });

  it('keys the limiter by "chat:" plus the salted, hashed visitor key', async () => {
    const h = setup();
    await send(h);
    const expected = await visitorKey(IP, SALT, utcDate(NOON));
    expect(h.limiterKeys).toEqual([`chat:${expected}`]);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
    expect(h.limiterKeys[0]).not.toContain(IP);
  });

  it('uses one shared key when CF-Connecting-IP is missing', async () => {
    const h = setup();
    await send(h, chatRequest({ headers: { 'cf-connecting-ip': null } }));
    const expected = await visitorKey(null, SALT, utcDate(NOON));
    expect(h.limiterKeys).toEqual([`chat:${expected}`]);
  });

  it('changes the visitor key with the UTC date', async () => {
    const h = setup();
    await send(h);
    h.clock.now += 24 * 60 * 60 * 1000;
    await send(h);
    expect(h.limiterKeys[0]).not.toBe(h.limiterKeys[1]);
  });

  it.each([
    ['throws', () => Promise.reject(new Error(`limiter exploded ${SARVAM_KEY}`))],
    [
      'throws synchronously',
      () => {
        throw new Error('limiter exploded');
      },
    ],
    ['returns nothing', () => Promise.resolve(undefined as unknown as { success: boolean })],
    [
      'returns a non-boolean verdict',
      () => Promise.resolve({ success: 'yes' } as unknown as { success: boolean }),
    ],
  ])('fails closed when the limiter %s', async (_name, limit) => {
    const h = setup({ limit });
    const sent = await send(h);
    expectError(sent, 'UPSTREAM_FAILED');
    expect(sent.log.counted).toBe(false);
    expect(h.reserveCalls).toEqual([]);
    expect(h.upstreamCalls).toEqual([]);
  });
});

// ---- quota ---------------------------------------------------------------

describe('handleChat: quota', () => {
  const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ['lifetime requests', { AI_LIFETIME_CAP: '1' }],
    ['lifetime tokens', { AI_LIFETIME_TOKEN_CAP: '10' }],
    ['daily requests', { AI_DAILY_CAP: '1' }],
    ['daily tokens', { AI_DAILY_TOKEN_CAP: '10' }],
    ['the visitor cap', { AI_VISITOR_DAILY_CAP: '1' }],
  ];

  it.each(cases)(
    'answers DAILY_CAP with Retry-After to midnight when %s is reached',
    async (_name, limits) => {
      const h = setup({ time: BEFORE_MIDNIGHT });
      const env = { ...BASE_ENV, ...limits };
      expect((await send(h, chatRequest(), env)).response.status).toBe(200);
      const denied = await send(h, chatRequest(), env);
      expectError(denied, 'DAILY_CAP', { retryAfter: '30' });
      expect(denied.log).toMatchObject({ provider: 'none', kind: 'none', counted: false });
      // Only the first request reached the provider; the denied one did not.
      expect(h.upstreamCalls).toHaveLength(1);
    },
  );

  it('sends the limits from the configuration, with the visitor key and the UTC date', async () => {
    const h = setup();
    const env = {
      ...BASE_ENV,
      AI_VISITOR_DAILY_CAP: '7',
      AI_DAILY_CAP: '8',
      AI_DAILY_TOKEN_CAP: '9',
      AI_LIFETIME_CAP: '10',
      AI_LIFETIME_TOKEN_CAP: '11',
    };
    await send(h, chatRequest(), env);
    expect(h.reserveCalls).toEqual([
      {
        visitorKey: await visitorKey(IP, SALT, '2026-11-15'),
        date: '2026-11-15',
        limits: { visitorDaily: 7, daily: 8, dailyTokens: 9, lifetime: 10, lifetimeTokens: 11 },
      },
    ]);
  });

  it('applies the visitor cap per visitor', async () => {
    const h = setup();
    const env = { ...BASE_ENV, AI_VISITOR_DAILY_CAP: '1' };
    const other = { 'cf-connecting-ip': '198.51.100.9' };
    expect((await send(h, chatRequest(), env)).response.status).toBe(200);
    expectError(await send(h, chatRequest(), env), 'DAILY_CAP', {
      retryAfter: String(12 * 60 * 60),
    });
    expect((await send(h, chatRequest({ headers: other }), env)).response.status).toBe(200);
  });

  it('allows requests again after the UTC day changes', async () => {
    const h = setup({ time: BEFORE_MIDNIGHT });
    const env = { ...BASE_ENV, AI_DAILY_CAP: '1' };
    expect((await send(h, chatRequest(), env)).response.status).toBe(200);
    expectError(await send(h, chatRequest(), env), 'DAILY_CAP', { retryAfter: '30' });
    h.clock.now += 31_000;
    expect((await send(h, chatRequest(), env)).response.status).toBe(200);
  });

  it('keeps the lifetime cap across days', async () => {
    const h = setup();
    const env = { ...BASE_ENV, AI_LIFETIME_CAP: '1' };
    expect((await send(h, chatRequest(), env)).response.status).toBe(200);
    h.clock.now += 3 * 24 * 60 * 60 * 1000;
    expect((await send(h, chatRequest(), env)).response.status).toBe(429);
  });

  it('counts the request once even when it fails over to a second provider', async () => {
    const h = setup({
      upstream: (_call, index) =>
        index === 0 ? jsonResponse({}, 503) : jsonResponse(upstreamReply()),
    });
    const env = { ...TWO_PROVIDERS, AI_DAILY_CAP: '2' };
    expect((await send(h, chatRequest(), env)).response.status).toBe(200);
    expect(h.reserveCalls).toHaveLength(1);
    expect(h.upstreamCalls).toHaveLength(2);
    // One request counted, so a second one still fits under the cap of 2.
    expect((await send(h, chatRequest(), env)).response.status).toBe(200);
    expectError(await send(h, chatRequest(), env), 'DAILY_CAP', {
      retryAfter: String(12 * 60 * 60),
    });
  });

  it.each([
    ['rejects', () => Promise.reject(new Error(`quota exploded ${OPENAI_KEY}`))],
    [
      'throws synchronously',
      () => {
        throw new Error('quota exploded');
      },
    ],
    ['returns nothing', () => Promise.resolve(undefined as never)],
    ['returns a malformed result', () => Promise.resolve({ ok: 'maybe' } as never)],
  ])('fails closed when the quota %s', async (_name, reserve) => {
    const h = setup({ quota: { reserve } });
    const sent = await send(h);
    expectError(sent, 'UPSTREAM_FAILED');
    expect(sent.log.counted).toBe(false);
    expect(h.upstreamCalls).toEqual([]);
  });

  it('answers UPSTREAM_FAILED, not DAILY_CAP, for invalid-input', async () => {
    const h = setup({
      quota: { reserve: () => Promise.resolve({ ok: false, reason: 'invalid-input' }) },
    });
    const sent = await send(h);
    expectError(sent, 'UPSTREAM_FAILED');
    expect(sent.log.counted).toBe(false);
    expect(h.upstreamCalls).toEqual([]);
  });

  it.each(['lifetime', 'lifetime-tokens', 'daily', 'daily-tokens', 'visitor'] as const)(
    'maps the denial reason %s to DAILY_CAP',
    async (reason) => {
      const h = setup({ quota: { reserve: () => Promise.resolve({ ok: false, reason }) } });
      const sent = await send(h);
      expectError(sent, 'DAILY_CAP', { retryAfter: String(12 * 60 * 60) });
      expect(h.upstreamCalls).toEqual([]);
    },
  );

  it('does not call the quota before the limiter allowed the request', async () => {
    const order: string[] = [];
    const h = setup({
      limit: () => {
        order.push('limiter');
        return Promise.resolve({ success: true });
      },
      quota: {
        reserve: () => {
          order.push('reserve');
          return Promise.resolve({ ok: true });
        },
      },
    });
    await send(h);
    expect(order).toEqual(['limiter', 'reserve']);
  });
});

// ---- providers -----------------------------------------------------------

describe('handleChat: providers', () => {
  it('sends the adapted request to Sarvam with its key and fixed URL', async () => {
    const h = setup();
    await send(h, chatRequest({ json: { ...validBody(), temperature: 1.7, max_tokens: 99_999 } }), {
      ...BASE_ENV,
      AI_MAX_OUTPUT_TOKENS: '512',
    });
    const call = h.upstreamCalls[0];
    expect(call?.url).toBe('https://api.sarvam.ai/v2/chat/completions');
    expect(call?.headers.get('authorization')).toBe(`Bearer ${SARVAM_KEY}`);
    expect(call?.headers.get('api-subscription-key')).toBe(SARVAM_KEY);
    expect(call?.body).toEqual({
      model: 'sarvam-model',
      messages: [{ role: 'user', content: PROMPT_TEXT }],
      stream: false,
      max_tokens: 512,
      temperature: 1,
    });
  });

  it('fails over to the second provider after a retryable failure, with its own adaptation', async () => {
    const h = setup({
      upstream: (_call, index) =>
        index === 0 ? jsonResponse({}, 429) : jsonResponse(upstreamReply()),
    });
    const sent = await send(
      h,
      chatRequest({ json: { ...validBody(), temperature: 0.5, max_tokens: 300 } }),
      { ...TWO_PROVIDERS, AI_REASONING_EFFORT: 'low' },
    );
    expect(sent.response.status).toBe(200);
    expect(h.upstreamCalls).toHaveLength(2);
    const [first, second] = h.upstreamCalls;
    expect(first?.url).toBe('https://api.sarvam.ai/v2/chat/completions');
    expect(first?.body).toMatchObject({ max_tokens: 300, temperature: 0.5 });
    expect(first?.body).not.toHaveProperty('max_completion_tokens');
    expect(second?.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(second?.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`);
    expect(second?.headers.get('api-subscription-key')).toBeNull();
    expect(second?.body).toMatchObject({
      model: 'openai-model',
      max_completion_tokens: 300,
      reasoning_effort: 'low',
      stream: false,
    });
    expect(second?.body).not.toHaveProperty('max_tokens');
    expect(second?.body).not.toHaveProperty('temperature');
    // The key of the failed provider is never sent to the other one.
    expect(JSON.stringify([...(second?.headers ?? [])])).not.toContain(SARVAM_KEY);
    expect(sent.log).toMatchObject({ provider: 'openai', kind: 'ok', counted: true });
  });

  it.each([
    ['429', () => jsonResponse({}, 429)],
    ['500', () => jsonResponse({}, 500)],
    ['503', () => jsonResponse({}, 503)],
    ['an unreadable reply', () => new Response('<html>oops</html>', { status: 200 })],
    ['a reply of the wrong shape', () => jsonResponse({ choices: [] })],
    [
      'a network error',
      () => {
        throw new TypeError('network down');
      },
    ],
  ])('fails over after %s', async (_name, failing) => {
    const h = setup({
      upstream: (call, index) => (index === 0 ? failing() : respondOk(call, index)),
    });
    const sent = await send(h, chatRequest(), TWO_PROVIDERS);
    expect(sent.response.status).toBe(200);
    expect(h.upstreamCalls).toHaveLength(2);
  });

  it.each([400, 401, 403, 404])('does not fail over after a %i', async (status) => {
    const h = setup({
      upstream: (call, index) =>
        index === 0 ? jsonResponse({ error: PROMPT_TEXT }, status) : respondOk(call, index),
    });
    const sent = await send(h, chatRequest(), TWO_PROVIDERS);
    expectError(sent, 'UPSTREAM_FAILED');
    expect(h.upstreamCalls).toHaveLength(1);
    expect(sent.log).toMatchObject({
      provider: 'sarvam',
      kind: 'http-4xx',
      counted: true,
    });
    expect(h.addTokensCalls).toEqual([]);
  });

  it('answers UPSTREAM_FAILED when every provider fails, after trying each once', async () => {
    const h = setup({ upstream: () => jsonResponse({ error: 'down' }, 500) });
    const sent = await send(h, chatRequest(), TWO_PROVIDERS);
    expectError(sent, 'UPSTREAM_FAILED');
    expect(h.upstreamCalls).toHaveLength(2);
    expect(sent.log).toMatchObject({ provider: 'openai', kind: 'http-5xx', counted: true });
    expect(h.addTokensCalls).toEqual([]);
  });

  it('answers UPSTREAM_FAILED with one call when the only provider fails', async () => {
    const h = setup({ upstream: () => jsonResponse({}, 500) });
    const sent = await send(h);
    expectError(sent, 'UPSTREAM_FAILED');
    expect(h.upstreamCalls).toHaveLength(1);
  });

  it('never returns upstream text or the key, even when the upstream echoes them', async () => {
    const h = setup({
      upstream: () =>
        new Response(`${SARVAM_KEY} ${PROMPT_TEXT}`, {
          status: 500,
          statusText: SARVAM_KEY,
          headers: { 'x-leak': SARVAM_KEY },
        }),
    });
    const sent = await send(h);
    expectError(sent, 'UPSTREAM_FAILED');
    expect(sent.text).not.toContain(PROMPT_TEXT);
  });

  it('forwards tools and tool_choice as validated', async () => {
    const h = setup();
    const tools = [
      {
        type: 'function',
        function: { name: 'create_card', description: 'd', parameters: { type: 'object' } },
      },
    ];
    await send(h, chatRequest({ json: { ...validBody(), tools, tool_choice: 'auto' } }));
    expect(h.upstreamCalls[0]?.body).toMatchObject({ tools, tool_choice: 'auto' });
  });
});

// ---- success -------------------------------------------------------------

describe('handleChat: success', () => {
  it('answers 200 with exactly the public reply shape', async () => {
    const h = setup();
    const sent = await send(h);
    expect(sent.response.status).toBe(200);
    expect(sent.response.headers.get('content-type')).toBe('application/json');
    expect(sent.response.headers.get('cache-control')).toBe('no-store');
    expect(sent.response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(sent.response.headers.get('retry-after')).toBeNull();
    const body: unknown = JSON.parse(sent.text);
    expect(PublicReplySchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      choices: [{ message: { role: 'assistant', content: REPLY_TEXT }, finish_reason: 'stop' }],
    });
    // Nothing from the upstream's other fields.
    for (const hidden of ['usage', 'chatcmpl', 'fp-secret', 'hidden thoughts', 'total_tokens']) {
      expect(sent.text).not.toContain(hidden);
    }
  });

  it('returns tool calls and fills a missing call id', async () => {
    const h = setup({
      upstream: () =>
        jsonResponse({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { type: 'function', function: { name: 'create_card', arguments: '{"a":1}' } },
                  { id: 'x1', type: 'function', function: { name: 'link_cards', arguments: '{}' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
    });
    const sent = await send(h);
    expect(JSON.parse(sent.text)).toEqual({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call-0',
                type: 'function',
                function: { name: 'create_card', arguments: '{"a":1}' },
              },
              { id: 'x1', type: 'function', function: { name: 'link_cards', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
  });

  it('adds the reported tokens to the quota after the reply, with the current UTC date', async () => {
    const h = setup({ upstream: () => jsonResponse(upstreamReply(REPLY_TEXT, 321)) });
    await send(h);
    expect(h.addTokensCalls).toEqual([
      { visitorKey: await visitorKey(IP, SALT, '2026-11-15'), date: '2026-11-15', tokens: 321 },
    ]);
  });

  it('adds an estimate when the reply carries no usage', async () => {
    const reply = { choices: [{ message: { content: 'abcdef' }, finish_reason: 'stop' }] };
    const h = setup({ upstream: () => jsonResponse(reply) });
    await send(h);
    expect(h.addTokensCalls).toHaveLength(1);
    const tokens = h.addTokensCalls[0]?.tokens ?? 0;
    expect(Number.isInteger(tokens)).toBe(true);
    expect(tokens).toBeGreaterThan(2);
  });

  it('counts tokens on the day the reply arrived when the request crossed midnight', async () => {
    const h = setup({ time: BEFORE_MIDNIGHT, upstreamMs: 31_000 });
    await send(h);
    expect(h.reserveCalls[0]?.date).toBe('2026-11-15');
    expect(h.addTokensCalls[0]?.date).toBe('2026-11-16');
  });

  it('counts the tokens, so the next reservation is denied at the token cap', async () => {
    const h = setup({ upstream: () => jsonResponse(upstreamReply(REPLY_TEXT, 500)) });
    const env = { ...BASE_ENV, AI_DAILY_TOKEN_CAP: '500' };
    expect((await send(h, chatRequest(), env)).response.status).toBe(200);
    expectError(await send(h, chatRequest(), env), 'DAILY_CAP', {
      retryAfter: String(12 * 60 * 60),
    });
  });

  it.each([
    ['rejects', () => Promise.reject(new Error(`store down ${SARVAM_KEY}`))],
    [
      'throws synchronously',
      () => {
        throw new Error('store down');
      },
    ],
  ])('still answers 200 when addTokens %s', async (_name, addTokens) => {
    const h = setup({ quota: { addTokens } });
    const sent = await send(h);
    expect(sent.response.status).toBe(200);
    expect(sent.log).toMatchObject({ code: 'ok', status: 200, counted: true });
    expect(h.addTokensCalls).toHaveLength(1);
  });

  it('still answers 200 when the clock fails during token accounting', async () => {
    let calls = 0;
    const h = setup();
    const deps: Deps = {
      ...h.deps,
      // Works for the start, the date and the reserve; fails when the tokens are counted.
      now: () => {
        calls += 1;
        if (calls === 3) throw new Error('clock failed');
        return NOON;
      },
    };
    const response = await handleChat(chatRequest(), { ...BASE_ENV }, deps);
    expect(response.status).toBe(200);
  });

  it('logs an empty reply cut off by the token limit as kind empty-length', async () => {
    const reply = { choices: [{ message: { content: '' }, finish_reason: 'length' }] };
    const h = setup({ upstream: () => jsonResponse(reply) });
    const sent = await send(h);
    expect(sent.response.status).toBe(200);
    expect(sent.log).toMatchObject({ code: 'ok', provider: 'sarvam', kind: 'empty-length' });
  });
});

// ---- log line ------------------------------------------------------------

describe('handleChat: log line', () => {
  it('writes exactly the fields of the log entry for a success, with the elapsed time', async () => {
    const h = setup({ upstreamMs: 250 });
    const sent = await send(h);
    expect(sent.log).toEqual({
      route: 'chat',
      status: 200,
      code: 'ok',
      provider: 'sarvam',
      kind: 'ok',
      ms: 250,
      counted: true,
    });
    expect(Object.keys(sent.log).sort()).toEqual(
      ['code', 'counted', 'kind', 'ms', 'provider', 'route', 'status'].sort(),
    );
  });

  it('contains no prompt or reply text, and no IP address', async () => {
    const h = setup();
    const sent = await send(h);
    const line = JSON.stringify(sent.log);
    for (const text of [PROMPT_TEXT, REPLY_TEXT, IP, ORIGIN, SALT, SARVAM_KEY]) {
      expect(line).not.toContain(text);
    }
  });

  it.each([
    ['origin', () => chatRequest({ headers: { origin: 'https://evil.example' } }), false],
    ['validation', () => chatRequest({ raw: '{' }), false],
  ])('has counted false when the request fails at %s', async (_name, build, counted) => {
    const sent = await send(setup(), build());
    expect(sent.log.counted).toBe(counted);
    expect(sent.log).toMatchObject({ route: 'chat', provider: 'none', kind: 'none' });
  });

  it('has counted true when the upstream fails after the reservation', async () => {
    const h = setup({ upstream: () => jsonResponse({}, 500) });
    expect((await send(h)).log.counted).toBe(true);
  });

  it('logs the same status and code as the answer for every error code the route can give', async () => {
    const seen = new Set<string>();
    const scenarios: ReadonlyArray<() => Promise<Sent>> = [
      () => send(setup(), chatRequest(), { ...BASE_ENV, AI_ENABLED: 'false' }),
      () => send(setup(), chatRequest({ headers: { origin: null } })),
      () => send(setup(), chatRequest({ raw: '{' })),
      () => send(setup(), chatRequest({ raw: 'x'.repeat(AI_WIRE_LIMITS.maxBodyBytes + 1) })),
      () => send(setup(), chatRequest({ json: { ...validBody(), model: 'nope' } })),
      () => send(setup({ limit: () => Promise.resolve({ success: false }) })),
      () =>
        send(setup({ quota: { reserve: () => Promise.resolve({ ok: false, reason: 'daily' }) } })),
      () => send(setup({ upstream: () => jsonResponse({}, 500) })),
    ];
    for (const run of scenarios) {
      const sent = await run();
      seen.add(sent.log.code);
      expect(sent.log.status).toBe(sent.response.status);
      expect(sent.log.code).toBe(JSON.parse(sent.text).error.code);
    }
    // INTERNAL is covered by its own tests below.
    expect([...seen].sort()).toEqual(ERROR_CODES.filter((code) => code !== 'INTERNAL').sort());
  });

  it('does not change the answer when the log writer throws', async () => {
    const h = setup({
      log: () => {
        throw new Error('log sink down');
      },
    });
    const response = await handleChat(chatRequest(), { ...BASE_ENV }, h.deps);
    expect(response.status).toBe(200);
    expect(h.logs).toHaveLength(1);
  });
});

// ---- INTERNAL ------------------------------------------------------------

describe('handleChat: unexpected exceptions', () => {
  it('answers INTERNAL when the configuration source throws, and logs it once', async () => {
    const h = setup();
    const env: Record<string, unknown> = { ...BASE_ENV };
    Object.defineProperty(env, 'AI_ALLOWED_ORIGINS', {
      enumerable: true,
      get() {
        throw new Error(`env exploded ${SARVAM_KEY}`);
      },
    });
    const response = await handleChat(chatRequest(), env, h.deps);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL' } });
    expect(text).not.toContain('exploded');
    expect(h.logs).toEqual([
      {
        route: 'chat',
        status: 500,
        code: 'INTERNAL',
        provider: 'none',
        kind: 'none',
        ms: 0,
        counted: false,
      },
    ]);
    expectUntouched(h);
  });

  it('answers INTERNAL when the clock fails after validation', async () => {
    const h = setup();
    let calls = 0;
    const deps: Deps = {
      ...h.deps,
      // The first call is the start time of the log, the second is the date of the request.
      now: () => {
        calls += 1;
        if (calls === 2) throw new Error(`clock exploded ${SALT}`);
        return NOON;
      },
    };
    const response = await handleChat(chatRequest(), { ...BASE_ENV }, deps);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL' } });
    expect(text).not.toContain('exploded');
    expect(h.logs).toHaveLength(1);
    expect(h.logs[0]).toMatchObject({ status: 500, code: 'INTERNAL', counted: false });
    expectUntouched(h);
  });

  it('marks the request as counted when the exception happens after the reservation', async () => {
    const h = setup();
    const deps: Deps = {
      ...h.deps,
      // Not a failure the route handles on purpose: the provider loop reads the timers.
      setTimeout: () => {
        throw new Error('timers broken');
      },
    };
    const response = await handleChat(chatRequest(), { ...BASE_ENV }, deps);
    expect(response.status).toBe(500);
    expect(h.logs[0]).toMatchObject({ code: 'INTERNAL', counted: true });
    expect(h.upstreamCalls).toEqual([]);
  });

  it('does not treat a fetch that throws as INTERNAL: it is a network failure', async () => {
    const h = setup({
      upstream: () => {
        throw new TypeError('network down');
      },
    });
    const sent = await send(h);
    expectError(sent, 'UPSTREAM_FAILED');
    expect(sent.log.kind).toBe('network');
  });
});

// ---- deadlines -----------------------------------------------------------

describe('handleChat: deadlines', () => {
  it('gives each upstream call 25 s and the whole loop 55 s by default', async () => {
    const h = setup({ timers: true });
    await send(h);
    expect(h.timers.timers.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([
      25_000, 55_000,
    ]);
    expect(h.timers.timers.every((timer) => timer.cleared)).toBe(true);
  });

  it('uses the injected timeouts', async () => {
    const h = setup({ timers: true });
    h.deps.upstreamTimeoutMs = 1_000;
    h.deps.totalTimeoutMs = 2_000;
    await send(h);
    expect(h.timers.timers.map((timer) => timer.ms).sort((a, b) => a - b)).toEqual([1_000, 2_000]);
  });

  it('stops at the whole-request deadline without trying the next provider', async () => {
    const h = setup({ upstream: hang, timers: true });
    const pending = send(h, chatRequest(), TWO_PROVIDERS);
    await vi.waitFor(() => expect(h.upstreamCalls).toHaveLength(1));
    const total = h.timers.timers.find((timer) => timer.ms === 55_000);
    expect(total).toBeDefined();
    total?.handler();
    const sent = await pending;
    expectError(sent, 'UPSTREAM_FAILED');
    expect(h.upstreamCalls).toHaveLength(1);
    expect(h.upstreamCalls[0]?.signal?.aborted).toBe(true);
    expect(sent.log).toMatchObject({ provider: 'sarvam', kind: 'aborted', counted: true });
    expect(h.timers.timers.every((timer) => timer.cleared)).toBe(true);
  });

  it('fails over to the next provider when one call times out', async () => {
    const h = setup({
      upstream: (call, index) => (index === 0 ? hang(call, index) : respondOk(call, index)),
      timers: true,
    });
    const pending = send(h, chatRequest(), TWO_PROVIDERS);
    await vi.waitFor(() => expect(h.upstreamCalls).toHaveLength(1));
    h.timers.timers.find((timer) => timer.ms === 25_000 && !timer.cleared)?.handler();
    const sent = await pending;
    expect(sent.response.status).toBe(200);
    expect(h.upstreamCalls).toHaveLength(2);
    expect(sent.log).toMatchObject({ provider: 'openai', kind: 'ok' });
  });

  it('works with the global timers when none are injected', async () => {
    const h = setup();
    const sent = await send(h);
    expect(sent.response.status).toBe(200);
  });
});

// ---- defaultDeps ---------------------------------------------------------

describe('defaultDeps', () => {
  function fakeEnv() {
    const limited: { key: string }[] = [];
    const stubCalls: string[] = [];
    const env = {
      AI_BURST: {
        limit: (args: { key: string }) => {
          limited.push(args);
          return Promise.resolve({ success: true });
        },
      },
      QUOTA: {
        idFromName: (name: string) => {
          stubCalls.push(`idFromName:${name}`);
          return name;
        },
        get: () => ({
          reserve: () => {
            stubCalls.push('reserve');
            return Promise.resolve({ ok: true });
          },
          addTokens: () => Promise.resolve(),
          snapshot: () => Promise.resolve({}),
        }),
      },
    } as unknown as Env;
    return { env, limited, stubCalls };
  }

  it('reads the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
    expect(defaultDeps(fakeEnv().env).now()).toBe(NOON);
  });

  it('wires the limiter to the AI_BURST binding', async () => {
    const { env, limited } = fakeEnv();
    await expect(defaultDeps(env).limiter.limit({ key: 'chat:abc' })).resolves.toEqual({
      success: true,
    });
    expect(limited).toEqual([{ key: 'chat:abc' }]);
  });

  it('wires the quota to the global Durable Object', async () => {
    const { env, stubCalls } = fakeEnv();
    const result = await defaultDeps(env).quota.reserve({
      visitorKey: 'a',
      date: '2026-11-15',
      limits: { visitorDaily: 1, daily: 1, dailyTokens: 1, lifetime: 1, lifetimeTokens: 1 },
    });
    expect(result).toEqual({ ok: true });
    expect(stubCalls).toEqual(['idFromName:global', 'reserve']);
  });

  it('calls the global fetch at call time, with its arguments', async () => {
    const fake = vi.fn(() => Promise.resolve(new Response('ok')));
    vi.stubGlobal('fetch', fake);
    const deps = defaultDeps(fakeEnv().env);
    await deps.fetch('https://example.invalid/', { method: 'POST' });
    expect(fake).toHaveBeenCalledWith('https://example.invalid/', { method: 'POST' });
  });

  it('writes one JSON line to the console', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    defaultDeps(fakeEnv().env).log({
      route: 'chat',
      status: 200,
      code: 'ok',
      provider: 'none',
      kind: 'none',
      ms: 1,
      counted: false,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toMatchObject({
      route: 'chat',
      status: 200,
    });
  });
});

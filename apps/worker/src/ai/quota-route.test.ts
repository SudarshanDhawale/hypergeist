import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES, ERROR_STATUS } from '../lib/errors';
import type { LogEntry } from '../lib/log';
import { utcDate } from '../lib/time';
import { visitorKey } from '../lib/visitor';
import type { Deps, Limiter } from './deps';
import { handleQuota } from './quota-route';
import { createMemoryQuotaClient, type QuotaClient } from './quota-client';
import { createMemoryKv } from './quota-logic';

const ORIGIN = 'https://hypergeist.example';
const IP = '203.0.113.7';
const SALT = 'test-secret-salt-0000';
const SARVAM_KEY = 'test-secret-sarvam-0000';
const OPENAI_KEY = 'test-secret-openai-0000';
const SECRETS = [SALT, SARVAM_KEY, OPENAI_KEY];

const NOON = Date.UTC(2026, 10, 15, 12, 0, 0);

const ENV: Record<string, unknown> = {
  AI_ALLOWED_ORIGINS: ORIGIN,
  AI_PROVIDERS: 'sarvam,openai',
  AI_SARVAM_MODEL: 'sarvam-test-model',
  AI_OPENAI_MODEL: 'openai-test-model',
  SARVAM_API_KEY: SARVAM_KEY,
  OPENAI_API_KEY: OPENAI_KEY,
  QUOTA_SALT: SALT,
  AI_VISITOR_DAILY_CAP: '5',
  AI_DAILY_CAP: '20',
  AI_DAILY_TOKEN_CAP: '1000000',
  AI_LIFETIME_CAP: '100',
  AI_LIFETIME_TOKEN_CAP: '6000000',
};

const LIMITS = {
  visitorDaily: 5,
  daily: 20,
  dailyTokens: 1_000_000,
  lifetime: 100,
  lifetimeTokens: 6_000_000,
};

type Harness = {
  deps: Deps;
  quota: QuotaClient;
  reserve: ReturnType<typeof vi.fn>;
  addTokens: ReturnType<typeof vi.fn>;
  snapshot: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
  logs: LogEntry[];
  fetch: ReturnType<typeof vi.fn>;
};

function harness(
  options: {
    now?: number;
    limiter?: Limiter;
    quotaOverrides?: Partial<QuotaClient>;
    log?: (entry: LogEntry) => void;
  } = {},
): Harness {
  const quota = createMemoryQuotaClient(createMemoryKv());
  const reserve = vi.fn(quota.reserve);
  const addTokens = vi.fn(quota.addTokens);
  const snapshot = vi.fn(quota.snapshot);
  const limit = vi.fn(() => Promise.resolve({ success: true }));
  const fetchFake = vi.fn(() => Promise.reject(new Error('the quota route must not use fetch')));
  const logs: LogEntry[] = [];
  const deps: Deps = {
    now: () => options.now ?? NOON,
    fetch: fetchFake as unknown as typeof fetch,
    limiter: options.limiter ?? { limit },
    quota: { reserve, addTokens, snapshot, ...options.quotaOverrides },
    log: options.log ?? ((entry) => logs.push(entry)),
  };
  return { deps, quota, reserve, addTokens, snapshot, limit, logs, fetch: fetchFake };
}

function quotaRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://hypergeist.example/api/ai/quota', {
    method: 'GET',
    headers: { origin: ORIGIN, 'cf-connecting-ip': IP, ...headers },
  });
}

async function errorCode(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  return (body as { error: { code: unknown } }).error.code;
}

function expectNoSecrets(text: string): void {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
}

async function myKey(now = NOON): Promise<string> {
  return visitorKey(IP, SALT, utcDate(now));
}

describe('handleQuota: success', () => {
  it('answers 200 with the five fields, zero used on a fresh store', async () => {
    const h = harness();
    const response = await handleQuota(quotaRequest(), ENV, h.deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      dailyLimit: 20,
      dailyUsed: 0,
      visitorLimit: 5,
      visitorUsed: 0,
      resetsAt: '2026-11-16T00:00:00.000Z',
    });
  });

  it('sets the JSON, no-store and nosniff headers', async () => {
    const response = await handleQuota(quotaRequest(), ENV, harness().deps);

    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('shows the numbers after chat-style reservations made through the quota client', async () => {
    const h = harness();
    const mine = await myKey();
    const other = await visitorKey('198.51.100.9', SALT, utcDate(NOON));
    const date = utcDate(NOON);
    for (let i = 0; i < 3; i += 1) {
      expect(await h.quota.reserve({ visitorKey: mine, date, limits: LIMITS })).toEqual({
        ok: true,
      });
      await h.quota.addTokens({ visitorKey: mine, date, tokens: 12_345 });
    }
    for (let i = 0; i < 4; i += 1) {
      await h.quota.reserve({ visitorKey: other, date, limits: LIMITS });
    }
    h.reserve.mockClear();

    const response = await handleQuota(quotaRequest(), ENV, h.deps);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      dailyLimit: 20,
      dailyUsed: 7,
      visitorLimit: 5,
      visitorUsed: 3,
    });
  });

  it('reads the visitor row of the caller: another IP sees its own count', async () => {
    const h = harness();
    const date = utcDate(NOON);
    await h.quota.reserve({ visitorKey: await myKey(), date, limits: LIMITS });
    await h.quota.reserve({ visitorKey: await myKey(), date, limits: LIMITS });

    const mine = (await (await handleQuota(quotaRequest(), ENV, h.deps)).json()) as {
      visitorUsed: number;
    };
    const theirs = (await (
      await handleQuota(quotaRequest({ 'cf-connecting-ip': '198.51.100.9' }), ENV, h.deps)
    ).json()) as { visitorUsed: number; dailyUsed: number };

    expect(mine.visitorUsed).toBe(2);
    expect(theirs.visitorUsed).toBe(0);
    expect(theirs.dailyUsed).toBe(2);
  });

  it('passes the configured limits, the UTC date and the visitor key to snapshot', async () => {
    const h = harness();
    await handleQuota(quotaRequest(), ENV, h.deps);

    expect(h.snapshot).toHaveBeenCalledTimes(1);
    expect(h.snapshot).toHaveBeenCalledWith({
      visitorKey: await myKey(),
      date: '2026-11-15',
      limits: LIMITS,
    });
  });

  it('never calls reserve or addTokens, and never the network', async () => {
    const h = harness();
    await handleQuota(quotaRequest(), ENV, h.deps);
    await handleQuota(quotaRequest(), ENV, h.deps);

    expect(h.reserve).not.toHaveBeenCalled();
    expect(h.addTokens).not.toHaveBeenCalled();
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('does not change the counters: repeated calls give the same numbers', async () => {
    const h = harness();
    await h.quota.reserve({ visitorKey: await myKey(), date: utcDate(NOON), limits: LIMITS });

    const first = await (await handleQuota(quotaRequest(), ENV, h.deps)).json();
    const second = await (await handleQuota(quotaRequest(), ENV, h.deps)).json();

    expect(second).toEqual(first);
    expect(first).toMatchObject({ dailyUsed: 1, visitorUsed: 1 });
  });

  it('answers with exactly five keys: no token counts, no provider names', async () => {
    const h = harness();
    const date = utcDate(NOON);
    await h.quota.reserve({ visitorKey: await myKey(), date, limits: LIMITS });
    await h.quota.addTokens({ visitorKey: await myKey(), date, tokens: 987_654 });

    const response = await handleQuota(quotaRequest(), ENV, h.deps);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;

    expect(Object.keys(body).sort()).toEqual([
      'dailyLimit',
      'dailyUsed',
      'resetsAt',
      'visitorLimit',
      'visitorUsed',
    ]);
    expect(text).not.toContain('987654');
    expect(text).not.toContain('1000000');
    expect(text).not.toMatch(/sarvam|openai|token|provider|model/i);
    expectNoSecrets(text);
  });

  it('picks the five fields even when the store returns extra ones', async () => {
    const h = harness({
      quotaOverrides: {
        snapshot: () =>
          Promise.resolve({
            dailyLimit: 20,
            dailyUsed: 1,
            visitorLimit: 5,
            visitorUsed: 1,
            dailyTokens: 777,
            provider: 'sarvam',
          } as never),
      },
    });
    const body = (await (await handleQuota(quotaRequest(), ENV, h.deps)).json()) as Record<
      string,
      unknown
    >;

    expect(Object.keys(body).sort()).toEqual([
      'dailyLimit',
      'dailyUsed',
      'resetsAt',
      'visitorLimit',
      'visitorUsed',
    ]);
  });
});

describe('handleQuota: resetsAt', () => {
  const cases: ReadonlyArray<readonly [string, number, string]> = [
    ['one millisecond before midnight', Date.UTC(2026, 10, 15, 23, 59, 59, 999), '2026-11-16'],
    ['exactly at midnight', Date.UTC(2026, 10, 16, 0, 0, 0, 0), '2026-11-17'],
    ['one millisecond after midnight', Date.UTC(2026, 10, 16, 0, 0, 0, 1), '2026-11-17'],
    ['the last day of a month', Date.UTC(2026, 10, 30, 8, 0, 0), '2026-12-01'],
    ['the last day of a year', Date.UTC(2026, 11, 31, 23, 0, 0), '2027-01-01'],
  ];

  it.each(cases)('is the next UTC midnight: %s', async (_name, now, nextDate) => {
    const h = harness({ now });
    const body = (await (await handleQuota(quotaRequest(), ENV, h.deps)).json()) as {
      resetsAt: string;
    };

    expect(body.resetsAt).toBe(`${nextDate}T00:00:00.000Z`);
  });

  it('uses the UTC date of now for the snapshot, so a new day shows zero used', async () => {
    const h = harness({ now: Date.UTC(2026, 10, 15, 23, 59, 59, 999) });
    const keyDay1 = await myKey(Date.UTC(2026, 10, 15, 23, 59, 59, 999));
    await h.quota.reserve({ visitorKey: keyDay1, date: '2026-11-15', limits: LIMITS });

    const before = (await (await handleQuota(quotaRequest(), ENV, h.deps)).json()) as {
      dailyUsed: number;
    };
    const after = (await (
      await handleQuota(quotaRequest(), ENV, {
        ...h.deps,
        now: () => Date.UTC(2026, 10, 16, 0, 0, 0, 0),
      })
    ).json()) as { dailyUsed: number; resetsAt: string };

    expect(before.dailyUsed).toBe(1);
    expect(after.dailyUsed).toBe(0);
    expect(after.resetsAt).toBe('2026-11-17T00:00:00.000Z');
  });
});

describe('handleQuota: denials', () => {
  it('answers FORBIDDEN_ORIGIN for a missing, wrong or cross-site origin', async () => {
    const h = harness();
    const noOrigin = new Request('https://hypergeist.example/api/ai/quota', {
      headers: { 'cf-connecting-ip': IP },
    });
    const wrong = quotaRequest({ origin: 'https://evil.example' });
    const crossSite = quotaRequest({ 'sec-fetch-site': 'cross-site' });

    for (const request of [noOrigin, wrong, crossSite]) {
      const response = await handleQuota(request, ENV, h.deps);
      expect(response.status).toBe(403);
      expect(await errorCode(response)).toBe('FORBIDDEN_ORIGIN');
    }
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('answers 200 to a GET without Origin and with Sec-Fetch-Site: same-origin', async () => {
    // This is what a browser sends for a same-origin GET.
    const h = harness();
    const request = new Request('https://hypergeist.example/api/ai/quota', {
      method: 'GET',
      headers: { 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': IP },
    });
    const response = await handleQuota(request, ENV, h.deps);
    expect(response.status).toBe(200);
  });

  it('answers 200 to a HEAD without Origin and with Sec-Fetch-Site: same-origin', async () => {
    const h = harness();
    const request = new Request('https://hypergeist.example/api/ai/quota', {
      method: 'HEAD',
      headers: { 'sec-fetch-site': 'same-origin', 'cf-connecting-ip': IP },
    });
    const response = await handleQuota(request, ENV, h.deps);
    expect(response.status).toBe(200);
  });

  it('answers FORBIDDEN_ORIGIN for a cross-site GET without Origin', async () => {
    const h = harness();
    const request = new Request('https://hypergeist.example/api/ai/quota', {
      method: 'GET',
      headers: { 'sec-fetch-site': 'cross-site', 'cf-connecting-ip': IP },
    });
    const response = await handleQuota(request, ENV, h.deps);
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('FORBIDDEN_ORIGIN');
  });

  it('answers FORBIDDEN_ORIGIN for a wrong Origin even with Sec-Fetch-Site: same-origin', async () => {
    const h = harness();
    const response = await handleQuota(
      quotaRequest({ origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }),
      ENV,
      h.deps,
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe('FORBIDDEN_ORIGIN');
  });

  it('answers RATE_LIMITED with Retry-After 60 when the burst limiter says no', async () => {
    const limit = vi.fn(() => Promise.resolve({ success: false }));
    const h = harness({ limiter: { limit } });
    const response = await handleQuota(quotaRequest(), ENV, h.deps);

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(await response.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
    expect(h.snapshot).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled();
  });

  it('calls the limiter once with the key quota:<visitorKey>', async () => {
    const h = harness();
    await handleQuota(quotaRequest(), ENV, h.deps);

    expect(h.limit).toHaveBeenCalledTimes(1);
    expect(h.limit).toHaveBeenCalledWith({ key: `quota:${await myKey()}` });
  });

  it('answers UPSTREAM_FAILED when the limiter throws, without reading the quota', async () => {
    const limit = vi.fn(() => Promise.reject(new Error('limiter down test-secret-sarvam-0000')));
    const h = harness({ limiter: { limit } });
    const response = await handleQuota(quotaRequest(), ENV, h.deps);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: { code: 'UPSTREAM_FAILED' } });
    expect(text).not.toContain('limiter down');
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('answers UPSTREAM_FAILED when the limiter throws synchronously', async () => {
    const h = harness({
      limiter: {
        limit: () => {
          throw new Error('sync failure');
        },
      },
    });
    const response = await handleQuota(quotaRequest(), ENV, h.deps);

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('UPSTREAM_FAILED');
  });

  it('answers UPSTREAM_FAILED when snapshot rejects, with no error text in the body', async () => {
    const h = harness({
      quotaOverrides: {
        snapshot: () => Promise.reject(new Error('do unavailable test-secret-openai-0000')),
      },
    });
    const response = await handleQuota(quotaRequest(), ENV, h.deps);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: { code: 'UPSTREAM_FAILED' } });
    expectNoSecrets(text);
    expect(text).not.toContain('unavailable');
  });

  it('answers UPSTREAM_FAILED when snapshot throws synchronously', async () => {
    const h = harness({
      quotaOverrides: {
        snapshot: () => {
          throw new Error('sync snapshot failure');
        },
      },
    });
    const response = await handleQuota(quotaRequest(), ENV, h.deps);

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('UPSTREAM_FAILED');
  });
});

describe('handleQuota: configuration', () => {
  it('answers AI_DISABLED when the configuration is invalid', async () => {
    const h = harness();
    const broken = { ...ENV, QUOTA_SALT: undefined };
    const response = await handleQuota(quotaRequest(), broken, h.deps);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toEqual({ error: { code: 'AI_DISABLED' } });
    expectNoSecrets(text);
    expect(h.snapshot).not.toHaveBeenCalled();
  });

  it('answers AI_DISABLED for an empty environment', async () => {
    const response = await handleQuota(quotaRequest(), {}, harness().deps);

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('AI_DISABLED');
  });

  it('answers AI_DISABLED when the kill switch is off, even for a bad origin', async () => {
    const h = harness();
    const response = await handleQuota(
      quotaRequest({ origin: 'https://evil.example' }),
      { ...ENV, AI_ENABLED: 'false' },
      h.deps,
    );

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe('AI_DISABLED');
    expect(h.limit).not.toHaveBeenCalled();
    expect(h.snapshot).not.toHaveBeenCalled();
  });
});

describe('handleQuota: unexpected failures and logging', () => {
  it('answers INTERNAL when the clock throws, with a generic body', async () => {
    const h = harness();
    const deps: Deps = {
      ...h.deps,
      now: () => {
        throw new Error('clock exploded test-secret-salt-0000');
      },
    };
    const response = await handleQuota(quotaRequest(), ENV, deps);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ error: { code: 'INTERNAL' } });
    expectNoSecrets(text);
    expect(text).not.toContain('clock');
  });

  it('writes one log line on success: route quota, counted false, provider and kind none', async () => {
    const h = harness();
    await handleQuota(quotaRequest(), ENV, h.deps);

    expect(h.logs).toEqual([
      {
        route: 'quota',
        status: 200,
        code: 'ok',
        provider: 'none',
        kind: 'none',
        ms: 0,
        counted: false,
      },
    ]);
  });

  it('writes one log line per error code with its status', async () => {
    const cases: ReadonlyArray<{ code: string; run: () => Promise<Harness> }> = [
      {
        code: 'AI_DISABLED',
        run: async () => {
          const h = harness();
          await handleQuota(quotaRequest(), {}, h.deps);
          return h;
        },
      },
      {
        code: 'FORBIDDEN_ORIGIN',
        run: async () => {
          const h = harness();
          await handleQuota(quotaRequest({ origin: 'https://evil.example' }), ENV, h.deps);
          return h;
        },
      },
      {
        code: 'RATE_LIMITED',
        run: async () => {
          const h = harness({ limiter: { limit: () => Promise.resolve({ success: false }) } });
          await handleQuota(quotaRequest(), ENV, h.deps);
          return h;
        },
      },
      {
        code: 'UPSTREAM_FAILED',
        run: async () => {
          const h = harness({
            quotaOverrides: { snapshot: () => Promise.reject(new Error('down')) },
          });
          await handleQuota(quotaRequest(), ENV, h.deps);
          return h;
        },
      },
    ];

    for (const { code, run } of cases) {
      const h = await run();
      expect(h.logs).toHaveLength(1);
      const entry = h.logs[0];
      expect(entry).toMatchObject({
        route: 'quota',
        code,
        status: ERROR_STATUS[code as (typeof ERROR_CODES)[number]],
        provider: 'none',
        kind: 'none',
        counted: false,
      });
    }
  });

  it('log lines hold no secret, IP or origin', async () => {
    const h = harness();
    await handleQuota(quotaRequest(), ENV, h.deps);
    await handleQuota(quotaRequest({ origin: 'https://evil.example' }), ENV, h.deps);
    const text = JSON.stringify(h.logs);

    expectNoSecrets(text);
    expect(text).not.toContain(IP);
    expect(text).not.toContain('evil.example');
  });

  it('still answers when the log function throws', async () => {
    const h = harness({
      log: () => {
        throw new Error('log sink failed');
      },
    });
    const response = await handleQuota(quotaRequest(), ENV, h.deps);

    expect(response.status).toBe(200);
  });
});

import { describe, expect, it } from 'vitest';
import {
  createMemoryQuotaClient,
  createQuotaClient,
  QUOTA_OBJECT_NAME,
  type AddTokensArgs,
  type ReserveArgs,
  type SnapshotArgs,
} from './quota-client';
import { createMemoryKv, type Limits } from './quota-logic';
import type { QuotaStore } from './quota-store';

const DATE = '2026-11-15';
const LIMITS: Limits = {
  visitorDaily: 2,
  daily: 3,
  dailyTokens: 100,
  lifetime: 4,
  lifetimeTokens: 1000,
};
const RESERVE: ReserveArgs = { visitorKey: 'visitor-a', date: DATE, limits: LIMITS };

type Call = { method: string; args: unknown[] };

type FakeNamespace = {
  namespace: DurableObjectNamespace<QuotaStore>;
  names: string[];
  gets: unknown[];
  calls: Call[];
};

/** A stand-in for the Durable Object namespace. The stub methods record calls and return `reply`. */
function fakeNamespace(
  options: {
    reply?: Record<string, unknown>;
    fail?: Error;
    failLookup?: Error;
  } = {},
): FakeNamespace {
  const names: string[] = [];
  const gets: unknown[] = [];
  const calls: Call[] = [];
  const method =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ method: name, args });
      return options.fail === undefined
        ? Promise.resolve(options.reply?.[name])
        : Promise.reject(options.fail);
    };
  const fake = {
    idFromName(name: string) {
      if (options.failLookup !== undefined) throw options.failLookup;
      names.push(name);
      return { fakeId: name };
    },
    get(id: unknown) {
      gets.push(id);
      return {
        reserve: method('reserve'),
        addTokens: method('addTokens'),
        snapshot: method('snapshot'),
      };
    },
  };
  // The fake has only the two members the client uses.
  return { namespace: fake as unknown as DurableObjectNamespace<QuotaStore>, names, gets, calls };
}

describe('createQuotaClient', () => {
  it('uses the object named `global`', async () => {
    const fake = fakeNamespace({ reply: { reserve: { ok: true } } });
    await createQuotaClient(fake.namespace).reserve(RESERVE);
    expect(QUOTA_OBJECT_NAME).toBe('global');
    expect(fake.names).toEqual(['global']);
    expect(fake.gets).toEqual([{ fakeId: 'global' }]);
  });

  it('passes the arguments of reserve unchanged and returns the reply', async () => {
    const fake = fakeNamespace({ reply: { reserve: { ok: false, reason: 'daily' } } });
    const result = await createQuotaClient(fake.namespace).reserve(RESERVE);
    expect(result).toEqual({ ok: false, reason: 'daily' });
    expect(fake.calls).toEqual([{ method: 'reserve', args: [RESERVE] }]);
  });

  it('passes the arguments of addTokens unchanged and resolves to undefined', async () => {
    const fake = fakeNamespace();
    const args: AddTokensArgs = { visitorKey: 'visitor-a', date: DATE, tokens: 42 };
    await expect(createQuotaClient(fake.namespace).addTokens(args)).resolves.toBeUndefined();
    expect(fake.calls).toEqual([{ method: 'addTokens', args: [args] }]);
  });

  it('passes the arguments of snapshot unchanged and returns the reply', async () => {
    const snap = { dailyLimit: 3, dailyUsed: 1, visitorLimit: 2, visitorUsed: 1 };
    const fake = fakeNamespace({ reply: { snapshot: snap } });
    const args: SnapshotArgs = RESERVE;
    await expect(createQuotaClient(fake.namespace).snapshot(args)).resolves.toEqual(snap);
    expect(fake.calls).toEqual([{ method: 'snapshot', args: [args] }]);
  });

  it('does not touch the namespace until a method is called', () => {
    const fake = fakeNamespace();
    createQuotaClient(fake.namespace);
    expect(fake.names).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('propagates errors of the stub as rejections', async () => {
    const error = new Error('object unavailable');
    const client = createQuotaClient(fakeNamespace({ fail: error }).namespace);
    await expect(client.reserve(RESERVE)).rejects.toBe(error);
    await expect(client.addTokens({ visitorKey: 'v', date: DATE, tokens: 1 })).rejects.toBe(error);
    await expect(client.snapshot(RESERVE)).rejects.toBe(error);
  });

  it('turns a failing lookup into a rejection, not a synchronous throw', async () => {
    const error = new Error('lookup failed');
    const client = createQuotaClient(fakeNamespace({ failLookup: error }).namespace);
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = client.reserve(RESERVE);
    }).not.toThrow();
    await expect(promise).rejects.toBe(error);
  });
});

describe('createMemoryQuotaClient', () => {
  it('allows up to the visitor cap, then denies with the reason', async () => {
    const client = createMemoryQuotaClient(createMemoryKv());
    expect(await client.reserve(RESERVE)).toEqual({ ok: true });
    expect(await client.reserve(RESERVE)).toEqual({ ok: true });
    expect(await client.reserve(RESERVE)).toEqual({ ok: false, reason: 'visitor' });
  });

  it('enforces the daily cap across visitors', async () => {
    const client = createMemoryQuotaClient(createMemoryKv());
    expect(await client.reserve({ ...RESERVE, visitorKey: 'a' })).toEqual({ ok: true });
    expect(await client.reserve({ ...RESERVE, visitorKey: 'b' })).toEqual({ ok: true });
    expect(await client.reserve({ ...RESERVE, visitorKey: 'c' })).toEqual({ ok: true });
    expect(await client.reserve({ ...RESERVE, visitorKey: 'd' })).toEqual({
      ok: false,
      reason: 'daily',
    });
  });

  it('enforces the daily token cap after addTokens, and resets it the next day', async () => {
    const client = createMemoryQuotaClient(createMemoryKv());
    expect(await client.reserve(RESERVE)).toEqual({ ok: true });
    await client.addTokens({ visitorKey: 'visitor-a', date: DATE, tokens: 100 });
    expect(await client.reserve({ ...RESERVE, visitorKey: 'visitor-b' })).toEqual({
      ok: false,
      reason: 'daily-tokens',
    });
    expect(await client.reserve({ ...RESERVE, date: '2026-11-16' })).toEqual({ ok: true });
  });

  it('enforces the lifetime caps across days', async () => {
    const client = createMemoryQuotaClient(createMemoryKv());
    const days = ['2026-11-15', '2026-11-16'];
    for (const date of days) {
      expect(await client.reserve({ ...RESERVE, date })).toEqual({ ok: true });
      expect(await client.reserve({ ...RESERVE, date })).toEqual({ ok: true });
    }
    expect(await client.reserve({ ...RESERVE, date: '2026-11-17' })).toEqual({
      ok: false,
      reason: 'lifetime',
    });
    const tokens = createMemoryQuotaClient(createMemoryKv());
    await tokens.addTokens({ visitorKey: 'v', date: DATE, tokens: 1000 });
    expect(await tokens.reserve({ ...RESERVE, date: '2026-11-16' })).toEqual({
      ok: false,
      reason: 'lifetime-tokens',
    });
  });

  it('reports the snapshot without counting', async () => {
    const client = createMemoryQuotaClient(createMemoryKv());
    await client.reserve(RESERVE);
    const expected = { dailyLimit: 3, dailyUsed: 1, visitorLimit: 2, visitorUsed: 1 };
    expect(await client.snapshot(RESERVE)).toEqual(expected);
    expect(await client.snapshot(RESERVE)).toEqual(expected);
  });

  it('two clients over the same kv share the counters', async () => {
    const kv = createMemoryKv();
    await createMemoryQuotaClient(kv).reserve(RESERVE);
    expect(await createMemoryQuotaClient(kv).snapshot(RESERVE)).toMatchObject({ visitorUsed: 1 });
  });

  it('does not throw on garbage: denies, ignores or returns zeros', async () => {
    const client = createMemoryQuotaClient(createMemoryKv());
    const bad = { visitorKey: '', date: 'nope', limits: null } as unknown as ReserveArgs;
    expect(await client.reserve(bad)).toEqual({ ok: false, reason: 'invalid-input' });
    await expect(
      client.addTokens({ visitorKey: 'v', date: DATE, tokens: -5 }),
    ).resolves.toBeUndefined();
    expect(await client.snapshot(bad)).toEqual({
      dailyLimit: 0,
      dailyUsed: 0,
      visitorLimit: 0,
      visitorUsed: 0,
    });
  });
});

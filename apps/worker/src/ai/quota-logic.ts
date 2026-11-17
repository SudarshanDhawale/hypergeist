// Pure quota counters over a synchronous key-value interface.
//
// `KvLike` is shaped like `SyncKvStorage` (`ctx.storage.kv` of a SQLite-backed Durable Object),
// so a real `ctx.storage.kv` is assignable to it. Every function here is synchronous with no
// await, so each call is atomic inside the Durable Object.
//
// Key layout (values are plain numbers, except `meta:date`, a string):
//   meta:date             the UTC date the daily counters belong to
//   g:<date>:req          global requests of that day
//   g:<date>:tok          global tokens of that day
//   v:<date>:<visitor>    requests of one visitor on that day
//   vn:<date>             number of visitor rows of that day
//   l:req, l:tok          lifetime requests and tokens

export type KvLike = {
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): boolean | void;
  list(options: { prefix: string }): Iterable<[string, unknown]>;
};

export type Limits = {
  /** Requests per visitor per UTC day. */
  visitorDaily: number;
  /** Requests per UTC day, all visitors together. */
  daily: number;
  /** Tokens per UTC day, all visitors together. */
  dailyTokens: number;
  /** Requests over the lifetime of the deployment. */
  lifetime: number;
  /** Tokens over the lifetime of the deployment. */
  lifetimeTokens: number;
  /** Most visitor rows kept per day; later visitors share the key `overflow`. Default 5000. */
  maxVisitorRows?: number;
};

export type DenialReason = 'lifetime' | 'lifetime-tokens' | 'daily' | 'daily-tokens' | 'visitor';

export type ReserveResult = { ok: true } | { ok: false; reason: DenialReason };

export type QuotaSnapshot = {
  dailyLimit: number;
  dailyUsed: number;
  visitorLimit: number;
  visitorUsed: number;
};

export const DEFAULT_MAX_VISITOR_ROWS = 5000;
export const OVERFLOW_VISITOR_KEY = 'overflow';

const META_DATE = 'meta:date';
const LIFETIME_REQUESTS = 'l:req';
const LIFETIME_TOKENS = 'l:tok';

const globalRequests = (date: string): string => `g:${date}:req`;
const globalTokens = (date: string): string => `g:${date}:tok`;
const visitorRow = (date: string, visitor: string): string => `v:${date}:${visitor}`;
const visitorCount = (date: string): string => `vn:${date}`;

/** Reads a counter. Anything that is not a finite number of at least 0 counts as 0. */
function readCount(kv: KvLike, key: string): number {
  const value = kv.get<unknown>(key);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function addCount(kv: KvLike, key: string, amount: number): void {
  const next = readCount(kv, key) + amount;
  kv.put(key, Math.min(next, Number.MAX_SAFE_INTEGER));
}

/** The date part of a daily key (`g:<date>:...`, `v:<date>:...`, `vn:<date>`), or undefined. */
function dateOfDailyKey(key: string): string | undefined {
  const parts = key.split(':');
  const prefix = parts[0];
  if (prefix === 'g' || prefix === 'v' || prefix === 'vn') return parts[1];
  return undefined;
}

/** Deletes the daily keys of every date other than `date` and records `date` as current. */
function rollDate(kv: KvLike, date: string): void {
  if (kv.get<unknown>(META_DATE) === date) return;
  const stale: string[] = [];
  for (const prefix of ['g:', 'v:', 'vn:']) {
    for (const [key] of kv.list({ prefix })) {
      if (dateOfDailyKey(key) !== date) stale.push(key);
    }
  }
  // Collect first, delete after, so the store is never changed while it is iterated.
  for (const key of stale) kv.delete(key);
  kv.put(META_DATE, date);
}

function maxRows(limits: Limits): number {
  const value = limits.maxVisitorRows;
  return value === undefined ? DEFAULT_MAX_VISITOR_ROWS : Math.max(0, value);
}

/** The row a visitor is counted in: its own, or `overflow` when the day's table is full. */
function resolveVisitor(kv: KvLike, date: string, visitor: string, limits: Limits): string {
  if (kv.get<unknown>(visitorRow(date, visitor)) !== undefined) return visitor;
  return readCount(kv, visitorCount(date)) >= maxRows(limits) ? OVERFLOW_VISITOR_KEY : visitor;
}

/**
 * Checks the limits and, when all pass, counts one request. Checks run in a fixed order:
 * lifetime requests, lifetime tokens, daily requests, daily tokens, visitor.
 * Tokens are added after the reply, so one request may overshoot a token cap; the next
 * reserve is the one that is denied.
 */
export function reserve(
  kv: KvLike,
  input: { visitorKey: string; date: string; limits: Limits },
): ReserveResult {
  const { visitorKey, date, limits } = input;
  rollDate(kv, date);

  if (readCount(kv, LIFETIME_REQUESTS) >= limits.lifetime) return { ok: false, reason: 'lifetime' };
  if (readCount(kv, LIFETIME_TOKENS) >= limits.lifetimeTokens) {
    return { ok: false, reason: 'lifetime-tokens' };
  }
  if (readCount(kv, globalRequests(date)) >= limits.daily) return { ok: false, reason: 'daily' };
  if (readCount(kv, globalTokens(date)) >= limits.dailyTokens) {
    return { ok: false, reason: 'daily-tokens' };
  }

  const visitor = resolveVisitor(kv, date, visitorKey, limits);
  const rowKey = visitorRow(date, visitor);
  const isNewRow = kv.get<unknown>(rowKey) === undefined;
  if (readCount(kv, rowKey) >= limits.visitorDaily) return { ok: false, reason: 'visitor' };

  addCount(kv, LIFETIME_REQUESTS, 1);
  addCount(kv, globalRequests(date), 1);
  addCount(kv, rowKey, 1);
  // The shared `overflow` row is not counted, so rows stay at most `maxVisitorRows` plus one.
  if (isNewRow && visitor !== OVERFLOW_VISITOR_KEY) addCount(kv, visitorCount(date), 1);
  return { ok: true };
}

/**
 * Adds the tokens of a finished request to the daily and lifetime counters. A value that is
 * not finite or is negative counts as 0; a fraction is rounded down.
 */
export function addTokens(
  kv: KvLike,
  input: { visitorKey: string; date: string; tokens: number },
): void {
  const { date, tokens } = input;
  const amount = Number.isFinite(tokens) && tokens > 0 ? Math.floor(tokens) : 0;
  rollDate(kv, date);
  addCount(kv, globalTokens(date), amount);
  addCount(kv, LIFETIME_TOKENS, amount);
}

/**
 * The request numbers for `GET /api/ai/quota`. Changes nothing and does not roll the date:
 * for a date other than `meta:date` it reports zero used.
 */
export function snapshot(
  kv: KvLike,
  input: { visitorKey: string; date: string; limits: Limits },
): QuotaSnapshot {
  const { visitorKey, date, limits } = input;
  const base = { dailyLimit: limits.daily, visitorLimit: limits.visitorDaily };
  if (kv.get<unknown>(META_DATE) !== date) return { ...base, dailyUsed: 0, visitorUsed: 0 };
  const visitor = resolveVisitor(kv, date, visitorKey, limits);
  return {
    ...base,
    dailyUsed: readCount(kv, globalRequests(date)),
    visitorUsed: readCount(kv, visitorRow(date, visitor)),
  };
}

/** An in-memory `KvLike` for tests. `list` returns a sorted copy, so deleting while iterating is safe. */
export function createMemoryKv(): KvLike {
  const map = new Map<string, unknown>();
  return {
    get<T>(key: string): T | undefined {
      // The caller names the stored type, as with the Durable Object API.
      return map.get(key) as T | undefined;
    },
    put(key: string, value: unknown): void {
      map.set(key, value);
    },
    delete(key: string): boolean {
      return map.delete(key);
    },
    list(options: { prefix: string }): Iterable<[string, unknown]> {
      return [...map.entries()]
        .filter(([key]) => key.startsWith(options.prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
  };
}

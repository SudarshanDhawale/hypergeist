// Defensive front door of the quota counters.
//
// The Quota_Store receives its arguments over RPC, so they are treated as untrusted: every value
// is checked here and only the known fields are picked. Garbage never throws; it gets a
// denial-like result (`reserve`), a zero snapshot, or is ignored (`addTokens`), so a bad call
// can never count as an allowed request. `QuotaStore` and the in-memory client both run these
// functions, so tests cover the code that runs in production (only the Durable Object shell
// differs).

import {
  addTokens,
  reserve,
  snapshot,
  type KvLike,
  type Limits,
  type QuotaSnapshot,
  type ReserveResult,
} from './quota-logic';

/** Plain, serializable arguments of the RPC methods. */
export type ReserveArgs = { visitorKey: string; date: string; limits: Limits };
export type AddTokensArgs = { visitorKey: string; date: string; tokens: number };
export type SnapshotArgs = { visitorKey: string; date: string; limits: Limits };

/** `reserve` result: the logic's result, or a denial for arguments that failed the checks. */
export type GuardedReserveResult = ReserveResult | { ok: false; reason: 'invalid-input' };

const VISITOR_KEY = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A finite, non-negative integer within the safe range. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isVisitorKey(value: unknown): value is string {
  return typeof value === 'string' && VISITOR_KEY.test(value);
}

/** `YYYY-MM-DD` that names a real calendar day (rejects `2026-02-31`). */
function isDate(value: unknown): value is string {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseLimits(value: unknown): Limits | undefined {
  if (!isRecord(value)) return undefined;
  const { visitorDaily, daily, dailyTokens, lifetime, lifetimeTokens, maxVisitorRows } = value;
  if (
    !isCount(visitorDaily) ||
    !isCount(daily) ||
    !isCount(dailyTokens) ||
    !isCount(lifetime) ||
    !isCount(lifetimeTokens)
  ) {
    return undefined;
  }
  if (maxVisitorRows === undefined) {
    return { visitorDaily, daily, dailyTokens, lifetime, lifetimeTokens };
  }
  if (!isCount(maxVisitorRows)) return undefined;
  return { visitorDaily, daily, dailyTokens, lifetime, lifetimeTokens, maxVisitorRows };
}

/** Parses the shared `{ visitorKey, date, limits }` shape of `reserve` and `snapshot`. */
function parseWithLimits(input: unknown): ReserveArgs | undefined {
  if (!isRecord(input)) return undefined;
  const { visitorKey, date } = input;
  if (!isVisitorKey(visitorKey) || !isDate(date)) return undefined;
  const limits = parseLimits(input['limits']);
  return limits === undefined ? undefined : { visitorKey, date, limits };
}

export function guardedReserve(kv: KvLike, input: unknown): GuardedReserveResult {
  const args = parseWithLimits(input);
  if (args === undefined) return { ok: false, reason: 'invalid-input' };
  return reserve(kv, args);
}

/** Counts nothing when the arguments are invalid. */
export function guardedAddTokens(kv: KvLike, input: unknown): void {
  if (!isRecord(input)) return;
  const { visitorKey, date, tokens } = input;
  if (!isVisitorKey(visitorKey) || !isDate(date) || !isCount(tokens)) return;
  addTokens(kv, { visitorKey, date, tokens });
}

/** Zero limits and zero use for invalid arguments, so no number of real quota is shown. */
export function guardedSnapshot(kv: KvLike, input: unknown): QuotaSnapshot {
  const args = parseWithLimits(input);
  if (args === undefined) return { dailyLimit: 0, dailyUsed: 0, visitorLimit: 0, visitorUsed: 0 };
  return snapshot(kv, args);
}

// What the chat route sees of the quota: three async methods. The production client talks to the
// Quota_Store Durable Object; the in-memory client runs the same guarded logic over a `KvLike`.
// Errors from the Durable Object (unavailable, overloaded) propagate as rejections: the caller
// fails closed.

import {
  guardedAddTokens,
  guardedReserve,
  guardedSnapshot,
  type AddTokensArgs,
  type GuardedReserveResult,
  type ReserveArgs,
  type SnapshotArgs,
} from './quota-guard';
import type { KvLike, QuotaSnapshot } from './quota-logic';
// Type-only: erased at build time, so this file never loads `cloudflare:workers` at runtime.
import type { QuotaStore } from './quota-store';

export type { AddTokensArgs, GuardedReserveResult, ReserveArgs, SnapshotArgs };

export type QuotaClient = {
  reserve(args: ReserveArgs): Promise<GuardedReserveResult>;
  addTokens(args: AddTokensArgs): Promise<void>;
  snapshot(args: SnapshotArgs): Promise<QuotaSnapshot>;
};

/** The one Quota_Store instance of the whole app. */
export const QUOTA_OBJECT_NAME = 'global';

export function createQuotaClient(namespace: DurableObjectNamespace<QuotaStore>): QuotaClient {
  // The stub is looked up per call, inside the async function, so a failing lookup is a rejection
  // and never a synchronous throw.
  const stub = () => namespace.get(namespace.idFromName(QUOTA_OBJECT_NAME));
  return {
    async reserve(args) {
      return await stub().reserve(args);
    },
    async addTokens(args) {
      await stub().addTokens(args);
    },
    async snapshot(args) {
      return await stub().snapshot(args);
    },
  };
}

/** For tests: the same guarded logic as the Durable Object, over the given key-value store. */
export function createMemoryQuotaClient(kv: KvLike): QuotaClient {
  return {
    reserve: (args) => Promise.resolve(guardedReserve(kv, args)),
    addTokens: (args) => {
      guardedAddTokens(kv, args);
      return Promise.resolve();
    },
    snapshot: (args) => Promise.resolve(guardedSnapshot(kv, args)),
  };
}

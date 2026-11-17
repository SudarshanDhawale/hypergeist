// The Quota_Store Durable Object: a thin shell that runs the quota logic over the object's own
// synchronous storage (`ctx.storage.kv`, SQLite-backed). Each RPC method is synchronous inside
// the object, so every call is atomic.
//
// This is the only file in the Worker that imports `cloudflare:workers`, which Node cannot
// resolve, so no test imports it. The logic and the input checks live in `quota-logic.ts` and
// `quota-guard.ts`, which are tested.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import {
  guardedAddTokens,
  guardedReserve,
  guardedSnapshot,
  type AddTokensArgs,
  type GuardedReserveResult,
  type ReserveArgs,
  type SnapshotArgs,
} from './quota-guard';
import type { QuotaSnapshot } from './quota-logic';

export class QuotaStore extends DurableObject<Env> {
  reserve(args: ReserveArgs): GuardedReserveResult {
    return guardedReserve(this.ctx.storage.kv, args);
  }

  addTokens(args: AddTokensArgs): void {
    guardedAddTokens(this.ctx.storage.kv, args);
  }

  snapshot(args: SnapshotArgs): QuotaSnapshot {
    return guardedSnapshot(this.ctx.storage.kv, args);
  }
}

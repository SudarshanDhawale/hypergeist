# Implementation Plan: worker-backend

## Overview

This plan implements `design.md`: the AI proxy in `apps/worker`, the shared wire schema, the quota Durable Object, and the deployment guide. Run the tasks in orchestrator mode. Task 0 is a user step (two packages). Deployment and the real-provider check are user steps at the end; no task deploys or touches a secret.

Requirements and decisions: `requirements.md`. Steering rules (conventions, architecture, tech-stack) apply to every task and are not repeated here. Tasks in one wave touch different files, so each wave can run at once.

## Executor safety rules

Read these before every task. They override anything else in this file.

1. **No network, no installs.** The agent shell has no network. Never run `pnpm install`, `pnpm add`, `pnpm update`, or any command that modifies `node_modules`. No test may call a real provider or any network host: use fakes.
2. **Never deploy, never touch a secret.** Do not run `wrangler deploy`, `wrangler secret put`, `wrangler login` or any command that talks to Cloudflare. `wrangler deploy --dry-run` (the existing `pnpm build` of the worker) is allowed and needs `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false`. Never read, print or write a real key; fixtures use obviously fake strings (for example `test-secret-sarvam-0000`).
3. **Scoped commands during the work.** Use `pnpm exec vitest run <paths>`, `pnpm --filter @hypergeist/worker typecheck`, `pnpm --filter @hypergeist/shared typecheck`, `pnpm exec eslint <paths>`, and `pnpm exec prettier --write <touched files>`. Run the full suite only in the checkpoint tasks.
4. **No browser in the sandbox.** This spec has no Playwright test.
5. **Do not commit or push.** The Developer commits.
6. **Code conventions.** `strict` TypeScript, no `any`, named exports (the one default export stays in `apps/worker/src/index.ts`), results as values, inputs never mutated, files `kebab-case.ts`, tests next to code. Vitest globals are off: import `describe`, `it`, `expect`, `vi` from `vitest`. In `packages/shared` and `scripts/` relative imports end in `.ts`; in `apps/worker` they follow the existing style (no extension, as in `import { app } from './app'`). Only erasable TypeScript.
7. **Pure and injected.** Nothing under `apps/worker/src/` outside `ai/deps.ts` and `index.ts` reads the clock, `crypto.randomUUID`, `Math.random`, the network or an environment object directly: they are passed in. Only `lib/log.ts` writes to the console. `quota-store.ts` is the only file that imports `cloudflare:workers`, and no test imports it.
8. **Errors have one door.** Only `lib/errors.ts` builds an error response. No route, no module and no test helper may put request text, upstream text, an exception message or a header value into a response body.
9. **Zod at the boundary.** Request bodies, config values and upstream replies are parsed with Zod. `z.looseObject` only for upstream replies, with a comment.
10. **Property tests.** Use `assertProperty` from `packages/shared/test-support/seed.ts` and the shared arbitraries where useful, imported by relative path (allowed for `*.test.ts` files). Add the comment `Feature: worker-backend, Property N: <title>` and a `Validates` line. Async properties: copy the local async helper pattern from `apps/web/src/persistence/repository.property.test.ts`. Set explicit test timeouts (60 s).
11. **Existing tests stay green.** Edit only the files a task names.
12. **Honest reporting.** If a task cannot be finished, say so. Do not mark it done.

## Tasks

- [x] 0. USER CHECKPOINT: install two packages in `apps/worker` (Developer runs this in their own terminal)
  - [x] 0.1 Ask the Developer to run `pnpm --filter @hypergeist/worker add zod` and `pnpm --filter @hypergeist/worker add -D fast-check`
    - Stop and wait. Afterwards check `apps/worker/package.json` lists `zod` under `dependencies` and `fast-check` under `devDependencies` (same versions as `packages/shared`: `^4.6.7` and `^4.10.2`), and that `pnpm check:deps` still passes. These are the only dependency changes of this spec
    - _Requirements: 9.1_

- [x] 1. Shared wire schema
  - [x] 1.1 Create `packages/shared/src/ai-wire/schemas.ts`, `index.ts`, `schemas.test.ts`; add the entry point
    - `AI_WIRE_LIMITS`, `ChatRequestSchema`, `UpstreamReplySchema`, `PublicReplySchema` and their `z.infer` types as in the design. Add `"./ai-wire": "./src/ai-wire/index.ts"` to `packages/shared/package.json` exports, add `'@hypergeist/shared/ai-wire'` to `SHARED_PUBLIC_ENTRY_POINTS` in `scripts/check-deps/rules.ts` (and a test line in `scripts/check-deps/check-deps.test.ts`), add an export pin for the new entry in `packages/shared/src/smoke.test.ts`, and update the layout note in `README.md` only if it lists entry points. Tests: accepts a minimal request and a full one (tools, tool-call history, `temperature`, `max_tokens`, `stream: false`, `tool_choice`); rejects unknown top-level keys (`n`, `stop`, `user`, `response_format`), an unknown message key, a non-`function` tool type, `stream: true`, `tool_choice: 'required'`, 61 messages, 13 tools, content over 40,000 characters, 101 tool calls, a non-object body, an empty `messages` array; the public reply schema rejects extra keys; the upstream schema keeps unknown keys and a missing `usage` is fine; `AI_WIRE_LIMITS` values pinned
    - _Requirements: 2.2, 2.3, 5.6_
  - [x] 1.2 Add a contract test to `apps/web/src/ai/wire.test.ts`
    - `toWireBody(model, request)` output (a plain request, a request with the compact tool registry from `buildToolRegistry`, a request with an assistant tool-call message and a tool message, one with `maxTokens`) parses with `ChatRequestSchema` from `@hypergeist/shared/ai-wire`; the test names the contract. Edit only that test file. If the output does not parse, report the exact mismatch and do not weaken the shared schema without saying so
    - _Requirements: 2.2_

- [x] 2. Worker libraries
  - [x] 2.1 Create `apps/worker/src/lib/errors.ts`, `lib/time.ts` and tests
    - `ERROR_CODES` (the nine codes of Requirement 1.2), `ERROR_STATUS` (the mapping of 1.3), `errorResponse(code, options?: { retryAfterSeconds?: number })` returning a `Response` with JSON `{ error: { code } }`, `cache-control: no-store`, `x-content-type-options: nosniff` and `Retry-After` when given; `utcDate(ms)` (`YYYY-MM-DD`) and `secondsUntilUtcMidnight(ms)` (1 to 86,400). Tests: every code and status; the body has no field except `error.code`; `Retry-After` only for 429; dates around midnight, leap day, year end
    - _Requirements: 1.2, 1.3, 1.6, 8.2_
  - [x] 2.2 Create `apps/worker/src/lib/origin.ts` and tests
    - `checkOrigin(headers: Headers, allowedOrigins: readonly string[]): boolean` per the design (exact match after trimming a trailing slash from config entries only, `Sec-Fetch-Site` must be `same-origin` when present, missing `Origin` fails, case-sensitive scheme and host as sent). Tests: match, mismatch, missing, `null` origin string, `Sec-Fetch-Site` values `same-origin`, `same-site`, `cross-site`, `none`, trailing slash in config, an origin that only starts with an allowed one (`https://a.example.evil.com`), an allowed origin with a different port
    - _Requirements: 3.1, 3.2_
  - [x] 2.3 Create `apps/worker/src/lib/body.ts` and tests
    - `readLimitedBody(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false; reason: 'too-large' | 'unreadable' }>`. Rejects on a `content-length` above the limit without reading; otherwise reads the stream chunk by chunk and cancels at the limit; handles a missing body and invalid UTF-8 (replacement characters are fine, no throw). Tests with `ReadableStream` bodies: exactly the limit passes, one byte over fails, a lying `content-length`, many tiny chunks, a stream that errors, an empty body
    - _Requirements: 2.1_
  - [x] 2.4 Create `apps/worker/src/lib/visitor.ts` and tests
    - `visitorKey(ip: string | null, salt: string, date: string): Promise<string>` (SHA-256 of `ip|date|salt`, first 32 hex characters, `unknown` for null or empty). Tests: length and hex, differs by ip, date and salt, deterministic, never contains the ip text, IPv6
    - _Requirements: 4.6, 8.1_
  - [x] 2.5 Create `apps/worker/src/env.ts`, `lib/config.ts` and tests
    - `Env` type (bindings: `ASSETS`, `QUOTA: DurableObjectNamespace`, `AI_BURST: RateLimit`; vars and secrets as optional strings), `DEFAULTS`, `parseConfig(env: Record<string, unknown>): { ok: true; config: AiConfig } | { ok: false }` per the design table (numbers from strings with bounds, provider list validated against the table names, required model and key for each listed provider, non-empty origin list, `AI_ENABLED` `false` gives `{ ok: true, config }` with `enabled: false`; the handler maps both to `AI_DISABLED`). `AiConfig` holds the parsed values and the secrets in one object that has no `toJSON` leak: tests assert `JSON.stringify(result)` of a failed parse contains no secret, and that `ok: false` carries no detail. Tests: defaults, every bound at its edge, non-numeric, empty strings, unknown provider, missing key, `AI_PROVIDERS` with two entries and whitespace, reasoning effort values
    - _Requirements: 6.2, 6.3_
  - [x] 2.6 Create `apps/worker/src/lib/log.ts` and tests
    - `logRequest(entry: LogEntry, write?: (line: string) => void)` with `LogEntry = { route: string; status: number; code: string; provider: string; kind: string; ms: number; counted: boolean }`; default `write` is `console.log`; one JSON line with exactly those keys. Disable the no-console rule for this file only, with a comment. Tests: exact key set, a test that passes extra properties (cast through `unknown`) and checks they are dropped, numbers only where numbers belong
    - _Requirements: 7.2_

- [x] 3. Quota
  - [x] 3.1 Create `apps/worker/src/ai/quota-logic.ts` and `quota-logic.test.ts`
    - `KvLike`, `Limits`, `reserve`, `addTokens`, `snapshot`, and an in-memory `createMemoryKv()` for tests, exactly as in the design (key layout, date reset deleting other dates, the five checks in order, the 5,000-visitor overflow to `overflow`, counters never negative, `snapshot` free of side effects). Tests: each check denies with its reason at the boundary (cap minus one allows, cap denies), per-visitor independence, the date change resets daily and visitor counters but not lifetime counters, token overshoot behavior (denied only on the next reserve), overflow visitor sharing, `snapshot` on a new day, 100 days of reserves leave only the current day's keys
    - _Requirements: 4.1, 4.2, 4.4, 4.7_
  - [x] 3.2 Create `apps/worker/src/ai/quota-store.ts`, `quota-client.ts` and `quota-client.test.ts`
    - `QuotaStore extends DurableObject` (import from `cloudflare:workers`) with RPC methods `reserve`, `addTokens`, `snapshot` that call the logic with `this.ctx.storage.kv`; `createQuotaClient(namespace)` returning `{ reserve, addTokens, snapshot }` over `namespace.get(namespace.idFromName('global'))`; `createMemoryQuotaClient(kv, limitsFor)` for tests (same interface, backed by `createMemoryKv`). `quota-store.ts` has no test and is excluded from coverage by being untested; the client test uses a fake namespace object (a stub with `idFromName` and `get` returning an object with the three methods) to check the call shapes and that errors propagate. `pnpm --filter @hypergeist/worker typecheck` must pass with the `cloudflare:workers` import
    - _Requirements: 4.2, 4.8_

- [x] 4. Providers and upstream
  - [x] 4.1 Create `apps/worker/src/ai/providers.ts` and `providers.test.ts`
    - `PROVIDER_TABLE`, `ProviderName`, `adaptRequest(provider, request, config)` and `authHeaders(provider, key)` as in the design. Build the body by picking fields. Tests: sarvam body (`max_tokens`, temperature clamped to 0 to 1, no `reasoning_effort`), openai body (`max_completion_tokens`, no `max_tokens`, no `temperature`, `reasoning_effort` only when configured), client `max_tokens` above the clamp is clamped, absent `max_tokens` uses the clamp, model selection for `auto` and for an allowlisted name, `stream` is `false`, `messages` and `tools` unchanged, a request with extra fields cast in (simulating a schema bug) does not leak them, headers (`Authorization` for both, `api-subscription-key` for sarvam only), the table URLs are `https:` and exactly the two documented hosts
    - _Requirements: 2.4, 5.1, 5.2, 5.8_
  - [x] 4.2 Create `apps/worker/src/ai/upstream.ts` and `upstream.test.ts`
    - `callUpstream`, the outcome type, `tokensFrom`, and `toPublicReply` as in the design, with a fake `fetch`. Tests: success with content, with tool calls, with both; usage present, absent, negative, a string; token estimate; 429, 500, 503, timeout (fake timers; the abort signal reaches the fetch), thrown network error, a non-JSON body, a body that fails the schema, all retryable; 400, 401, 403, 404 not retryable; the public reply contains only the allowed keys (feed a reply with `usage`, `id`, `system_fingerprint`, `reasoning_content`, extra keys inside `message` and inside tool calls); missing tool call ids become `call-<index>`; more than 100 tool calls is `bad-reply`; the error outcome has no text field; the key never appears in any returned value; `redirect: 'error'` is set; empty content with `finish_reason: 'length'` is returned as is with `kind: 'empty-length'`
    - _Requirements: 5.3 to 5.7, 4.5_

- [x] 5. Routes and wiring
  - [x] 5.1 Create `apps/worker/src/ai/deps.ts`, `chat-route.ts` and `chat-route.test.ts`
    - `Deps` (`now`, `fetch`, `limiter`, `quota`, `log`, `timeouts`), `defaultDeps(env)`, and `handleChat` as in the design pipeline. Example tests through `buildApp(overrides)` (task 5.3 creates `buildApp`; write the route test against a local small Hono app mounted with `handleChat` so this task does not depend on 5.3): every error code and its status, `Retry-After` values, the order of the checks (a request that fails origin never reaches the limiter; one that fails validation never reaches the quota), burst denied, each quota denial reason maps to `DAILY_CAP`, limiter or quota throwing gives `UPSTREAM_FAILED` with zero upstream calls, failover from the first to the second provider (and the second provider's own adaptation), no failover on 401, exhausted providers, a successful reply body equals the public shape, tokens added after success (and an `addTokens` failure does not change the 200), the counted flag in the log line, the log line has no body text, an internal exception gives `INTERNAL`, kill switch and invalid configuration give `AI_DISABLED` with zero upstream calls
    - _Requirements: 1.1 to 1.4, 3, 4.1, 4.8, 5.1 to 5.4, 6.3, 7.2_
  - [x] 5.2 Create `apps/worker/src/ai/quota-route.ts` and `quota-route.test.ts`
    - `handleQuota` per the design: config, origin, burst limiter with a `quota:` key, `snapshot`, the JSON of Requirement 4.9 (`resetsAt` ISO string of the next UTC midnight); it does not call `reserve`. Tests: shape, the numbers after some chat reservations (using the memory quota client), origin and burst denial, config failure, snapshot error gives `UPSTREAM_FAILED`
    - _Requirements: 4.9_
  - [x] 5.3 Update `apps/worker/src/app.ts`, `index.ts`, `wrangler.jsonc`, create `apps/worker/.dev.vars.example`, extend `app.test.ts`
    - `buildApp(overrides?)` mounting `/api/health` (unchanged), `POST /api/ai/chat`, `GET /api/ai/quota`, the no-store header middleware for `/api/ai/*`, the existing `notFound` and `onError`; `export const app = buildApp()`; `index.ts` exports the app as default and `QuotaStore`. `wrangler.jsonc`: `durable_objects`, `migrations` (`v1`, `new_sqlite_classes`), `ratelimits`, `vars` with the defaults of the design (with `AI_ALLOWED_ORIGINS` set to the two localhost origins and a comment that the Developer adds the deployed URL; `AI_PROVIDERS` `sarvam`; model vars left as placeholders that make the AI disabled until set, with a comment). A test pins that the `vars` in `wrangler.jsonc` equal `DEFAULTS` for the cap values (read the file with `node:fs` and a JSONC-tolerant parse). Existing `app.test.ts` tests stay green; add: other methods on `/api/ai/chat` give the generic 404, the response of every `/api/ai/*` route has `cache-control: no-store` and no `access-control-*` header. `pnpm --filter @hypergeist/worker typecheck` and the dry-run build (`XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false pnpm build`) pass
    - _Requirements: 1.3, 1.5, 1.6, 6.2, 6.4_

- [x] 6. Property and guard tests
  - [x] 6.1 Create `apps/worker/src/ai/proxy.property.test.ts`
    - **Property 1: Total and closed**, **Property 2: Forwarded fields are an allowlist**, **Property 4: Fail closed**, **Property 5: The reply allowlist**, as in the design, through `buildApp` with fake limiter, memory quota client, fake `fetch` and arbitrary inputs (including hostile upstream replies that echo the test secrets in every field, and request bodies built by mutating a valid request)
    - **Validates: Requirements 1.2, 1.3, 2.3, 2.4, 4.8, 5.6, 5.7, 6.1, 9.3**
  - [x] 6.2 Create `apps/worker/src/ai/caps.property.test.ts`
    - **Property 3: Caps hold** and **Property 6: Visitor key**, as in the design, with an injected clock moving across several UTC days
    - **Validates: Requirements 4.1 to 4.7, 9.3**
  - [x] 6.3 Create `apps/worker/src/ai/guards.test.ts`
    - The CPU budget test (a 128 KB valid request through `readLimitedBody`, `JSON.parse` and `ChatRequestSchema`; median of 20 runs under 10 ms; print the measured median in the test name or a comment; this is a Node measurement, state so); the repository scan for key-shaped strings (OpenAI `sk-` followed by 20 or more characters, `gsk_`, `AIza`, and a Sarvam-style long hex or `sk_` token if the docs define a prefix; scan tracked text files under `apps/`, `packages/`, `docs/`, `.kiro/`, `scripts/`, `e2e/`, excluding the test-file fixtures that use the documented fake prefix `test-secret-`) via `node:fs`; a check that `wrangler.jsonc` has no secret names with values and `.dev.vars` is git-ignored (read `.gitignore`)
    - _Requirements: 2.6, 6.1, 6.4, 6.5_

- [x] 7. Docs
  - [x] 7.1 Write `docs/deployment.md`
    - The steps the Developer runs, in order: prerequisites (Cloudflare account, `pnpm build`, `wrangler login`), local run with `.dev.vars` (`pnpm --filter @hypergeist/worker dev` and the `curl` calls for health, quota and chat with `-H 'Origin: http://localhost:8787'`), first deploy (`wrangler deploy` from `apps/worker`, note the `workers.dev` URL), set `AI_ALLOWED_ORIGINS` to that URL and redeploy, `wrangler secret put SARVAM_API_KEY`, `QUOTA_SALT` (how to generate a random value), model ids (`GET /v2/models` for Sarvam with `curl` and the key from an environment variable), smoke tests on the deployed URL, where to read logs (`wrangler tail`), the kill switch (`AI_ENABLED=false` in the dashboard), sizing the caps from the remaining credit (a worked example with a $5 OpenAI credit: caps in tokens times the model's price must stay under the credit, with a safety factor), setting a hard spending limit in the OpenAI project, and **the switch to OpenAI for the submission**: `wrangler secret put OPENAI_API_KEY`, set `AI_PROVIDERS=openai`, `AI_OPENAI_MODEL`, optional `AI_REASONING_EFFORT`, redeploy, run the manual checks. State what the origin check does not stop. Never include a real key. Mark every price or model name as "check the provider's page on the day"
    - _Requirements: 6.6, 4.3, 4.10, 9.4_
  - [x] 7.2 Write `docs/manual-verification-worker.md`
    - Checklist like the other manual files (ID `W-01...`, steps, expected result, empty Result column, sign-off): on the deployed URL, from a browser console `fetch` with the right `Origin` and from `curl` with none; each error code reachable by a real request (bad JSON, too large, wrong origin, burst by looping 11 calls, daily cap by lowering `AI_DAILY_CAP` temporarily); quota endpoint numbers match; failover is checked by setting a wrong model name on the first provider and a right one on the second; a real tool-call request builds a stack through the app's `createProxyProvider` (steps with a temporary test file, as in `docs/manual-verification-ai.md`); OpenAI reasoning-model check (empty content with `finish_reason: length`?), the Sarvam header check (is `Authorization: Bearer` alone accepted?), record real token usage per request and the real cost; the kill switch; log lines contain no content; secrets are not in the repo (`git log -p` search); CPU time in the dashboard stays under the limit
    - _Requirements: 9.4_
  - [x] 7.3 Update `README.md`, `docs/handoff.md`, `.kiro/steering/project-status.md`, `docs/kiro-journal.md`
    - README: a short "AI proxy" section (what it does, the two providers, the limits, how to run it locally, link to `docs/deployment.md`; state that it is not deployed until the Developer deploys). Handoff: replace the proxy contract paragraph's provider names, record the module layout, the config table, the decisions (Sarvam then OpenAI, caps by requests and tokens, Durable Object counters, fail closed), and the next steps. Status file and journal as in earlier specs; do not invent findings and do not state that it was deployed or tried with a real provider
    - _Requirements: 9.4_

- [x] 8. Final verification
  - [x] 8.1 Run the full verification suite
    - In this order and record each result: `pnpm format` then `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm check:deps`; `pnpm test` three times with `HYPERGEIST_TEST_SEED=1`, `20261115` and `424242`; `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false pnpm build`. Also check: `git diff --stat -- package.json pnpm-lock.yaml apps/*/package.json packages/*/package.json` shows only `zod` and `fast-check` in `apps/worker` plus the new `exports` entry of `packages/shared`; no `.tsx` file contains `--ghost`; `.kiro` is not in `.gitignore`; no real key anywhere (the guard test). If a seed fails, record the seed and the shrunk counterexample and fix the cause in a follow-up task instead of weakening the test. Do not commit
    - _Requirements: 9.1 to 9.3_

- [ ] 9. USER CHECKPOINT: deploy and check (Developer)
  - [ ] 9.1 Ask the Developer to follow `docs/deployment.md` and `docs/manual-verification-worker.md`
    - The Developer deploys with Sarvam first, then, when ready for the submission, switches to OpenAI as described. Stop and ask for the results. If a case fails, record it and fix it in a follow-up task. The Developer may postpone the OpenAI step to the final week; record that
    - _Requirements: 6.6, 9.4_

- [ ] 10. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise. Remind the Developer to review the diff and commit; no task commits, pushes, or deploys.

## Notes

- All six properties are required: they are the proof that the hosted key cannot be spent without limits and that nothing leaks.
- The CPU measurement in task 6.3 runs in Node and only approximates the 10 ms Workers limit; the real number is in the Cloudflare dashboard (manual case).
- Provider facts (endpoint paths, header names, parameter names, model ids, prices) came from vendor docs and third-party summaries read on 2026-11-15. The manual checks exist to confirm each of them against the real service before the submission.
- No task adds a dependency other than those of task 0, edits `pnpm-lock.yaml`, commits, pushes, or deploys.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1"] },
    { "id": 1, "tasks": ["1.1", "2.1", "2.2", "2.3", "2.4", "2.5", "2.6", "3.1"] },
    { "id": 2, "tasks": ["1.2", "3.2", "4.1"] },
    { "id": 3, "tasks": ["4.2"] },
    { "id": 4, "tasks": ["5.1", "5.2"] },
    { "id": 5, "tasks": ["5.3"] },
    { "id": 6, "tasks": ["6.1", "6.2", "6.3", "7.1", "7.2"] },
    { "id": 7, "tasks": ["7.3"] },
    { "id": 8, "tasks": ["8.1"] },
    { "id": 9, "tasks": ["9.1"] }
  ]
}
```

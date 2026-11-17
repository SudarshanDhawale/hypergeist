# Design Document

## Overview

The AI proxy is a few small modules in `apps/worker/src/` around one handler. A request goes through a fixed pipeline: configuration, same-origin check, bounded body read, strict validation, burst limit, quota reservation, upstream call (with one failover), token accounting, and a reply cut down to an allowlist. Every failure leaves through one function that builds an error body from a closed code, so no text from the request, the upstream or an exception can reach the browser. All time, network and storage access is injected (`Deps`), so the whole pipeline is tested with `app.request` and fakes, with no network and no Workers runtime.

One definition of the wire format lives in `packages/shared` (`@hypergeist/shared/ai-wire`), so the browser's `toWireBody` output and the Worker's validator cannot drift. No other part of `packages/shared` changes.

**New dependencies (the Developer runs the install):** `zod` and, as a dev dependency, `fast-check` in `apps/worker`. Nothing else: Durable Objects, the Rate Limiting binding and the Web Crypto API are part of the platform, and `@cloudflare/workers-types` is already present.

## Architecture

```
packages/shared/src/ai-wire/
  schemas.ts          ChatRequestSchema, UpstreamReplySchema, PublicReplySchema, limits
  index.ts            public entry @hypergeist/shared/ai-wire
apps/worker/src/
  index.ts            default export (the Hono app) and `export { QuotaStore }`
  app.ts              buildApp(overrides?), mounts /api/health and the AI routes
  env.ts              Env type (bindings, vars, secrets)
  lib/
    errors.ts         ERROR_CODES, errorResponse(code, options) (the only place that builds an error)
    origin.ts         checkOrigin(request, allowed)
    body.ts           readLimitedBody(request, maxBytes)
    visitor.ts        visitorKey(ip, salt, date)
    config.ts         parseConfig(env) with Zod -> AiConfig | { ok: false }
    log.ts            logRequest(entry) one JSON line, fixed fields only
    time.ts           utcDate(ms), secondsUntilUtcMidnight(ms)
  ai/
    providers.ts      PROVIDER_TABLE, adaptRequest(), authHeaders()
    upstream.ts       callUpstream(), classify outcome, extract usage, cut the public reply
    quota-logic.ts    pure counters over a KvLike (reserve, addTokens, snapshot)
    quota-store.ts    class QuotaStore extends DurableObject (thin wrapper over quota-logic)
    quota-client.ts   createQuotaClient(env.QUOTA) -> { reserve, addTokens, snapshot }
    deps.ts           Deps type and defaultDeps(env, ctx)
    chat-route.ts     handleChat(c, deps)
    quota-route.ts    handleQuota(c, deps)
wrangler.jsonc        durable_objects, migrations, ratelimits, vars (no secrets)
.dev.vars.example     secret names only
```

Dependency rules: `apps/worker` imports `@hypergeist/shared/ai-wire` (new public entry), `hono`, `zod`, and nothing from `apps/web`. `quota-store.ts` is the only file that imports `cloudflare:workers`; tests never import it. `check:deps` gets the new entry point added to `SHARED_PUBLIC_ENTRY_POINTS`.

## Shared wire schemas (`packages/shared/src/ai-wire`)

Constants `AI_WIRE_LIMITS` (128 KB body, 60 messages, 40,000 characters per content, 100 tool calls, 12 tools, 2,000 description, 64 name, 200 id) are exported so the Worker and the tests use the same numbers.

`ChatRequestSchema` is `z.strictObject`:
`model` (string 1 to 100), `messages` (array 1 to 60 of a discriminated union on `role`), `tools?` (array up to 12 of `{ type: 'function', function: { name, description?, parameters: record(string, unknown) } }`, each strict), `tool_choice?` (`'auto' | 'none'`), `stream?` (`false`), `temperature?` (number 0 to 2, clamped later), `max_tokens?` (integer 1 to 100,000, clamped later). Messages: `system` and `user` `{ role, content }`; `assistant` `{ role, content: string | null, tool_calls?: [{ id, type: 'function', function: { name, arguments } }] }`; `tool` `{ role, tool_call_id, content }`; all strict, strings length-bounded. `PublicReplySchema` is the one shape that leaves the Worker: `{ choices: [{ message: { role: 'assistant', content: string | null, tool_calls?: [...] }, finish_reason: string }] }`. `UpstreamReplySchema` is the loose parse of a provider reply (`z.looseObject`, with a comment: external data) with an optional `usage.total_tokens`. A shared test pins the exact schema keys and bounds, and the web `wire.test.ts` gets a new test that `toWireBody(...)` output (with and without tools, with a tool-call history) parses with `ChatRequestSchema`.

## Configuration (`lib/config.ts`)

`parseConfig(env)` reads these values and returns `{ ok: true, config }` or `{ ok: false }` (which means `AI_DISABLED`):

| Name | Kind | Default | Meaning |
|---|---|---|---|
| `AI_ENABLED` | var | `true` | kill switch (`false` disables) |
| `AI_ALLOWED_ORIGINS` | var | none (required) | comma-separated exact origins |
| `AI_ALLOWED_MODELS` | var | empty | extra model names a client may ask for besides `auto` |
| `AI_PROVIDERS` | var | `sarvam` | ordered names from the table |
| `AI_SARVAM_MODEL`, `AI_OPENAI_MODEL` | vars | none | model ids; required for a listed provider |
| `AI_VISITOR_DAILY_CAP` | var | 60 | requests per visitor per UTC day |
| `AI_DAILY_CAP` | var | 400 | requests per UTC day |
| `AI_DAILY_TOKEN_CAP` | var | 1,000,000 | tokens per UTC day |
| `AI_LIFETIME_CAP` | var | 6,000 | requests ever |
| `AI_LIFETIME_TOKEN_CAP` | var | 6,000,000 | tokens ever |
| `AI_MAX_OUTPUT_TOKENS` | var | 2,048 | clamp (1 to 4,096) |
| `AI_REASONING_EFFORT` | var | empty | OpenAI only: `minimal`, `low`, `medium`, `high` |
| `SARVAM_API_KEY`, `OPENAI_API_KEY`, `QUOTA_SALT` | secrets | none | via `wrangler secret put` |

Numbers are given as strings in `vars` (Wrangler passes strings), so the schema uses `z.coerce`-style parsing with explicit bounds and rejects anything non-numeric. A listed provider without its key or model, an unknown provider name, an empty origin list, or any out-of-range value gives `{ ok: false }`. Defaults live in one `DEFAULTS` constant, which `wrangler.jsonc` mirrors, and a test pins that the two agree.

## The pipeline (`ai/chat-route.ts`)

```
handleChat(c):
  t0 = deps.now()
  config = parseConfig(env)                  fail: AI_DISABLED (503)
  config.enabled                             fail: AI_DISABLED
  checkOrigin(request, config.origins)       fail: FORBIDDEN_ORIGIN (403)
  content-type is application/json           fail: BAD_REQUEST (400)
  body = readLimitedBody(request, 128 KB)    fail: PAYLOAD_TOO_LARGE (413)
  JSON.parse                                 fail: BAD_REQUEST
  ChatRequestSchema.safeParse                fail: BAD_REQUEST
  model: 'auto' or in allowlist              fail: MODEL_NOT_ALLOWED (400)
  burst = deps.limiter.limit({ key: 'chat:' + visitorKey })   !success: RATE_LIMITED (429, Retry-After 60); throws: UPSTREAM_FAILED (503)
  quota = deps.quota.reserve(...)            denied: DAILY_CAP (429, Retry-After to UTC midnight); throws: UPSTREAM_FAILED
  for provider in config.providers:
     out = callUpstream(provider, adapt(request, config), signal)
     if out.ok: break
     if not out.retryable: stop (UPSTREAM_FAILED)
  none ok                                     UPSTREAM_FAILED (503)
  deps.quota.addTokens(...)                   (best effort; errors ignored, logged by code only)
  return 200 PublicReplySchema.parse(cut(out.reply))
```
Any exception outside these steps is caught once at the top and answered as `INTERNAL` (500) through `errorResponse`. The route handler never returns a `Response` built any other way. A response header middleware adds `cache-control: no-store` and `x-content-type-options: nosniff` to `/api/ai/*`.

**Visitor key.** `visitorKey(ip, salt, date)` is the first 32 hex characters of SHA-256 over `ip|date|salt` (Web Crypto, one call per request, a few microseconds of CPU). The IP is `CF-Connecting-IP`; missing gives the fixed string `unknown`. The date is the UTC date, so the key changes daily.

**Origin.** `checkOrigin` requires `Origin` to equal (string equality, after trimming a trailing slash from the config entries) one of the allowed origins. If `Sec-Fetch-Site` is present it must be `same-origin`. A missing `Origin` fails. The doc comment states what this does not stop.

**Body.** `readLimitedBody` rejects at once if `content-length` is a number above the limit; otherwise it reads the stream chunk by chunk, counting bytes, and cancels the stream and fails as soon as the count passes the limit; it returns the text. The Worker never reads more than 128 KB plus one chunk.

## Providers and requests (`ai/providers.ts`, `ai/upstream.ts`)

```ts
PROVIDER_TABLE = {
  sarvam: { url: 'https://api.sarvam.ai/v2/chat/completions', tokenParam: 'max_tokens', allowTemperature: true,  keyBinding: 'SARVAM_API_KEY', modelVar: 'AI_SARVAM_MODEL', extraAuthHeader: 'api-subscription-key' },
  openai: { url: 'https://api.openai.com/v1/chat/completions',  tokenParam: 'max_completion_tokens', allowTemperature: false, keyBinding: 'OPENAI_API_KEY', modelVar: 'AI_OPENAI_MODEL' },
} as const;
```
`adaptRequest(provider, request, config)` builds the upstream body from a fixed list of fields: `model` (the provider's configured model; if the client asked for an allowlisted model name, that name is used for the first provider), `messages` and `tools` and `tool_choice` as validated, `stream: false`, the clamped token limit under `tokenParam`, `temperature` (clamped) only when `allowTemperature`, and `reasoning_effort` for `openai` only when configured. `parallel_tool_calls` is not sent. The body is built by picking named fields, never by spreading the request.

`callUpstream({ provider, body, key, fetch, signal, timeoutMs })` sets `Authorization: Bearer <key>` (and the extra header for Sarvam), `content-type`, `redirect: 'error'`, and a 25 s timeout merged with the 55 s whole-request signal. It returns `{ ok: true, reply, tokens }` or `{ ok: false, retryable, kind }` where `kind` is one of `http-4xx`, `rate-limited`, `http-5xx`, `timeout`, `network`, `bad-reply` (for the log). 429, 5xx, timeouts, network errors and unreadable replies are retryable; 400, 401, 403, 404 are not. The reply is parsed with `UpstreamReplySchema` (loose); `tokens` is `usage.total_tokens` if it is a non-negative integer, otherwise `ceil(requestChars / 3) + ceil(replyChars / 3)`. The public reply is built by picking `content`, `tool_calls` (each reduced to `id`, `type`, `function.name`, `function.arguments`) and `finish_reason` from `choices[0]`, then validated with `PublicReplySchema`; a failure there is `bad-reply`. The key, the response headers and the response body of a failed call are never read into any value that outlives the function. Missing tool call ids become `call-<index>`.

**OpenAI reasoning models and output limits.** A reasoning model counts hidden reasoning tokens inside `max_completion_tokens`, so a low limit can end with empty content and `finish_reason: 'length'`. The design does not guess: the default limit is 2,048, `AI_REASONING_EFFORT` can lower the reasoning, and the manual checklist has a case that records the real behavior of the chosen model. If the reply has empty content and no tool calls with `finish_reason: 'length'`, the Worker still returns it (the browser treats it as a Turn that said nothing) and logs `kind: 'empty-length'` so the Developer can see it.

## Quota (`ai/quota-logic.ts`, `quota-store.ts`, `quota-client.ts`)

`quota-logic.ts` is pure over a synchronous key-value interface (`KvLike`: `get`, `put`, `delete`, `list(prefix)`), matching the synchronous KV API of a SQLite-backed Durable Object (`ctx.storage.kv`), so each operation is atomic with no await inside. Keys: `meta:date`, `g:<date>:req`, `g:<date>:tok`, `v:<date>:<visitorKey>`, `vn:<date>` (visitor row count), `l:req`, `l:tok`.

- `reserve({ visitorKey, date, limits })`: if `meta:date` differs from `date`, delete every `g:`, `v:` and `vn:` key of other dates and set `meta:date`. Then check, in order, lifetime requests, lifetime tokens, daily requests, daily tokens, and the visitor's count (a new visitor beyond 5,000 rows is mapped to the shared visitor key `overflow`). The first failing check returns `{ ok: false, reason }`; otherwise increment the four request counters and return `{ ok: true }`.
- `addTokens({ visitorKey, date, tokens })`: adds to `g:<date>:tok` and `l:tok`.
- `snapshot({ visitorKey, date, limits })`: returns the numbers for `GET /api/ai/quota` without changing anything (and without running the date reset, so it shows zero used on a new day).

`QuotaStore` extends `DurableObject` with the three methods as RPC methods, each calling the logic with `this.ctx.storage.kv`. The Worker uses one object (`idFromName('global')`). `wrangler.jsonc` declares the binding and a migration `{ tag: 'v1', new_sqlite_classes: ['QuotaStore'] }` (required for the Free plan). `quota-client.ts` wraps the namespace so the handler sees only `{ reserve, addTokens, snapshot }`, and tests inject an in-memory implementation built on the same logic over a `Map`, so the **real counter logic is what the route tests run**.

Free-plan budget: a chat request makes two Durable Object calls (`reserve`, `addTokens`) and writes about 8 rows; at the default 400 requests a day that is about 800 calls and 3,200 rows, far under the 100,000 per day limits.

## Routes and headers

`app.ts` exports `buildApp(overrides?: Partial<Deps>)` and `app = buildApp()`. The existing `/api/health`, `notFound` and `onError` stay as they are. `POST /api/ai/chat` and `GET /api/ai/quota` are mounted; every other method or path under `/api/ai/` is the existing 404. The `quota` route applies config, origin and the burst limiter (key `quota:` + visitor key) and then `snapshot`. `index.ts` becomes `export default app; export { QuotaStore } from './ai/quota-store';` so `wrangler` sees the class.

`wrangler.jsonc` additions: `durable_objects.bindings` (`QUOTA` to `QuotaStore`), `migrations`, `ratelimits` (`AI_BURST`, namespace id `1001`, 10 per 60), and `vars` with the defaults. `.dev.vars.example` lists `SARVAM_API_KEY=`, `OPENAI_API_KEY=` and `QUOTA_SALT=`. For local development the Developer copies it to `.dev.vars` (ignored by git) and puts `http://localhost:5173` and `http://localhost:8787` in `AI_ALLOWED_ORIGINS`.

## Logging

`logRequest` writes one line of JSON with exactly these fields: `route`, `status`, `code` (error code or `ok`), `provider` (name or `none`), `kind` (the upstream outcome kind or `none`), `ms`, `counted` (boolean). Its argument type has no field that could hold text. A test calls it with every field and checks the output keys are exactly this set. The lint rule against `console` is switched off for `log.ts` only, with a comment.

## Correctness properties

Tests live next to the code; property tests use `fast-check` and the shared seed helper (`assertProperty`), imported by relative path (the `check:deps` test-file exception already allows `packages/shared/test-support`).

- **P1. Total and closed.** For arbitrary method, headers, body bytes (valid JSON, near-valid chat requests with mutated fields, random bytes) and arbitrary fake upstream behavior (statuses, bodies, thrown errors, hostile replies), the app never throws; every response is either a 200 `PublicReplySchema` body or a body `{ error: { code } }` with a code from the closed set and the status of Requirement 1.3; and no response body contains any of the test secrets.
- **P2. Forwarded fields are an allowlist.** For every request that reaches the fake upstream, the body has only the allowed keys, `messages` and `tools` equal the validated input, the token limit is at most the configured clamp under the provider's parameter name and no other token parameter is present, `stream` is `false`, and `temperature` is absent for OpenAI and within 0 to 1 otherwise.
- **P3. Caps hold.** For random sequences of requests (random visitors, random times across several UTC days, random token counts reported by the fake upstream), the number of upstream calls per visitor per day never exceeds the visitor cap, per day never exceeds the daily cap, the lifetime request cap is never exceeded, and no upstream call happens after a token cap was reached (allowing the documented overshoot of one reply). Counters reset on a new UTC date.
- **P4. Fail closed.** Whenever the quota fake or the limiter fake throws, no upstream call happens and the answer is `UPSTREAM_FAILED`.
- **P5. The reply allowlist.** For arbitrary hostile upstream replies, the public reply parses with `PublicReplySchema`, contains no key other than the allowed ones, and contains no text that appears only in the upstream's ignored fields (usage, reasoning, id, headers).
- **P6. Visitor key.** Different IPs on the same day give different keys, the same IP on different days gives different keys, the key is 32 hex characters and never contains the IP.

Example tests (not optional): each error code and status with `Retry-After`; origin cases (missing, wrong, `Sec-Fetch-Site` cross-site, trailing slash in config); size limit by header and by stream; each schema limit; `model` handling; both providers' request adaptation; failover on 429 then success, failover exhausted, no retry on 401; timeouts with fake timers; the three cap kinds and the UTC reset; the 5,000-row overflow; the quota route; kill switch and invalid configuration; the log line fields; CPU budget for a 128 KB body (median of 20 runs under 10 ms in Node, with the measured number printed); a repository scan test for key-shaped strings.

## What this spec does not do

No streaming, no news, no transcription, no share store. It does not deploy: `docs/deployment.md` is a guide, and the Developer runs `wrangler login`, `wrangler secret put` and `wrangler deploy`. It does not change the browser except one test in `apps/web/src/ai/wire.test.ts` that checks the contract.

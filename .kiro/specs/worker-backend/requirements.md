# Requirements Document

## Introduction

This document specifies the first part of the HyperGeist Worker backend: the AI proxy that makes demo mode real. A reviewer opens the app with no key; the browser calls `POST /api/ai/chat` on the app's own origin; the Worker checks the request, applies limits, adds the hosted key (a Cloudflare secret that never reaches the browser), forwards the request to the configured model provider, and returns an OpenAI-shaped reply or a short error. **Providers (decision of the Developer, 2026-11-15, replacing the earlier Groq and Gemini plan):** during development the proxy uses Sarvam (paid credits); for the submission it is switched to OpenAI (about $5 of credit left). Which provider answers is configuration, not code, and the code supports exactly those two now; adding another is one entry in a table. The browser side already exists (`apps/web/src/ai/proxy-provider.ts`, spec `ai-orchestrator`) and falls back to recorded examples when the proxy fails.

**Status: the budget question is settled (paid credits: Sarvam for development, OpenAI for submission). Design and tasks follow. Waiting for the Developer's approval.**

**Dependencies.** `ai-orchestrator` (the client contract in `docs/handoff.md` section 2d), the existing Worker (`apps/worker`: Hono app, static assets, `/api/health`, generic error bodies, no CORS headers). Steering applies: the demo key is a Worker secret and never reaches the browser; validate and size-limit every request body; return generic errors; per-IP rate limit, model allowlist and daily cap; Workers Free plan only (no accounts, no SQL database, no always-on server).

**Out of scope (other specs).** News/RSS fetch, transcription forwarding and the share/remix store (they reuse the helpers built here but have their own specs). The deployment itself: the Developer deploys; this spec writes the deployment guide. Streaming replies. Any user accounts.

**What the platform allows (checked on 2026-11-15 in the Cloudflare docs).** Workers Free: 100,000 requests per day for the whole account, 10 ms CPU time per request (time waiting on the network does not count), 50 subrequests per request. The Rate Limiting binding is approximate and counts per Cloudflare location, with a period of 10 or 60 seconds. SQLite-backed Durable Objects are available on the Free plan (100,000 requests and 100,000 rows written per day, reset at 00:00 UTC). Workers KV is not suitable for counters (the free plan allows 1,000 writes a day).

**What the providers offer (third-party summaries and provider docs read on 2026-11-15, to be re-checked in the dashboards).** Sarvam exposes an OpenAI-compatible chat API at `https://api.sarvam.ai/v2/chat/completions` (`GET /v2/models` lists the model ids a key can use), with tool calls in the reply. OpenAI's cheapest current models are reported at about $0.05 to $0.10 per million input tokens and $0.40 to $0.50 per million output tokens. One AI request from this app is about 4,000 input tokens (tool definitions plus context), so a request costs a few hundredths of a cent on such a model and $5 should cover thousands of requests; hidden reasoning tokens on reasoning models can multiply the output cost several times, so the token budget in Requirement 4 matters more than the request count. OpenAI's newer models use `max_completion_tokens` instead of `max_tokens` and may reject a custom `temperature`; the proxy adapts per provider (Requirement 5).

## Glossary

- **AI_Proxy**: The Worker route group under `/api/ai/` that forwards chat requests to a model provider.
- **Chat_Request**: The JSON body the browser sends: an OpenAI chat-completions body (`model`, `messages`, optional `tools`, `tool_choice`, `temperature`, `max_tokens`, `stream: false`).
- **Upstream**: A model provider the Worker calls with the hosted key, chosen from a fixed table in the code (`sarvam`, `openai`). The table holds each provider's fixed base URL, secret name and request quirks; the base URL is never taken from configuration or from the request, so the Worker cannot be pointed at another host.
- **Quota_Store**: The Durable Object that holds the counters for the daily caps.
- **Visitor_Key**: The string that identifies a visitor for limits: the client IP address from the `CF-Connecting-IP` header, hashed.
- **Daily_Cap**: The maximum number of AI requests the Worker will forward per UTC day, for all visitors together. The **Token_Cap** and the **Lifetime_Cap** are the same idea measured in tokens per day and in total, so the hosted credit cannot be spent faster than planned.
- **Visitor_Cap**: The maximum number of AI requests per Visitor_Key per UTC day.
- **Burst_Limit**: The maximum number of AI requests per Visitor_Key per minute.

## Requirements

### Requirement 1: The chat route

**User Story:** As the app, I want one same-origin route that answers like a chat API, so that demo mode needs no key in the browser.

#### Acceptance Criteria

1. THE Worker SHALL accept `POST /api/ai/chat` with a JSON body and `content-type: application/json`, and SHALL answer `200` with a JSON body in the OpenAI chat-completions reply shape (`choices[0].message` with `content` and optional `tool_calls`, and `finish_reason`).
2. THE Worker SHALL answer every failure with an HTTP error status and the JSON body `{ "error": { "code": "<CODE>" } }`, where `<CODE>` is one of `BAD_REQUEST`, `FORBIDDEN_ORIGIN`, `PAYLOAD_TOO_LARGE`, `RATE_LIMITED`, `DAILY_CAP`, `MODEL_NOT_ALLOWED`, `AI_DISABLED`, `UPSTREAM_FAILED`, `INTERNAL`, and no other field that carries text from the request, the upstream or an exception.
3. THE status codes SHALL be: 400 `BAD_REQUEST`, 403 `FORBIDDEN_ORIGIN`, 413 `PAYLOAD_TOO_LARGE`, 429 `RATE_LIMITED` and `DAILY_CAP` (with a `Retry-After` header in seconds), 400 `MODEL_NOT_ALLOWED`, 503 `AI_DISABLED` and `UPSTREAM_FAILED`, 500 `INTERNAL`; any other method on the route SHALL answer 404 like every unknown route.
4. THE Worker SHALL not stream: it SHALL send `stream: false` upstream and SHALL return one complete reply.
5. THE Worker SHALL add no `access-control-*` header to any response (the app and the Worker share one origin).
6. THE Worker SHALL send `cache-control: no-store` on every `/api/ai/` response.

### Requirement 2: Request validation

**User Story:** As the owner of the hosted key, I want the Worker to reject anything that is not a small, well-formed chat request, so that nobody can use it for something else or run up the bill.

#### Acceptance Criteria

1. THE Worker SHALL reject a request body larger than 128 KB (judged by `content-length` when present and by the bytes actually read), before parsing it, with `PAYLOAD_TOO_LARGE`.
2. THE Worker SHALL parse the body with a strict Zod schema shared with the browser (the schema lives in `packages/shared`, so the browser's `toWireBody` output is tested against the same definition) and SHALL reject unknown top-level fields, a non-object body and invalid JSON with `BAD_REQUEST`.
3. THE Worker SHALL accept at most 60 messages, each with role `system`, `user`, `assistant` or `tool`, string content of at most 40,000 characters, and assistant `tool_calls` of at most 100 entries; at most 12 tools, each a function with a name, a description of at most 2,000 characters and a `parameters` JSON object; `tool_choice` equal to `auto`, `none` or absent; `stream` equal to `false` or absent; and no `n`, `stop`, `logit_bias`, `response_format`, `user` or other field.
4. THE Worker SHALL clamp the client's `max_tokens` to at most `AI_MAX_OUTPUT_TOKENS` (default 2,048, never above 4,096; used when the client sends none) and `temperature` to the range 0 to 1, and SHALL never forward a client-chosen value above those limits.
5. THE Worker SHALL accept the `model` value `auto`, which selects the configured primary and fallback models, and any other value only when it appears in the configured allowlist (`AI_ALLOWED_MODELS`); otherwise it SHALL answer `MODEL_NOT_ALLOWED`.
6. THE Worker SHALL do the validation within the 10 ms CPU limit of the Free plan for a body of the maximum size; a test SHALL measure the validation of a 128 KB body and fail above a stated budget.

### Requirement 3: Same-origin only

**User Story:** As the owner of the hosted key, I want only my own web app to be able to call the proxy from a browser, so that other websites cannot spend my quota.

#### Acceptance Criteria

1. THE Worker SHALL require an `Origin` header on `POST /api/ai/chat` whose value equals one of the configured allowed origins (`AI_ALLOWED_ORIGINS`, a comma-separated list; the deployed URL and, in development, `http://localhost:8787` and `http://localhost:5173`), and SHALL otherwise answer `FORBIDDEN_ORIGIN`.
2. WHEN the `Sec-Fetch-Site` header is present and is not `same-origin`, THE Worker SHALL answer `FORBIDDEN_ORIGIN`.
3. THE Worker SHALL state in its documentation that the origin check stops other websites but not a script that forges headers; the real protection against a script is the per-visitor and daily limits.

### Requirement 4: Limits

**User Story:** As the owner of the hosted key, I want hard limits per visitor, per day and in total, so that the credit lasts through the judging period.

#### Acceptance Criteria

1. THE Worker SHALL apply, in this order and before any upstream call: the Burst_Limit through the Workers Rate Limiting binding (10 requests per 60 seconds per Visitor_Key, set in the binding of `wrangler.jsonc` because the binding's limit cannot be a variable), then the Visitor_Cap, the Daily_Cap, the Token_Cap and the Lifetime_Cap through the Quota_Store.
2. THE Quota_Store SHALL be a SQLite-backed Durable Object, one instance for the whole app, that holds the count of requests and the count of tokens for the global total, for each Visitor_Key for the current UTC day, and for the lifetime of the deployment, and SHALL reset the daily counters at 00:00 UTC.
3. THE limits SHALL be configuration values that can be changed without a code change: `AI_VISITOR_DAILY_CAP` (default 60 requests), `AI_DAILY_CAP` (default 400 requests), `AI_DAILY_TOKEN_CAP` (default 1,000,000 tokens), `AI_LIFETIME_TOKEN_CAP` (default 6,000,000 tokens) and `AI_LIFETIME_CAP` (default 6,000 requests); the guide SHALL show how to size them from the remaining credit (cost per million tokens of the chosen model times the token caps must stay under the credit).
4. THE Quota_Store SHALL count a request only when it is going to be forwarded upstream, and SHALL not count a request that failed validation, the origin check or the Burst_Limit.
5. AFTER a successful upstream reply, THE Worker SHALL read `usage.total_tokens` from it (this value is used only inside the Worker and never returned to the browser) and add it to the token counters; when the reply carries no usage, THE Worker SHALL add an estimate of the request size in characters divided by 3 plus the reply size in characters divided by 3.
6. THE Visitor_Key SHALL be the SHA-256 of `CF-Connecting-IP` plus a daily-rotating salt derived from the secret `QUOTA_SALT` and the UTC date, so that no raw IP address is stored; a missing header SHALL be treated as one shared key `unknown`.
7. THE Quota_Store SHALL keep at most 5,000 visitor rows and SHALL delete rows of past days on each reset, so storage stays small.
8. IF the Quota_Store or the Rate Limiting binding is unavailable or throws, THEN THE Worker SHALL fail closed: it SHALL answer `UPSTREAM_FAILED` (503) without calling the upstream, so the hosted key can never be used without a limit in force.
9. THE Worker SHALL answer `GET /api/ai/quota` with `{ "dailyLimit": n, "dailyUsed": n, "visitorLimit": n, "visitorUsed": n, "resetsAt": "<ISO UTC>" }` (request counts only, never token counts or the provider name) and SHALL apply the same origin check and a Burst_Limit, so the app can show a demo-quota counter in the menu bar; this call SHALL not count against any cap.
10. THE guide SHALL also tell the Developer to set a hard spending limit in the provider's own dashboard (OpenAI project budget) as the last safety line that does not depend on this code.

### Requirement 5: Upstream providers

**User Story:** As a reviewer, I want the demo to keep working when the provider has a hiccup, so that I see an answer.

#### Acceptance Criteria

1. THE Worker SHALL read the ordered list of providers to use from `AI_PROVIDERS` (a comma-separated list of names from the table, default `sarvam`), and SHALL call the first one with its secret (`SARVAM_API_KEY` or `OPENAI_API_KEY`) and its configured model (`AI_SARVAM_MODEL`, `AI_OPENAI_MODEL`), sending the key only in the `Authorization: Bearer` header of that call.
2. THE provider table SHALL hold, for each provider: the fixed endpoint URL (`sarvam`: `https://api.sarvam.ai/v2/chat/completions`; `openai`: `https://api.openai.com/v1/chat/completions`), the name of the token-limit parameter (`max_tokens` for `sarvam`, `max_completion_tokens` for `openai`), whether a custom `temperature` may be sent (not for `openai`), and the way the key is sent (`Authorization: Bearer` for both; Sarvam also accepts its own `api-subscription-key` header, which the Worker sends as well, to be confirmed in the manual check). THE Worker SHALL add `reasoning_effort` to an OpenAI request only when `AI_REASONING_EFFORT` is set to one of `minimal`, `low`, `medium`, `high` (default: not sent, because models that do not reason reject it), and SHALL forward no other field that is not in the shared schema.
3. IF the first provider answers with 429, 5xx, a timeout or an unreadable reply, and a second provider is listed, THEN THE Worker SHALL make one call to the second provider with the same validated request and its own adaptation, and SHALL count the request once against the caps.
4. THE Worker SHALL not retry on 400, 401, 403 or 404 from an Upstream (a configuration or request problem), SHALL treat them as `UPSTREAM_FAILED`, and SHALL keep an internal counter of such failures per provider that the Developer can read in the one log line of Requirement 7.
5. THE Worker SHALL time out each upstream call after 25 seconds and the whole request after 55 seconds.
6. THE Worker SHALL validate the upstream reply with a Zod schema (the reply side of the shared wire schema) and SHALL return to the browser only `choices[0].message.content`, `choices[0].message.tool_calls` (at most 100, each with string name and string arguments) and `finish_reason`, so no upstream field (including usage, ids, reasoning text, headers or error text) reaches the browser.
7. THE Worker SHALL never return an upstream error body, status text or header to the browser.
8. THE Worker SHALL send the same `tools` as the browser sent, and SHALL not add a system message or any text of its own to the conversation.
9. THE configured model names SHALL be configuration values and not code, because provider model names change; the guide SHALL tell the Developer to confirm, before relying on a model, that it supports tool calls (the capability check of `ai-orchestrator` and the checklist in `docs/manual-verification-ai.md` cover this), and to use `GET /v2/models` for Sarvam.

### Requirement 6: Secrets and configuration

**User Story:** As the Developer, I want the keys kept out of the repository and the browser, so that publishing the repository is safe.

#### Acceptance Criteria

1. THE secrets `SARVAM_API_KEY`, `OPENAI_API_KEY` and `QUOTA_SALT` SHALL be set with `wrangler secret put` and SHALL never appear in `wrangler.jsonc`, in the repository, in a log line, in an error body or in a test fixture.
2. THE non-secret configuration (`AI_ENABLED`, `AI_ALLOWED_ORIGINS`, `AI_ALLOWED_MODELS`, `AI_PROVIDERS`, `AI_SARVAM_MODEL`, `AI_OPENAI_MODEL`, the cap values of Requirement 4, `AI_MAX_OUTPUT_TOKENS`, `AI_REASONING_EFFORT`) SHALL be `vars` in `wrangler.jsonc` with safe defaults, and the Worker SHALL parse them with a Zod schema on each request and SHALL treat an invalid value as `AI_DISABLED`.
3. THE variable `AI_ENABLED` set to `false`, a missing secret for the first listed provider, or an unknown provider name SHALL make every chat call answer `AI_DISABLED` without calling an upstream: a kill switch the Developer can use from the dashboard.
4. THE repository SHALL contain `.dev.vars.example` with names only, and `.dev.vars` SHALL be in `.gitignore` (it already is).
5. A test SHALL scan the repository sources and fixtures for strings that look like a Sarvam, OpenAI, Groq or Gemini key and SHALL fail on a match.
6. SWITCHING from Sarvam to OpenAI for the submission SHALL need only: setting the `OPENAI_API_KEY` secret, changing `AI_PROVIDERS` to `openai` and `AI_OPENAI_MODEL` to the chosen model, and redeploying; the guide SHALL list exactly these steps.

### Requirement 7: Privacy and observability

**User Story:** As a reviewer, I want to know what the demo sends and keeps, so that I can decide whether to use it.

#### Acceptance Criteria

1. THE Worker SHALL not log or store any message content, tool argument or reply text.
2. THE Worker SHALL write at most one log line per request, containing only: the route, the status code, the error code, which Upstream answered, the duration in milliseconds, and whether the request was counted; and SHALL write no log line that contains a header, an IP address or a key.
3. THE Quota_Store SHALL keep only counters, with hashed visitor keys, and nothing else.
4. THE app's Limits text (a later change in `ai-assistant-ui`) SHALL say that, in demo mode, the stack and the message go through the app's server to a hosted model provider, and name the provider that is configured at submission time, with a link to that provider's data-use terms (the terms differ by provider and plan, and are to be checked and stated by the Developer before submission).

### Requirement 8: Reuse for later routes

**User Story:** As the Developer, I want the plumbing written once, so that the news, transcription and share routes do not repeat it.

#### Acceptance Criteria

1. THE Worker SHALL put the origin check, the body-size limit, the error-body builder, the configuration parser and the visitor-key function in small modules under `apps/worker/src/lib/`, each with its own tests, and the AI routes SHALL use them.
2. THE module for the error body SHALL be the only place that builds an error response, so no route can put request or upstream text into one.

### Requirement 9: Verification and deployment

**User Story:** As the Developer, I want the proxy proven against a fake upstream, and a deployment guide I can follow, so that nothing is a surprise on the day.

#### Acceptance Criteria

1. THE tests SHALL run through `app.request(path, init, env)` with fake bindings (Rate Limiting, Quota_Store) and a fake upstream `fetch`; no test SHALL call a real provider or the network, and no new dependency SHALL be added.
2. THE tests SHALL cover each error code and status of Requirement 1, each limit of Requirement 2, the origin rules, burst, visitor and daily caps with the UTC reset, fail-closed behavior, the failover from the first to the second listed provider, the per-provider request adaptation (parameter name, temperature, extra field), the no-retry statuses, the reply allowlist, the kill switch, and invalid configuration.
3. Property tests with fast-check SHALL show that, for arbitrary request bodies, headers and fake upstream replies (including hostile ones), the Worker never throws, answers only with the codes of Requirement 1, never forwards a field outside the allowed list, never sends more than the clamped token limit (under the parameter name the provider uses), never lets a key appear in a response, and never makes an upstream call once a cap is reached.
4. THE spec SHALL produce `docs/deployment.md` with the steps the Developer runs: creating the Cloudflare account resources, `wrangler secret put` for the secrets, setting the vars, `wrangler deploy`, the smoke test commands (`curl` examples for health, quota and chat), where to read the logs, and how to use the kill switch; and `docs/manual-verification-worker.md` with the checks to do on the deployed URL.
5. THE Developer SHALL deploy; no task SHALL run `wrangler deploy` or `wrangler secret put`, and no task SHALL read or print a secret.

## Decisions (settled, 2026-11-15)

1. **Providers and budget.** Development uses Sarvam (paid credits), the submission uses OpenAI (about $5 of credit left). No free-tier plan and no Groq or Gemini in this spec. The Worker caps requests and tokens so that the credit cannot be spent faster than planned, and the recorded fallback of `ai-orchestrator` takes over when a cap is reached.
2. **Steering change.** The locked tech stack line "Providers: Groq primary, Gemini fallback" is replaced by "Sarvam for development, OpenAI for the submission, behind one OpenAI-compatible adapter" at the Developer's direction.

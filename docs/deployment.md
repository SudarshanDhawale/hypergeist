# Deployment guide: the AI proxy Worker

This guide is for the Developer. It covers running the Worker on your machine, the first deploy to Cloudflare, the secrets, the limits, the switch from Sarvam to OpenAI, and what to check before the submission. Spec: `.kiro/specs/worker-backend`.

The proxy is **not deployed** until you run these steps. No spec task deploys, sets a secret or reads a secret.

Facts about Cloudflare and Sarvam were read in their docs on 2026-11-16. Prices, model names, dashboard labels and plan limits change. **Check the provider page on the day** for every price and model name in this file.

## Never paste a key

- Never paste an API key into a chat, a file in the repository, a commit, a log line or a shell command that you type with the key in it.
- Keys go in only three ways: `wrangler secret put` (hidden prompt or a pipe), the untracked file `apps/worker/.dev.vars` (edit it in an editor), and a shell variable that you fill with `read -s` and then `unset`.
- If a key leaks, revoke it in the provider's dashboard first. Then create a new key and run `wrangler secret put` again.

## What is configuration and what is a secret

Run every command in this file from `apps/worker`, unless it says otherwise. Wrangler is a dev dependency of that package, so use `pnpm exec wrangler ...`.

| Name                                 | Kind   | Default (in `wrangler.jsonc`)                 | Meaning                                                                              |
| ------------------------------------ | ------ | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `SARVAM_API_KEY`, `OPENAI_API_KEY`   | secret | none                                          | Provider keys. Only the keys of the listed providers are needed.                     |
| `QUOTA_SALT`                         | secret | none                                          | Salt for the visitor key. Required, or every chat call answers `AI_DISABLED`.        |
| `AI_ENABLED`                         | var    | `true`                                        | `false` is the kill switch.                                                          |
| `AI_ALLOWED_ORIGINS`                 | var    | `http://localhost:8787,http://localhost:5173` | Comma-separated exact origins. Add the deployed URL.                                 |
| `AI_ALLOWED_MODELS`                  | var    | empty                                         | Extra model names a client may ask for besides `auto`. Leave empty.                  |
| `AI_PROVIDERS`                       | var    | `sarvam`                                      | Ordered list from `sarvam`, `openai`. The first is called, the second is a fallback. |
| `AI_SARVAM_MODEL`, `AI_OPENAI_MODEL` | var    | empty                                         | Model ids. Empty means the AI stays off.                                             |
| `AI_VISITOR_DAILY_CAP`               | var    | `60`                                          | Requests per visitor per UTC day.                                                    |
| `AI_DAILY_CAP`                       | var    | `400`                                         | Requests per UTC day, all visitors.                                                  |
| `AI_DAILY_TOKEN_CAP`                 | var    | `1000000`                                     | Tokens per UTC day.                                                                  |
| `AI_LIFETIME_CAP`                    | var    | `6000`                                        | Requests, ever.                                                                      |
| `AI_LIFETIME_TOKEN_CAP`              | var    | `6000000`                                     | Tokens, ever.                                                                        |
| `AI_MAX_OUTPUT_TOKENS`               | var    | `2048`                                        | Output limit per request. From 1 to 4096.                                            |
| `AI_REASONING_EFFORT`                | var    | empty                                         | OpenAI only: `minimal`, `low`, `medium` or `high`. Empty means not sent.             |

The burst limit (10 requests per 60 seconds per visitor) is in the `ratelimits` binding of `wrangler.jsonc`. It cannot be a variable.

The Worker reads the variables on every request. A bad value does not crash it. It makes every chat call answer `AI_DISABLED`, and the answer never says which value is wrong (see section 14).

Each cap value is a whole number from 1 to 10,000,000. `AI_ALLOWED_ORIGINS` entries must be `https://host` or `http://localhost` / `http://127.0.0.1` (with an optional port), in lower case, with no path and no trailing slash.

## 1. Prerequisites

1. A Cloudflare account on the free plan.
2. Node and pnpm as in the root `package.json` (`node >=22.18.0 <25`, `pnpm@12.18.0`).
3. Dependencies installed and the web app built, from the repository root:

   ```sh
   pnpm install
   pnpm build
   ```

   `wrangler.jsonc` serves the built web app from `apps/web/dist`, so deploy needs that folder. The `build` script of the Worker package runs `wrangler deploy --dry-run`. It does not deploy.

4. A Sarvam account with credit, and an API key from its dashboard.
5. Log in to Cloudflare once. This opens a browser:

   ```sh
   cd apps/worker
   pnpm exec wrangler login
   ```

## 2. Run it locally

1. Copy the example file. `.dev.vars` is in `.gitignore`.

   ```sh
   cd apps/worker
   cp .dev.vars.example .dev.vars
   ```

2. Open `apps/worker/.dev.vars` in an editor and fill in the values. Type nothing secret in the terminal.
   - `SARVAM_API_KEY=` your Sarvam key.
   - `QUOTA_SALT=` a random value. Make one with `openssl rand -hex 32`, copy it, and paste it after the `=`.
   - `AI_SARVAM_MODEL=` a model id (see section 4 for how to list them). Remove the `#` at the start of that line.
3. Start the Worker from the repository root. It listens on port 8787:

   ```sh
   pnpm --filter @hypergeist/worker dev
   ```

   The Worker serves the last built copy of the web app, so run `pnpm build` first if `apps/web/dist` is missing.

4. In a second terminal, call it. Chat needs an `Origin` header. Quota needs either an `Origin` or, as a browser does for a same-origin `GET`, `Sec-Fetch-Site: same-origin` with no `Origin`. `curl` sends neither, so add them:

   ```sh
   curl -i http://localhost:8787/api/health

   curl -i -H 'Sec-Fetch-Site: same-origin' http://localhost:8787/api/ai/quota

   curl -i http://localhost:8787/api/ai/chat \
     -H 'Origin: http://localhost:8787' \
     -H 'content-type: application/json' \
     -d '{"model":"auto","messages":[{"role":"user","content":"Say hello in three words."}]}'
   ```

   Expected:
   - Health answers `200` with `{"ok":true}`.
   - Quota answers `200` with `dailyLimit`, `dailyUsed`, `visitorLimit`, `visitorUsed` and `resetsAt`.
   - Chat answers `200` with `{"choices":[{"message":{"role":"assistant","content":"..."},"finish_reason":"stop"}]}`. Nothing else is in the body.

If chat answers `503` with `{"error":{"code":"AI_DISABLED"}}`, the configuration is incomplete. See section 14.

`.dev.vars` values are used by `wrangler dev` in place of the `vars` of `wrangler.jsonc`, according to the comments in `.dev.vars.example`. If you later change `AI_ALLOWED_ORIGINS` in `wrangler.jsonc` to the deployed URL (section 4), put `AI_ALLOWED_ORIGINS=http://localhost:8787,http://localhost:5173` in `.dev.vars` so local calls still pass. If a local call answers `FORBIDDEN_ORIGIN` after that, the override did not apply: record it and keep the localhost origins in `wrangler.jsonc` while you test locally.

With the Vite dev server (`pnpm --filter @hypergeist/web dev`, port 5173), the browser sends `Origin: http://localhost:5173`. That is why both localhost origins are in the default list.

## 3. First deploy

```sh
cd apps/worker
pnpm exec wrangler deploy
```

Wrangler may ask you to register a `workers.dev` subdomain the first time. At the end it prints the URL, in the form `https://hypergeist.<your-subdomain>.workers.dev` (`hypergeist` is the `name` in `wrangler.jsonc`). Save it in a shell variable and use it below:

```sh
export APP=https://hypergeist.<your-subdomain>.workers.dev
curl -i $APP/api/health
```

Expected: `200` and `{"ok":true}`. At this point the AI is off. There are no secrets and no model id yet, so chat answers `AI_DISABLED`. That is the safe state.

The deploy also creates the Durable Object class `QuotaStore` (migration `v1`, SQLite-backed, as the free plan requires) and the rate-limit binding `AI_BURST` with `namespace_id` `1001`. If the deploy fails on the namespace id, record the error text and pick another number in `wrangler.jsonc`. This was not tried against a real account.

## 4. Choose the model, set the origin, edit `wrangler.jsonc`

Edit `apps/worker/wrangler.jsonc` in the `vars` block. None of these values is secret, so it is fine to commit them.

1. **Origin.** Set `AI_ALLOWED_ORIGINS` to the deployed URL from section 3, with no trailing slash:

   ```jsonc
   "AI_ALLOWED_ORIGINS": "https://hypergeist.<your-subdomain>.workers.dev",
   ```

   Keep the two localhost origins out of production. They are only useful for local work, and `.dev.vars` can supply them locally (section 2). A localhost origin in production does not open a hole that a forged header would not already open, but it has no use there.

2. **Sarvam model id.** List the models your key can use. Read the key into a variable without echoing it, call the API, then remove the variable:

   ```sh
   read -s "SARVAM_API_KEY?Sarvam key: "
   export SARVAM_API_KEY
   curl -sS -H "api-subscription-key: $SARVAM_API_KEY" https://api.sarvam.ai/v2/models
   unset SARVAM_API_KEY
   ```

   (`read -s "SARVAM_API_KEY?Sarvam key: "` is the zsh form. In bash use `read -s -p "Sarvam key: " SARVAM_API_KEY`.) The reply is JSON with a `data` array. Each entry has an `id`. Models with `"access": "provisioned"` need extra access on your account.

   Sarvam's docs say both the `api-subscription-key` header and `Authorization: Bearer` are accepted. The Worker sends both. Whether Bearer alone works is a manual check (case W-22 in `docs/manual-verification-worker.md`).

   Pick a model that supports tool calls (the app needs them). Check the model's page in the Sarvam docs. Then set the id:

   ```jsonc
   "AI_SARVAM_MODEL": "<model id from the list>",
   ```

   The Worker sends no `reasoning_effort` to Sarvam. A model that reasons by default spends part of the output limit on reasoning, and may answer with empty text and `finish_reason: "length"`. Check this with case W-26.

3. Leave the cap variables at their defaults for now. Size them in section 10.

## 5. Set the secrets

Secrets never go in `wrangler.jsonc`. From `apps/worker`:

1. The Sarvam key. Wrangler asks for the value with a hidden prompt. Paste the key there:

   ```sh
   pnpm exec wrangler secret put SARVAM_API_KEY
   ```

2. The salt. Generate it and pipe it in, so it is never printed or typed:

   ```sh
   openssl rand -hex 32 | pnpm exec wrangler secret put QUOTA_SALT
   ```

   The salt is part of the visitor key. Do not change it later to "reset" caps: changing it makes every visitor look new for the rest of the day, so the per-visitor cap can be used again. The daily and lifetime caps are not affected.

3. Check the names (values are never shown):

   ```sh
   pnpm exec wrangler secret list
   ```

   `OPENAI_API_KEY` comes later, in section 12.

## 6. Redeploy

```sh
cd apps/worker
pnpm exec wrangler deploy
```

This applies the new `vars`. (Secrets from `wrangler secret put` already apply.)

## 7. Smoke tests on the deployed URL

With `APP` set as in section 3. For chat, the `Origin` header must be exactly the deployed URL. For quota, the example sends what a browser sends for a same-origin `GET`: no `Origin`, and `Sec-Fetch-Site: same-origin`. A script can forge both headers (section 13).

```sh
# 1. Health
curl -i $APP/api/health

# 2. Quota
curl -i -H 'Sec-Fetch-Site: same-origin' $APP/api/ai/quota

# 3. Chat
curl -i $APP/api/ai/chat \
  -H "Origin: $APP" \
  -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello in three words."}]}'

# 4. Chat with no Origin: must be refused
curl -i $APP/api/ai/chat -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
```

Expected:

1. `200` and `{"ok":true}`.
2. `200` with `dailyLimit` 400, `dailyUsed` 0 (or the number so far), `visitorLimit` 60, `visitorUsed`, and `resetsAt` as an ISO time at 00:00:00 UTC. The headers include `cache-control: no-store` and no `access-control-*` header.
3. `200` with only `choices[0].message` (`role`, `content`, maybe `tool_calls`) and `finish_reason`. No `usage`, `id` or `model` field.
4. `403` with `{"error":{"code":"FORBIDDEN_ORIGIN"}}`.

Then work through `docs/manual-verification-worker.md`.

Every error answer has the body `{"error":{"code":"<CODE>"}}` and nothing else:

| Status | Code                | When                                                                                                                           |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `BAD_REQUEST`       | Not JSON, wrong content type, unknown field, schema limit broken.                                                              |
| 400    | `MODEL_NOT_ALLOWED` | `model` is not `auto` and not in `AI_ALLOWED_MODELS`.                                                                          |
| 403    | `FORBIDDEN_ORIGIN`  | `Origin` missing or not allowed (except a same-origin `GET`/`HEAD`, see section 13), or `Sec-Fetch-Site` is not `same-origin`. |
| 413    | `PAYLOAD_TOO_LARGE` | Body over 128 KB (131,072 bytes).                                                                                              |
| 429    | `RATE_LIMITED`      | More than 10 requests in 60 seconds. `Retry-After: 60`.                                                                        |
| 429    | `DAILY_CAP`         | A visitor, daily, token or lifetime cap is reached. `Retry-After` is the seconds to 00:00 UTC.                                 |
| 503    | `AI_DISABLED`       | Kill switch, bad configuration, or a missing key, model or salt.                                                               |
| 503    | `UPSTREAM_FAILED`   | Provider failed or refused, or the limiter or counter store was unavailable (fail closed).                                     |
| 500    | `INTERNAL`          | Unexpected error inside the Worker.                                                                                            |

Any other method or path under `/api/ai/` answers `404` with `{"error":"Not found"}`.

## 8. Read the logs

```sh
cd apps/worker
pnpm exec wrangler tail --format json
```

Send a request from another terminal. The Worker writes one JSON line per request, with exactly these fields:

```json
{
  "route": "chat",
  "status": 200,
  "code": "ok",
  "provider": "sarvam",
  "kind": "ok",
  "ms": 2310,
  "counted": true
}
```

- `route` is `chat` or `quota`.
- `code` is `ok` or one of the error codes.
- `provider` is the provider that was called last, or `none` when the request stopped before a provider call.
- `kind` is the provider outcome: `ok`, `empty-length` (empty answer with `finish_reason: "length"`), `http-4xx`, `rate-limited`, `http-5xx`, `timeout`, `network`, `bad-reply`, `aborted`, or `none`.
- `counted` is `true` when the request was counted against the caps. A request that the provider then refused is still counted.

`kind: http-4xx` means the provider refused the request (a wrong model id, a bad key or no credit). It does not say which, so check the provider's dashboard. The Worker never retries a 400, 401, 403 or 404 from a provider.

The line has no message text, no IP address and no key. `wrangler tail` also prints Cloudflare's own event data (URL, method, status) around the Worker's lines. Only the `logs` entries come from the Worker.

## 9. The kill switch

Use one of these. All of them make chat and quota answer `503` `AI_DISABLED` and stop all provider calls. The app falls back to its recorded examples. `/api/health` and the static app keep working.

1. **Fastest, no redeploy.** Delete the secret of a listed provider. A listed provider without its key makes the configuration invalid:

   ```sh
   cd apps/worker
   pnpm exec wrangler secret delete SARVAM_API_KEY
   ```

   To turn the AI back on, run `wrangler secret put SARVAM_API_KEY` again.

2. **The switch itself.** Set `"AI_ENABLED": "false"` in `wrangler.jsonc` and run `pnpm exec wrangler deploy`. Set it back to `"true"` and redeploy to turn the AI on.

3. **In the dashboard.** In the Cloudflare dashboard open Workers & Pages, choose the Worker, then Settings, then Variables and Secrets. Set `AI_ENABLED` to `false` and select Deploy. The labels come from the Cloudflare docs of 2026-11-16 and may change. Whether the dashboard can edit a variable that `wrangler.jsonc` defines, and whether the next `wrangler deploy` overwrites it with the file's value, was not checked. Treat `wrangler.jsonc` as the source of truth, and put the same value in the file.

Check that it works by calling chat: the answer must be `AI_DISABLED`, and the provider's usage page must show no new request.

## 10. Size the caps from the credit

The caps protect the credit. The Worker adds `usage.total_tokens` of each reply to the token counters, and denies the next request once a cap is reached. One reply can go over the cap, and several requests in flight at the same time can each go over. The overshoot is a few replies.

**Rule.** Cost is tokens divided by 1,000,000, times the price per million tokens. The Worker counts input and output tokens together, so use the **output price** (the higher one) for all of them. Then:

```
lifetime token cap  <=  credit / (2 x output price per million) x 1,000,000
```

The 2 is a safety factor. It covers the overshoot, price changes and tokens the provider counts that the reply did not report, such as hidden reasoning tokens. A reasoning model bills those as output tokens.

**Worked example: $5 of OpenAI credit.** These prices are examples only. **Check the provider page on the day**, and use the real model name and prices.

| Item                                     | Example value                           |
| ---------------------------------------- | --------------------------------------- |
| Credit                                   | $5.00                                   |
| Input price (example)                    | $0.10 per million tokens                |
| Output price (example)                   | $0.40 per million tokens                |
| One app request (estimate from the spec) | about 4,000 input and 500 output tokens |

- Real cost of one request: 4,000 x 0.10 / 1,000,000 = $0.0004, plus 500 x 0.40 / 1,000,000 = $0.0002. Total $0.0006. Over $5 that is about 8,000 requests.
- Worst case of the lifetime token cap at the default 6,000,000: 6,000,000 x 0.40 / 1,000,000 = $2.40. With the safety factor of 2: $4.80. That is under $5, so the default is acceptable at these prices.
- With an output price of $0.50 per million the same cap costs $3.00, and $6.00 with the safety factor. That is over $5. The rule gives 5 / (2 x 0.50) x 1,000,000 = 5,000,000. Set `AI_LIFETIME_TOKEN_CAP` to `5000000`.
- At about 4,500 tokens per request, 6,000,000 tokens is about 1,300 requests. The lifetime request cap of 6,000 does not bind first. The token caps are the real limit.
- Daily token cap: spread the lifetime budget over the days the judges may use the demo. For example, if you expect about 10 days, 6,000,000 / 10 = 600,000. Set `AI_DAILY_TOKEN_CAP` to `600000`. The default of 1,000,000 would let the budget go in about six days.
- One AI Turn in the app can use up to 8 requests. The visitor cap of 60 allows 7 or more Turns per visitor per day. The burst limit of 10 per minute can stop a second Turn that starts within a minute.

**Sarvam.** Sarvam lists prices in rupees per million tokens. On the page read on 2026-11-16, `sarvam-105b` was ₹15 for input and ₹60 for output, and a new verified user got ₹100 of free credit. **Check the provider page on the day.** Use the same rule with the output price.

**Two things you cannot see.**

- The lifetime counters never reset, and no command reads them. The quota endpoint shows request counts for the day only. Your own test requests and your Sarvam development traffic count against the lifetime caps. Estimate what you used from the provider's usage page, and when you switch providers set the lifetime caps to "used so far" plus the new budget.
- The Worker cannot see a price. Only the provider's dashboard shows what you really spent. Compare the two after the manual checks (case W-27).

Edit the cap values in `wrangler.jsonc` and run `wrangler deploy`.

## 11. Set a hard spending limit at the provider

The caps are code that you wrote. Add a limit that does not depend on that code.

For OpenAI:

1. Create a separate project in the OpenAI dashboard just for this app. Create the API key inside that project.
2. Add the $5 as prepaid credit and keep auto-recharge off, so the key cannot spend more than the balance.
3. In the project's limits, set a monthly budget below the credit.
4. Read what that setting does. Some budget settings only send an email and do not block requests. If it only sends an email, the prepaid balance with no auto-recharge is your hard limit.

The names of these settings change. **Check the provider page on the day.** For Sarvam, the free credit and the top-ups you made are the limit. Do not set up automatic top-ups.

## 12. Switch to OpenAI for the submission

These are exactly the steps of Requirement 6.6. Run them from `apps/worker`.

1. Set the OpenAI key:

   ```sh
   pnpm exec wrangler secret put OPENAI_API_KEY
   ```

2. In `wrangler.jsonc` set:

   ```jsonc
   "AI_PROVIDERS": "openai",
   "AI_OPENAI_MODEL": "<the OpenAI model id>",
   ```

   Choose a model that supports tool calls and that fits your credit (section 10). Check the model name and price on the OpenAI page on the day. Optional: set `"AI_REASONING_EFFORT"` to `minimal`, `low`, `medium` or `high` for a reasoning model. It is sent only to OpenAI. Leave it empty for a model that does not reason, because such a model rejects the field.

3. Set the lifetime and daily token caps for the new credit (section 10).
4. Redeploy:

   ```sh
   pnpm exec wrangler deploy
   ```

5. Run the cases of `docs/manual-verification-worker.md` that involve the provider (W-20 to W-28). Pay attention to W-26: a reasoning model may spend the whole output limit on reasoning.

What changes for OpenAI requests: the Worker sends `max_completion_tokens` instead of `max_tokens`, and sends no `temperature`. Nothing else changes. To keep Sarvam as a fallback, set `AI_PROVIDERS` to `openai,sarvam` and keep both secrets and both model ids. The second provider is called only after a 429, a 5xx, a timeout or an unreadable reply from the first.

## 13. What the origin check does and does not stop

**It stops** other websites. A page on another site cannot call the proxy from a visitor's browser:

- The browser adds `Origin` itself, and a page cannot change it. The Worker accepts only the exact origins in `AI_ALLOWED_ORIGINS`.
- If the browser sends `Sec-Fetch-Site`, it must be `same-origin`.
- A browser sends no `Origin` on a same-origin `GET` or `HEAD`. For those two methods only (the quota route), a request with no `Origin` passes when `Sec-Fetch-Site` is present and equals `same-origin`. A `POST` (the chat route) always needs a matching `Origin`. With no `Origin` and no `Sec-Fetch-Site`, every method is refused.
- The Worker sends no `access-control-*` header. A browser blocks a cross-origin page from reading the answer. A JSON request from another origin also needs a preflight, which the Worker answers with `404`.

**It does not stop** a script. Anyone can run `curl` with `-H 'Origin: <your URL>'`, or for quota with `-H 'Sec-Fetch-Site: same-origin'`. Your URL is public. The check cannot tell a script from your app.

What does limit a script:

- The burst limit: 10 requests per minute per visitor.
- The visitor cap: 60 requests per UTC day per visitor. The visitor is the hashed `CF-Connecting-IP`. Cloudflare sets that header, so the script cannot forge it. People behind one network address share one visitor.
- The daily request and token caps, and the lifetime caps, for everyone together.
- The spending limit at the provider (section 11).

A script that uses many addresses can still use up the daily cap. Then the app falls back to its recorded examples for everyone until 00:00 UTC. The caps keep the damage to the credit you set. They do not keep the demo available.

## 14. If a call fails

**Every chat call says `AI_DISABLED`.** The Worker does not say why. Check, in this order:

1. `AI_ENABLED` is not `false`.
2. `pnpm exec wrangler secret list` shows `QUOTA_SALT` and the key of every provider in `AI_PROVIDERS`.
3. The model var of every listed provider is set and has no spaces. An empty `AI_SARVAM_MODEL` is the default and keeps the AI off.
4. `AI_PROVIDERS` holds only `sarvam` and `openai`, once each, separated by commas.
5. `AI_ALLOWED_ORIGINS` has at least one entry, and every entry is a bare origin: lower case, no path, no trailing slash, no default port, `https` (or `http` for localhost).
6. Every cap is a whole number from 1 to 10,000,000, and `AI_MAX_OUTPUT_TOKENS` is from 1 to 4096.
7. `AI_REASONING_EFFORT` is empty or one of `minimal`, `low`, `medium`, `high`.

**`UPSTREAM_FAILED`.** Run `wrangler tail`. If `provider` is `none`, the rate limiter or the counter store failed, and the Worker refused to call the provider. If `provider` is set, read `kind`. A `http-4xx` means the provider refused: check the model id, the key and the credit.

**`DAILY_CAP` right after deploy.** A cap value is too low, or the lifetime counters from earlier tests have reached the lifetime cap. Raise the cap (section 10).

## 15. Before submission

- [ ] The Worker uses OpenAI (section 12) and `docs/manual-verification-worker.md` is signed off, including W-20 to W-28.
- [ ] `AI_ALLOWED_ORIGINS` holds the final public URL, and no localhost origin.
- [ ] The caps were sized from the real credit and the real prices (section 10), and the lifetime caps account for earlier test traffic.
- [ ] A spending limit or a prepaid balance with no auto-recharge is set at OpenAI (section 11).
- [ ] You tried the kill switch (section 9) and know which of the three ways you will use.
- [ ] `git diff` and `git log -p` show no key, no `.dev.vars` and no `QUOTA_SALT` value (case W-30).
- [ ] The temporary test file of the manual checklist is deleted, and no key is left in a shell variable (`unset`).
- [ ] The app's Limits text names the provider that is configured at submission time, says that in demo mode the stack and the message go through the app's server to that provider, and links to the provider's data-use terms. Check the terms yourself before you state them. This text belongs to the later `ai-assistant-ui` spec.
- [ ] The README says the demo is limited, and that the recorded examples take over when a cap is reached.
- [ ] Look at the provider's usage page once a day during judging.

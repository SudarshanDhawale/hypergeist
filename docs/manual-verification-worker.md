# Manual verification: Worker AI proxy

Spec: `.kiro/specs/worker-backend` (Requirement 9.4). Do this list on the deployed Worker, after the steps of `docs/deployment.md`. The automated tests use a fake provider, a fake rate limiter and an in-memory counter, so they cannot prove how the real services behave.

The cases that need a real provider are W-20 to W-28. Do them first with Sarvam, then again after the switch to OpenAI (deployment guide, section 12). Write the provider and model in the Result column.

## How to use this file

**Never put a key in a file. Never paste a key into chat.** None of the cases below needs you to type a key. The Worker holds the keys. Case W-22 reads a Sarvam key from a shell variable that you fill with `read -s`.

**Shell variables.** Run these once in a terminal at the repository root. Replace the URL with the one that `wrangler deploy` printed.

```sh
export APP=https://hypergeist.<your-subdomain>.workers.dev
export BODY='{"model":"auto","messages":[{"role":"user","content":"Say hello in three words."}]}'
export SMALL='{"model":"auto","messages":[{"role":"user","content":"Say hi."}],"max_tokens":16}'
export TOOLBODY='{"model":"auto","messages":[{"role":"user","content":"Add 2 and 3 with the tool."}],"tools":[{"type":"function","function":{"name":"add","description":"Add two numbers.","parameters":{"type":"object","properties":{"a":{"type":"number"},"b":{"type":"number"}},"required":["a","b"]}}}],"tool_choice":"auto"}'

# hg_chat [body]: POST to the proxy with the right Origin. Prints the status line, the headers and the body.
hg_chat() { curl -sS -i -H "Origin: $APP" -H 'content-type: application/json' -d "${1:-$BODY}" "$APP/api/ai/chat"; }
# hg_quota: GET the quota numbers the way a browser does for a same-origin GET: no Origin, Sec-Fetch-Site: same-origin.
hg_quota() { curl -sS -i -H 'Sec-Fetch-Site: same-origin' "$APP/api/ai/quota"; }
```

A browser sends no `Origin` header on a same-origin `GET`, so the quota route accepts a `GET` or `HEAD` with no `Origin` when `Sec-Fetch-Site` is `same-origin`. `curl` sends neither header, so `hg_quota` adds `Sec-Fetch-Site` by hand. A script can forge this header just as it can forge `Origin`: the check is not a defence against scripts (see deployment guide section 13). The chat route (`POST`) always needs a matching `Origin`.

These work in zsh and bash. Every request that reaches the provider costs a little credit. `BODY` and `TOOLBODY` use the default output limit (2,048 tokens). `SMALL` limits the answer to 16 tokens.

**Prepared commands** that some cases refer to:

- `BIG`: a body over 128 KB. Create it, use it, delete it:

  ```sh
  python3 -c "import sys; sys.stdout.write('{\"model\":\"auto\",\"messages\":[{\"role\":\"user\",\"content\":\"' + 'a'*140000 + '\"}]}')" > /tmp/hg-big.json
  curl -sS -i -H "Origin: $APP" -H 'content-type: application/json' --data-binary @/tmp/hg-big.json "$APP/api/ai/chat"
  rm /tmp/hg-big.json
  ```

- `LOOP`: 12 calls in a row for the burst limit. It prints the call number and the status:

  ```sh
  for i in $(seq 1 12); do curl -sS -o /dev/null -w "$i %{http_code}\n" -H "Origin: $APP" -H 'content-type: application/json' -d "$SMALL" "$APP/api/ai/chat"; done
  ```

- `CHATAS`: a chat call with an `Origin` you choose. Define it once, then call `hg_chatas <origin>`:

  ```sh
  hg_chatas() { curl -sS -i -H "Origin: $1" -H 'content-type: application/json' -d "$BODY" "$APP/api/ai/chat"; }
  ```

- `CROSSSITE`: a chat call with the right `Origin` and the header that a browser sends for a call from another site:

  ```sh
  curl -sS -i -H "Origin: $APP" -H 'Sec-Fetch-Site: cross-site' -H 'content-type: application/json' -d "$BODY" "$APP/api/ai/chat"
  ```

- `SECRETSCAN`: run from the repository root. The expected output of each line is in W-30:

  ```sh
  git ls-files apps/worker/.dev.vars
  git check-ignore -v apps/worker/.dev.vars
  git log --all --oneline -G'sk-[A-Za-z0-9_-]{20,}'
  git log --all --oneline -G'sk_[A-Za-z0-9]{10,}'
  git log --all --oneline -G'gsk_'
  git log --all --oneline -G'AIza'
  grep -nE 'API_KEY|QUOTA_SALT' apps/worker/wrangler.jsonc
  ```

- `CONSOLE_SAME`: run it in the DevTools console of a tab that shows the deployed app:

  ```js
  fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'auto',
      messages: [{ role: 'user', content: 'Say hello in three words.' }],
    }),
  })
    .then((r) => r.json())
    .then(console.log, console.error);
  ```

- `CONSOLE_OTHER`: run it in the console of a tab on any other website (for example `https://example.com`), with your real URL in place of the placeholder. If that site's own security policy blocks the call, use another site:

  ```js
  fetch('https://hypergeist.<your-subdomain>.workers.dev/api/ai/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
    .then(
      (r) => r.status,
      (e) => String(e),
    )
    .then(console.log);
  ```

**Read the logs.** In a second terminal keep `cd apps/worker && pnpm exec wrangler tail --format json` running while you work. The Worker's own line has the keys `route`, `status`, `code`, `provider`, `kind`, `ms` and `counted`. Wrangler prints other event data around it.

**Change a variable for a case.** Edit the value in `apps/worker/wrangler.jsonc`, run `cd apps/worker && pnpm exec wrangler deploy`, do the case, put the old value back and deploy again. Write the restored value in the Result column so you do not forget it. After a restore, call `hg_quota` and check the limits.

**Order.** Run the cases in order inside a group. The counters carry over from case to case. Lifetime counters never reset, so your test requests count against the lifetime caps (deployment guide, section 10).

**How to read the cases.**

- Write **Pass**, **Fail** or a short note in the Result column. Name the provider and model for W-20 to W-28.
- Error answers have exactly the body `{"error":{"code":"<CODE>"}}`. The status in "Expected" comes from `apps/worker/src/lib/errors.ts`.
- A model may answer differently each time. That is fine when the shape and the status match.

## 1. Local run

Do these with `pnpm --filter @hypergeist/worker dev` running and a filled `.dev.vars` (deployment guide, section 2). Use `http://localhost:8787` in place of `$APP`.

| ID   | What to do                                                                                                                                                    | Expected                                                                                                                                                                                         | Result (Pass/Fail/Notes) |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| W-01 | Run the three `curl` commands of deployment guide section 2: health, quota and chat, each with `-H 'Origin: http://localhost:8787'` (health needs no header). | Health `200` `{"ok":true}`. Quota `200` with `dailyLimit`, `dailyUsed`, `visitorLimit`, `visitorUsed`, `resetsAt`. Chat `200` with `choices[0].message` and `finish_reason` only.                |                          |
| W-02 | Stop the dev server. Rename `apps/worker/.dev.vars` to `.dev.vars.off`. Start the dev server and call chat as in W-01. Then rename the file back and restart. | Health still answers `200`. Chat answers `503` `{"error":{"code":"AI_DISABLED"}}`, because the salt, the key and the model are missing. After you restore the file, chat works again.            |                          |
| W-03 | Run `pnpm --filter @hypergeist/web dev` too. Open `http://localhost:5173`. In the console run `CONSOLE_SAME`.                                                 | The log shows an object with `choices[0].message` and `finish_reason`. The Vite proxy forwards the request, and the browser's `Origin` is `http://localhost:5173`, which is in the default list. |                          |

## 2. Deployed URL: basics and origin

| ID   | What to do                                                                                                                                                                                                                               | Expected                                                                                                                                                                                                                                                                                                                                    | Result (Pass/Fail/Notes) |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| W-04 | Run `curl -i $APP/api/health`.                                                                                                                                                                                                           | `200` and `{"ok":true}`.                                                                                                                                                                                                                                                                                                                    |                          |
| W-05 | Run `hg_quota`.                                                                                                                                                                                                                          | `200`. The body has exactly `dailyLimit` (400 by default), `dailyUsed`, `visitorLimit` (60 by default), `visitorUsed` and `resetsAt` (an ISO time at 00:00:00 UTC of the next day). No token count and no provider name. The headers have `cache-control: no-store` and `x-content-type-options: nosniff`, and no `access-control-` header. |                          |
| W-06 | Run `hg_chat`.                                                                                                                                                                                                                           | `200`. The body is `{"choices":[{"message":{"role":"assistant","content":"..."},"finish_reason":"..."}]}` and nothing else: no `usage`, `id`, `model`, `created` or `system_fingerprint`. The same headers as W-05.                                                                                                                         |                          |
| W-07 | Open the deployed URL in a browser. In the console run `CONSOLE_SAME`.                                                                                                                                                                   | The log shows the same shape as W-06. In the Network tab the request to `/api/ai/chat` is `200`. The browser added `Origin` and `Sec-Fetch-Site: same-origin` itself.                                                                                                                                                                       |                          |
| W-08 | Call chat and quota with no `Origin` and no `Sec-Fetch-Site` header: `curl -i $APP/api/ai/quota`, and the chat call of deployment guide section 7, step 4. Then call chat with `-H 'Sec-Fetch-Site: same-origin'` and still no `Origin`. | All three answer `403` `{"error":{"code":"FORBIDDEN_ORIGIN"}}` (a chat `POST` needs an `Origin` even when `Sec-Fetch-Site` is `same-origin`). The tail line has `"counted":false` and `"provider":"none"`.                                                                                                                                  |                          |
| W-09 | Run `hg_chatas` with these `Origin` values, one call each: `https://example.com`; `http://localhost:8787` (after you removed the localhost origins from production); `$APP/` (with a trailing slash). Then run `CROSSSITE`.              | Every call answers `403` `FORBIDDEN_ORIGIN`. If you left the localhost origins in `AI_ALLOWED_ORIGINS`, the second call answers `200`: write that down and decide whether to remove them.                                                                                                                                                   |                          |
| W-10 | In a tab on another website, run `CONSOLE_OTHER`. Look at the Network tab.                                                                                                                                                               | The console prints `TypeError: Failed to fetch` (or similar), not a status. The Network tab shows only an `OPTIONS` request with status `404`, and no `POST`. The Worker adds no CORS header, so the browser stops before it sends the real call.                                                                                           |                          |

## 3. Request validation

Each case here ends before the provider is called. None of them should change the quota numbers (W-16 checks that).

| ID   | What to do                                                                                                                                                                       | Expected                                                                                                                                                                            | Result (Pass/Fail/Notes) |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| W-11 | Run `hg_chat '{"model":"auto"'` (invalid JSON). Then run `curl -i -H "Origin: $APP" -H 'content-type: text/plain' -d "$BODY" $APP/api/ai/chat`.                                  | Both answer `400` `{"error":{"code":"BAD_REQUEST"}}`.                                                                                                                               |                          |
| W-12 | Run `hg_chat '{"model":"auto","messages":[{"role":"user","content":"hi"}],"n":2}'`. Run it again with `"stream":true` in place of `"n":2`. Run it again with `"messages":[]`.    | Each answers `400` `BAD_REQUEST`. The Worker accepts only the fields of the shared schema, and `stream` only as `false`.                                                            |                          |
| W-13 | Run the `BIG` commands (body of about 140,000 bytes).                                                                                                                            | `413` `{"error":{"code":"PAYLOAD_TOO_LARGE"}}`.                                                                                                                                     |                          |
| W-14 | Run `hg_chat '{"model":"gpt-4o","messages":[{"role":"user","content":"hi"}]}'`.                                                                                                  | `400` `{"error":{"code":"MODEL_NOT_ALLOWED"}}`, because the model is not `auto` and `AI_ALLOWED_MODELS` is empty.                                                                   |                          |
| W-15 | Run `curl -i $APP/api/ai/chat` (a GET). Run `curl -i -X OPTIONS $APP/api/ai/chat`. Run `curl -i -X POST -H "Origin: $APP" $APP/api/ai/quota`. Run `curl -i $APP/api/ai/nothing`. | Each answers `404` with the body `{"error":"Not found"}` (a plain string, not a code object). Each has `cache-control: no-store` and no `access-control-` header.                   |                          |
| W-16 | Run `hg_quota` before W-11 and after W-15 (or compare with the numbers you wrote down). Look at the headers of the error answers of W-08 to W-15.                                | `dailyUsed` and `visitorUsed` did not change. Requests that fail validation, the origin check or the burst limit are not counted. Every error answer has `cache-control: no-store`. |                          |

## 4. Limits

| ID   | What to do                                                                                                                                                                                                                                                                                                 | Expected                                                                                                                                                                                                                                                                                                                                                                                   | Result (Pass/Fail/Notes) |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| W-17 | **Burst limit.** Wait a minute with no calls. Run `LOOP` (12 calls). Right after, run `hg_chat "$SMALL"`. Wait a minute, then run `hg_chat "$SMALL"` again.                                                                                                                                                | About the first 10 calls print `200`, and the rest print `429`. The Rate Limiting binding is approximate and counts per Cloudflare location, so the switch may come a call or two early or late. The extra call answers `429` `{"error":{"code":"RATE_LIMITED"}}` with `retry-after: 60`. After a minute it answers `200` again. The tail lines of the `429` calls have `"counted":false`. |                          |
| W-18 | **Counts match.** Run `hg_quota` and write down `dailyUsed` and `visitorUsed`. Run `hg_chat "$SMALL"` three times, a few seconds apart. Run `hg_quota` again.                                                                                                                                              | Both numbers went up by exactly 3 (one visitor: you). `dailyLimit` and `visitorLimit` equal the values in `wrangler.jsonc`. Requests that the provider refused also count, because the count is made before the provider call.                                                                                                                                                             |                          |
| W-19 | **Visitor and daily cap.** Run `hg_quota` and note `visitorUsed` (call it U). Set `AI_VISITOR_DAILY_CAP` to U plus 2 and deploy. Run `hg_chat "$SMALL"` three times. Run `hg_quota`. Restore the value and deploy. Repeat with `AI_DAILY_CAP` in place of `AI_VISITOR_DAILY_CAP` (use `dailyUsed` plus 2). | The first two calls answer `200`. The third answers `429` `{"error":{"code":"DAILY_CAP"}}` with a `retry-after` between 1 and 86400, equal to the seconds left until 00:00 UTC. `hg_quota` shows `visitorUsed` (or `dailyUsed`) equal to the limit. The third call is not counted. After the restore, chat answers `200` again.                                                            |                          |

## 5. The provider

These cases depend on the real provider. See "Cases that depend on the provider" at the end.

| ID   | What to do                                                                                                                                                                                                                                                                                                                                                                 | Expected                                                                                                                                                                                                                                                                                                                                                                             | Result (Pass/Fail/Notes) |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| W-20 | **Token cap.** Make sure at least one call answered `200` today (W-06). Set `AI_DAILY_TOKEN_CAP` to `1` and deploy. Run `hg_chat "$SMALL"`. Restore the value and deploy. Run `hg_chat "$SMALL"`.                                                                                                                                                                          | With the cap at 1, chat answers `429` `DAILY_CAP` at once, with a `retry-after`. The tail line has `"counted":false`. That proves the Worker counted the tokens of the earlier replies. After the restore chat answers `200`. If the first call answers `200`, no tokens were counted: write that down.                                                                              |                          |
| W-21 | **A real tool call.** Run `hg_chat "$TOOLBODY"`.                                                                                                                                                                                                                                                                                                                           | `200`. `choices[0].message.tool_calls[0]` has `id`, `type` `function`, and `function.name` `add`, and `function.arguments` is a string of JSON such as `{"a":2,"b":3}`. `finish_reason` is `tool_calls` (or `stop`). If the model answers with plain text only, it does not call tools reliably: write the model name down. The app needs a model that does.                         |                          |
| W-22 | **Does Sarvam accept Bearer alone?** Read the key without echo: `read -s "SARVAM_API_KEY?Key: "; export SARVAM_API_KEY`. Run `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $SARVAM_API_KEY" https://api.sarvam.ai/v2/models`. Then run it with `-H "api-subscription-key: $SARVAM_API_KEY"`. Then `unset SARVAM_API_KEY`. Do not print the variable. | Write down both status codes. Sarvam's docs of 2026-11-16 list both headers. `200` for both means either header works. The Worker sends both, so a `401` on one of them does not break the proxy. A `401` on both means the key is wrong.                                                                                                                                            |                          |
| W-23 | **Wrong model id, no failover.** Set `AI_SARVAM_MODEL` to `no-such-model` and deploy. Run `hg_chat`. Look at the tail. Restore the value and deploy.                                                                                                                                                                                                                       | `503` `{"error":{"code":"UPSTREAM_FAILED"}}`. The tail line has `"provider":"sarvam"`, `"kind":"http-4xx"` and `"counted":true`. The Worker does not retry a 400, 401, 403 or 404, and the provider's error text is not in the answer. Sarvam's docs say an unknown model id returns `404`. If the log says `http-5xx` instead, write it down.                                       |                          |
| W-24 | **Two providers listed.** With both keys and both model ids set, set `AI_PROVIDERS` to `sarvam,openai` and deploy. Run `hg_chat`. Look at the tail. Restore and deploy.                                                                                                                                                                                                    | `200`, and the tail shows `"provider":"sarvam"`. The configuration is accepted. A real fallback to the second provider only happens after a 429, a 5xx, a timeout or an unreadable reply from the first. You cannot cause that on demand, so write "not reproducible". It is covered by `apps/worker/src/ai/chat-route.test.ts`.                                                     |                          |
| W-25 | **OpenAI after the switch.** Follow deployment guide section 12. Run `hg_chat` and `hg_chat "$TOOLBODY"`.                                                                                                                                                                                                                                                                  | `200` for both. The tail shows `"provider":"openai"`. OpenAI did not reject `max_completion_tokens` or the missing `temperature`. If it answers `400`, the log says `http-4xx` and chat answers `UPSTREAM_FAILED`: record the model name, and check the model page of OpenAI for the parameters it accepts.                                                                          |                          |
| W-26 | **Empty answer from a reasoning model.** For the model in use, run `hg_chat` and `hg_chat "$TOOLBODY"` five times each. Look at `content`, `tool_calls` and `finish_reason`, and at `kind` in the tail.                                                                                                                                                                    | Good: text or a tool call, and `finish_reason` `stop` or `tool_calls`. Bad: `content` empty or `null`, no tool call, `finish_reason` `length`. The tail line then has `"kind":"empty-length"`. Count how many of the ten calls were bad. If more than one, raise `AI_MAX_OUTPUT_TOKENS` (at most 4096) or, for OpenAI, set `AI_REASONING_EFFORT` to `low` or `minimal`, then repeat. |                          |
| W-27 | **Real tokens and cost.** Run the tail. Make 10 calls: `hg_chat "$BODY"` and `hg_chat "$TOOLBODY"` five times each. At the provider's usage page, read the tokens (input and output) and the cost of those 10 calls. Fill the table below.                                                                                                                                 | The provider shows about the same number of requests as you made. Cost per request is far below the credit (deployment guide, section 10). Compare the measured tokens per request with the estimate of 4,000 input and 500 output tokens. A real Turn of the app sends a larger request (tools and context), so the real numbers come from W-28.                                    |                          |
| W-28 | **A real Turn through the app's own proxy client.** Do this with the temporary file (see "The temporary file"). Run `WORKER_URL=$APP pnpm exec vitest run apps/web/src/ai/zz-try-proxy.local.test.ts -t "ping"`, then `-t "new stack"`. At the provider's usage page, read the tokens of the `new stack` run.                                                              | `ping`: `HTTP 200`, `top-level keys: choices`, a finish reason. `new stack`: status `done`, at least one step with `[ok]`, and `valid: true`. Error lines show only a code, never a body. Fill the second table below. If Node does not send the `Origin` header, you see `FORBIDDEN_ORIGIN`: use the fallback in "The temporary file".                                              |                          |

Token and cost numbers (W-27, W-28). One row per group of calls.

| Provider | Model | Case             | Calls | Input tokens | Output tokens | Total tokens | Tokens per call | Cost (currency) | Cost per call |
| -------- | ----- | ---------------- | ----- | ------------ | ------------- | ------------ | --------------- | --------------- | ------------- |
|          |       | W-27 `BODY`      |       |              |               |              |                 |                 |               |
|          |       | W-27 `TOOLBODY`  |       |              |               |              |                 |                 |               |
|          |       | W-28 `new stack` |       |              |               |              |                 |                 |               |

## 6. Kill switch, logs, secrets, platform

| ID   | What to do                                                                                                                                                                                                                                                                                                                                                                                                                | Expected                                                                                                                                                                                                                                                                                                                                                                                       | Result (Pass/Fail/Notes) |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| W-29 | **Kill switch.** Note the request count on the provider's usage page. Set `AI_ENABLED` to `false` in `wrangler.jsonc` and deploy (or use another way of deployment guide section 9). Run `hg_chat`, `hg_quota` and `curl -i $APP/api/health`. Set it back to `true` and deploy. Then, optionally, try the secret way: `wrangler secret delete` for the first provider, run `hg_chat`, and `wrangler secret put` it again. | Chat and quota answer `503` `{"error":{"code":"AI_DISABLED"}}`. Health still answers `200`. The provider's usage page shows no new request. After you set it back, chat answers `200`. With the secret deleted, chat also answers `AI_DISABLED`.                                                                                                                                               |                          |
| W-30 | **No secret in the repository.** Run the `SECRETSCAN` commands from the repository root.                                                                                                                                                                                                                                                                                                                                  | The first command prints nothing (`.dev.vars` is not tracked). The second prints the `.gitignore` line that matches `.dev.vars`. The four `git log` commands print nothing (no commit ever added a key-shaped string). The last command prints only comment lines that name the secrets, with no value. Add any other prefix that your provider's keys use. Do not paste a key into a command. |                          |
| W-31 | **Log lines.** With `wrangler tail --format json` running, send one call each for: a good chat, a missing `Origin`, a bad body, a too-large body, and a `hg_quota`. Look at the `logs` entries of each event.                                                                                                                                                                                                             | Each Worker line is one JSON object with exactly `route`, `status`, `code`, `provider`, `kind`, `ms`, `counted`. No message text, no tool argument, no reply text, no IP address, no header and no key. For example the good chat has `"code":"ok"` and `"counted":true`. The missing `Origin` has `"code":"FORBIDDEN_ORIGIN"`, `"provider":"none"`, `"counted":false`.                        |                          |
| W-32 | **CPU time.** In the Cloudflare dashboard open Workers & Pages, the Worker, then Metrics. Read the CPU time (median and p99) after the cases above, including W-13.                                                                                                                                                                                                                                                       | CPU time stays under the Free plan limit of 10 ms per request, and there are no CPU limit errors. Time spent waiting for the provider does not count. Write the median and p99. The labels may differ from this text.                                                                                                                                                                          |                          |
| W-33 | **Counters survive a deploy and reset at midnight.** Run `hg_quota`, write the numbers, run `cd apps/worker && pnpm exec wrangler deploy`, run `hg_quota` again. On the next UTC day, after 00:00 UTC, run `hg_quota` before any chat call.                                                                                                                                                                               | After the deploy the numbers are unchanged. After 00:00 UTC `dailyUsed` and `visitorUsed` are `0`, and `resetsAt` is the following midnight. The lifetime counters are not shown and do not reset.                                                                                                                                                                                             |                          |

## Cases that wait

| Case                                       | Waits for         | Why                                                                                             |
| ------------------------------------------ | ----------------- | ----------------------------------------------------------------------------------------------- |
| The app answering in demo mode from the UI | `ai-assistant-ui` | The app has no chat control yet. Case A-29 of `docs/manual-verification-ai.md` covers it.       |
| The demo-quota counter in the menu bar     | `ai-assistant-ui` | The route exists (W-05). Nothing in the UI reads it yet.                                        |
| The Limits text naming the provider        | `ai-assistant-ui` | Requirement 7.4. The text is written in that spec, after you know which provider is configured. |

## Cases that depend on the provider

These results depend on what the provider does that day. If you cannot cause them, write "not reproducible".

| Case                      | Fallback                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W-20 (token cap)          | Needs a real reply. Covered by `apps/worker/src/ai/quota-logic.test.ts` and `apps/worker/src/ai/chat-route.test.ts` (tokens added after success, then denied). |
| W-21 (tool call)          | Depends on the model. The capability check of the app and A-09 of `docs/manual-verification-ai.md` test the same thing.                                        |
| W-22 (Bearer alone)       | Sarvam can change what it accepts. Not needed for the proxy, which sends both headers (`apps/worker/src/ai/providers.test.ts`).                                |
| W-23 (wrong model)        | The status a provider gives for an unknown model can change. Covered by `apps/worker/src/ai/upstream.test.ts` (400, 401, 403 and 404 are not retried).         |
| W-24 (failover)           | A provider failure cannot be caused on demand. Covered by `apps/worker/src/ai/chat-route.test.ts` (429 then success, exhausted providers, no failover on 401). |
| W-25 (OpenAI parameters)  | Which parameters a model accepts changes. Covered by `apps/worker/src/ai/providers.test.ts` (`max_completion_tokens`, no `temperature`).                       |
| W-26 (empty answer)       | Depends on the model and its reasoning. Covered by `apps/worker/src/ai/upstream.test.ts` (`empty-length`).                                                     |
| W-27, W-28 (tokens, cost) | Prices and token counts are the provider's. No test can replace them.                                                                                          |
| W-17 (burst)              | The binding is approximate and per location. Covered by `apps/worker/src/ai/chat-route.test.ts` (burst denied).                                                |

## Sign-off

|                                                                                 |     |
| ------------------------------------------------------------------------------- | --- |
| Date                                                                            |     |
| Verified by                                                                     |     |
| Deployed URL                                                                    |     |
| Sarvam model                                                                    |     |
| OpenAI model                                                                    |     |
| `AI_REASONING_EFFORT` and `AI_MAX_OUTPUT_TOKENS` used                           |     |
| Cap values at the end (visitor, daily, daily tokens, lifetime, lifetime tokens) |     |
| Tokens and cost per request (from W-27, W-28)                                   |     |
| CPU time median and p99 (from W-32)                                             |     |
| Temporary file deleted (yes/no)                                                 |     |
| All changed variables restored (yes/no)                                         |     |
| Cases failed (IDs)                                                              |     |
| Cases skipped, and why                                                          |     |
| Cases waiting (see "Cases that wait")                                           |     |
| Follow-up tasks created                                                         |     |

## The temporary file

Case W-28 uses the app's own proxy client (`createProxyProvider`) against the deployed Worker. Copy this into `apps/web/src/ai/zz-try-proxy.local.test.ts`. It is **delete after use** and never committed. Keep it out of git status:

```sh
echo 'apps/web/src/ai/zz-try-proxy.local.test.ts' >> .git/info/exclude
```

When you are done, delete it: `rm apps/web/src/ai/zz-try-proxy.local.test.ts`. If you forget, a full `pnpm test` runs it, but without `WORKER_URL` both of its cases are skipped. The file needs no key. It reads `WORKER_URL` from the environment. It adds the `Origin` header that the Worker requires, because Node does not send one. Node's `fetch` is expected to allow that header, but this was not tried: if the output shows `error code FORBIDDEN_ORIGIN`, run the same prompts with `hg_chat` (cases W-06 and W-21) and write "Node fetch cannot set Origin" in the Result column. The file prints only a status, a path, a size, an error code and the shape of the reply. It prints no header of the request.

```ts
// @vitest-environment node
// TEMPORARY. Delete this file after use. Never commit it.
// The only setting is the environment variable WORKER_URL (the deployed URL). No key is used.
import { describe, it } from 'vitest';
import { validateStack } from '@hypergeist/shared/format';
import { createProxyProvider, runTurn, startNewStack } from './index.ts';
import type { Provider } from './index.ts';

const TEST_TIMEOUT_MS = 200_000;

type ChatRequest = Parameters<Provider['chat']>[0];

function readEnv(name: string): string {
  return process.env[name] ?? '';
}

const workerUrl = readEnv('WORKER_URL').replace(/\/+$/, '');
const liveIt = it.skipIf(workerUrl === '');

function write(line: string): void {
  process.stdout.write(`${line}\n`);
}

function describeReply(json: unknown): string {
  if (typeof json !== 'object' || json === null) return 'reply is not an object';
  const record = json as Record<string, unknown>;
  const error = record['error'];
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>)['code'];
    return `error code ${typeof code === 'string' ? code : '?'}`;
  }
  const choices = record['choices'];
  const first: unknown = Array.isArray(choices) ? choices[0] : undefined;
  const message =
    typeof first === 'object' && first !== null
      ? (first as Record<string, unknown>)['message']
      : undefined;
  const finish =
    typeof first === 'object' && first !== null
      ? (first as Record<string, unknown>)['finish_reason']
      : undefined;
  const fields =
    typeof message === 'object' && message !== null ? (message as Record<string, unknown>) : {};
  const content = fields['content'];
  const calls = fields['tool_calls'];
  return `top-level keys: ${Object.keys(record).join(',')}; finish_reason=${String(finish)}; content chars=${typeof content === 'string' ? String(content.length) : 'none'}; tool calls=${Array.isArray(calls) ? String(calls.length) : '0'}`;
}

/** The real `fetch`, plus the Origin header and one printed line per request. */
const proxyFetch: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set('origin', new URL(workerUrl).origin);
  const response = await fetch(input, { ...init, headers });
  const bodyChars = typeof init?.body === 'string' ? init.body.length : 0;
  let summary = 'reply is not JSON';
  try {
    const json: unknown = await response.clone().json();
    summary = describeReply(json);
  } catch {
    // Keep the default summary.
  }
  const retryAfter = response.headers.get('retry-after');
  write(
    `  request ${init?.method ?? 'GET'} /api/ai/chat -> HTTP ${String(response.status)}, request body ${String(bodyChars)} chars, ${summary}${retryAfter === null ? '' : `; retry-after=${retryAfter}`}`,
  );
  return response;
};

function proxy(): Provider {
  return createProxyProvider({ fetch: proxyFetch, endpoint: `${workerUrl}/api/ai/chat` });
}

describe('Worker proxy, manual try-out', () => {
  liveIt(
    'ping',
    async () => {
      const text = readEnv('W_PROMPT') || 'Say hello in three words.';
      const request: ChatRequest = {
        messages: [{ role: 'user', content: text }],
        meta: { userMessage: text, round: 0, currentCardId: null, selectedObjectId: null },
      };
      const result = await proxy().chat(request);
      write('--- ping');
      if (result.ok) {
        write(
          `ok: finish=${result.reply.finishReason} text chars=${String(result.reply.content?.length ?? 0)} tool calls=${String(result.reply.toolCalls.length)}`,
        );
      } else {
        write(`error: ${result.error.code}`);
      }
    },
    TEST_TIMEOUT_MS,
  );

  liveIt(
    'new stack',
    async () => {
      const start = startNewStack({ takenIds: [] });
      const prompt = readEnv('W_PROMPT') || 'Make me a to-do list';
      write(`prompt length: ${String(prompt.length)} characters`);
      const result = await runTurn({
        provider: proxy(),
        stack: start.stack,
        currentCardId: start.currentCardId,
        selectedObjectId: null,
        userMessage: prompt,
        history: [],
        newStack: true,
        jsonMode: false,
        clock: () => performance.now(),
      });
      write('--- new stack');
      write(
        `status: ${result.status}  stop: ${result.stopReason}  requests: ${String(result.rounds)}  jsonMode: ${String(result.usedJsonMode)}  provider: ${result.providerKind}`,
      );
      if (result.error !== undefined) write(`error: ${result.error.code}: ${result.error.message}`);
      result.steps.forEach((step, index) => {
        write(`step ${String(index + 1)} [${step.ok ? 'ok' : 'rejected'}] ${step.description}`);
      });
      result.say.forEach((line) => write(`say: ${line}`));
      write(
        `cards: ${String(result.after.cards.length)}; stack "${result.after.name}" valid: ${String(validateStack(result.after).valid)}`,
      );
    },
    TEST_TIMEOUT_MS,
  );
});
```

Run it from the repository root. The `-t` value picks one case:

```sh
WORKER_URL=$APP pnpm exec vitest run apps/web/src/ai/zz-try-proxy.local.test.ts -t "ping"
WORKER_URL=$APP pnpm exec vitest run apps/web/src/ai/zz-try-proxy.local.test.ts -t "new stack"
```

`W_PROMPT` replaces the message of both cases. `valid: true` must always hold. A case where it is `false` is a bug: write it down and stop. When the daily or burst cap is reached, a Turn ends `failed` with the error `QUOTA` (`DAILY_CAP`) or `RATE_LIMITED`. That is a correct result.

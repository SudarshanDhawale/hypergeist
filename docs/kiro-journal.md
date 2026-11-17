# Kiro Journal

This journal records how Kiro was used to build HyperGeist for Kiroween 2026. Each entry notes the date, what was done with Kiro, what worked, and what did not, so that the submission can describe the real workflow and its limits.

## Entry template

Copy this block for each new entry and add it below, newest last.

```markdown
### YYYY-MM-DD

**What was done with Kiro:**

**What worked:**

**What did not:**
```

## Entries

### 2026-11-14

**What was done with Kiro:**

- Wrote steering files (product, tech stack, architecture, conventions, design language) before any spec. The design language file uses `inclusion: auto`, so it loads only for UI work.
- Wrote requirements for the stack format and engine as one spec, then split it into `stack-format-and-validator` and `stack-engine` after reviewing the dependency order. A missing "create a new stack" requirement surfaced during the split and was added to the engine spec.
- Built the repo scaffold as a Quick Spec (requirements, design, tasks) and ran the tasks with Kiro's run-all mode, which dispatched sub-agents in parallel waves.

**What worked:**

- Steering plus spec context meant later sub-agents followed the locked stack without being re-told.
- Parallel task waves finished the file-only part of the scaffold quickly.
- The requirements review caught real design conflicts early: timer and reminder objects the format does not have, a fixed card size against a per-stack size, and touch targets smaller than the stated minimum.
- Verification found real problems that review alone would not have: lint, typecheck, 31 unit tests, the build, and the Playwright smoke test all passed once the install was fixed.

**What did not:**

- The design assumed pnpm 10's `onlyBuiltDependencies`. pnpm 12 ignores it and uses `allowBuilds`, so the first install stopped with `ERR_PNPM_IGNORED_BUILDS`.
- pnpm resolved TypeScript 7.0.2, whose JavaScript compiler API is not stable yet. typescript-eslint and our dependency check script need the old API, so TypeScript is pinned to `~6.0.0`.
- The agent shell had no network access. A failed `pnpm install --frozen-lockfile` there emptied `node_modules/.pnpm`, and the install had to be redone in a normal terminal. Lesson: sub-agents must never run install commands, and the browser-based tests need to run in the developer's terminal because the sandbox blocks Chromium.
- zsh expanded `@hypergeist/shared@workspace:*`; the argument needs quotes.
- Pushing to GitHub failed first because macOS had cached credentials for a different account. A token with the `workflow` permission was needed because the first commit contained a workflow file.

### 2026-11-15

**What was done with Kiro:**

- Wrote requirements, design and tasks for `stack-engine` (seven operations, a handler executor for all nine actions, render model, remix, stack creation), then ran the tasks in orchestrator mode: sub-agents wrote code and tests, the orchestrator tracked task status.
- Added property-based tests with fast-check: operations keep the stack valid after every step, a rejected operation changes nothing and returns well-formed errors, engine functions are pure on deeply frozen inputs, and the Zod parameter schemas agree with the generated JSON Schemas.

**What worked:**

- The closure property runs sequences of up to 50 operations, with faults injected (unknown ids, duplicate ids, out-of-range indexes, wrong types), against generated stacks. It gives more coverage than the example tests by themselves.
- Checking the half-finished property test files before re-running their tasks saved work: two of the three were complete and passed, and only the purity test was missing.

**What did not:**

- The closure property passed alone in about 5 s but timed out at 30 s once when the whole shared suite ran in parallel workers. The cause was cost per step (copies and repeated validation), not a wrong result. The test now does less work per step and has an explicit 120 s timeout.
- Tasks interrupted mid-run stay marked "in progress" with no result. Their files must be read before a task is re-run.

### 2026-11-15 (local persistence)

**What was done with Kiro:**

- Wrote requirements, design and tasks for `local-persistence`. The open questions went to the Developer as multiple-choice questions in chat, and the answers were written back into the requirements as decisions.
- Ran the tasks in orchestrator mode: sub-agents in parallel waves (types, pure helpers and the autosave scheduler first; then the two repositories; then boot and UI; then tests and docs).
- One shared contract test runs against the in-memory and the IndexedDB repository, and a model-based property test checks that random sequences give the same result in both.

**What worked:**

- The contract test caught a real data-loss defect during the run: saving over a corrupt stored record replaced it without keeping a copy. It now moves the old record to the quarantine first, in both repositories.
- A regression test covers a race the design only described: a pending autosave must not recreate a stack the user just deleted. Removing the flush made three tests fail, which shows the test guards the fix.
- Agents reported what they could not check (the export download event, closing a tab during a write) instead of guessing. Those went into the manual checklist.

**What did not:**

- The design missed that `apps/web` has no `fast-check` and that `check:deps` forbids importing the shared test helpers. Two agents found it independently, saved their finished tests aside and asked. The fix needed a dependency (approved) and a narrow `check:deps` exception for test files.
- Two parallel agents saw each other's half-written files and reported transient typecheck errors. Re-running after the wave fixed it.
- The Stacks window closed after deleting the open stack or restoring demo stacks, because the open stack remounted. The agents had listed it as a known rough edge and left it for the UI spec, but the Developer's first Playwright run failed on it (the notice never stayed visible). It was a real defect, fixed with a `replaceStack` action instead of a remount. The same run caught a wrong file path in the new e2e file. Lesson: a "known rough edge" that e2e tests exercise is a bug, and Playwright cannot run in the agent sandbox, so only the Developer's run finds this class of problem.

### 2026-11-15 (AI orchestrator)

**What was done with Kiro:**

- Drafted requirements for the AI logic, asked the open product questions as multiple-choice questions in chat, and wrote the answers back as decisions. One answer changed the design: the Developer pointed out that reviewers are the only users and the hosted key stays on the Worker, so demo mode became the main path and an own key became an optional extra that is never stored.
- Read the Devpost page and added a submission checklist to the judging steering file (bonus prizes, trademark wording, keeping the demo alive after the deadline).
- Ran 25 tasks in orchestrator mode in about ten waves of parallel sub-agents.
- Measured before designing: the full tool schemas are 26,717 characters (about 6,000 tokens per request), too much for free-tier limits, so the design added a compact schema profile (11,514 characters).

**What worked:**

- The scripted provider and the mirror technique: the property test keeps a mirror of the held stack and builds valid and invalid tool calls against it, so a random model produces many accepted calls, not just garbage. The Turn passed on every seed with no defect found. The distribution check shows all four statuses occur.
- Agents reported design gaps in their own words instead of papering over them: a 200-by-100-object stack cannot be valid (2 MiB limit), a model that ignores tools without an HTTP error is not detected, and the real token counts need provider dashboards because `usage` is dropped.
- The key-leak property echoes a random key through error bodies, thrown errors and model output, and checks only what the app itself produces.

**What did not:**

- The design assumed `zod` was available in `apps/web`. It was only in `packages/shared`, so three agents hit the same missing module in the first wave. Cost: one user install and a delayed wave. Lesson: check each import of the design against the package that owns it, not against the repo.
- One sub-agent call failed with "client has been throttled" when too many ran at once. Re-running it worked.
- The first compact tool-schema pass was 13,903 characters, over the 12,000 budget, and had to be tightened.

### 2026-11-16 (Worker AI proxy)

**What was done with Kiro:**

- Drafted the Worker requirements from the Cloudflare docs read that day (Workers Free limits, the Rate Limiting binding, SQLite Durable Objects on the free plan) and found that the real constraint was the model provider's free tier, not Cloudflare. The Developer then chose paid credits: Sarvam for development and OpenAI for the submission. That changed the design from a Groq and Gemini plan to a fixed provider table, with token caps next to request caps.
- Ran 20 tasks in orchestrator mode in about seven waves of parallel sub-agents. Six property tests cover the proxy: closed set of answers, allowlist of forwarded fields, caps across UTC days, fail closed, reply allowlist, visitor key.

**What worked:**

- Putting the wire schema in `@hypergeist/shared/ai-wire` made the browser and the Worker share one definition. A contract test showed the browser's real output (about 11.6 KB with the compact tool schemas, 9% of the 128 KB limit) parses with it on the first try.
- A mutation check on the caps property (giving the visitor cap one extra slot) made it fail, which shows the property can catch the bug it is meant to catch.
- Agents wrote down what they could not verify (Sarvam auth header, dashboard behavior, free-account namespace id) instead of asserting it. Those became manual cases.

**What did not:**

- The design said `AI_BURST_LIMIT` could be a variable; the Rate Limiting binding takes its limit from `wrangler.jsonc`, so the requirement was corrected before any code was written.
- The design's failover test (wrong model on the first provider, right one on the second) cannot work, because 400 to 404 from a provider are deliberately not retried. The checklist says so and the unit tests cover failover.
- `.gitignore` ignored `.dev.vars` but not `.dev.vars.staging`. A guard test found it and a two-line change fixed it.
- Two agents hit the same TypeScript error: the shared seed helper uses `globalThis.crypto`, which the worker project does not declare, so two property tests keep a local copy of the helper.

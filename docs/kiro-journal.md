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

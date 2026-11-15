---
inclusion: always
---

# HyperGeist: Current Status (read first in every new chat)

Last updated: 2026-11-15. Deadline: **Dec 4, 2026, 2:00 PM PST**. Request Kiro credits **before 12:00 PM PT on Dec 1**.

Full handoff with decisions, gotchas and next steps: `docs/handoff.md`. Read it before acting.

## Where we are
- Repo `SudarshanDhawale/hypergeist` on GitHub (public), branch `main`. Git identity is `SudarshanDhawale`.
- **Done and pushed:** `repo-scaffold` spec (monorepo, CI, configs) and `thin-slice` spec (a strict subset of the stack format with a validator, a pure action executor, a `pnpm stack validate <file>` CLI, and a retro desktop UI with a 3-card to-do stack, Interact and Edit modes, and a static sleeping Ghost).
- **`stack-format-and-validator`:** requirements, design and tasks are approved. **Run COMPLETE except the user's e2e check (task 17.1): all required tasks 1 to 16 are done and verified (format, lint, typecheck, check:deps, 1493 tests on three seeds, build, CLI). Optional property tests 11.8 to 11.19, 7.11 and 9.8 were skipped on purpose. After the user runs `pnpm test:e2e` and it passes, mark 17.1 and the final checkpoint 18 completed.** The format module now supports the full format: five object types (button, field, image, list, ai-field), nine actions, plus `parseStack`, `serializeStack` and `stackJsonSchema` next to `validateStack`. An unknown type is reported as "is unknown". The app's executor still runs only four actions, `image` is a placeholder and `ai-field` is read-only. Run the spec's tasks in orchestrator mode (task 14.1 re-checks ajv; task 17.1 asks the user to run `pnpm test:e2e`).
- **`stack-engine`:** requirements only (no design or tasks yet). Do it after the format spec runs.
- The thin slice is a subset of both specs and must be extended, not replaced.
- **The UI is a first pass.** Substantial UI and UX changes are expected. Ask the user for their feedback list before designing.

## Working agreements with the user
- The user wants visible progress. Prefer thin vertical slices over big upfront documents.
- Specs are run in orchestrator mode: sub-agents write code, the orchestrator only updates task status and reports.
- The agent shell has **no network and a sandbox**. Never run `pnpm install/add/update` there (a failed install once emptied `node_modules`). The user runs installs and `pnpm test:e2e` in their own terminal.
- Keep replies short and plain. Suggest useful Kiro features (hooks, steering, specs, MCP, PBT) when relevant, because the Kiroween write-up is judged on Kiro usage.
- The user commits and pushes. Never commit, push or deploy for them.

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
- **`stack-engine`:** requirements (aligned to the design), design and tasks are approved (2026-11-15). **Task run IN PROGRESS (2026-11-15): done: migration steps 1 to 5 and all seven operations plus applyOperation/OPERATIONS/operationJsonSchema are implemented, exported and tested (examples, schema-consistency, purity scan, set_action idempotence). Remaining required tasks: 9.15 (closure property), 9.16 (rejected-unchanged property), 9.17 (engine purity property) which may be marked in_progress with no result yet (re-run them), then docs tasks 11.1 to 11.4, 12.1 audit, 12.2 full verification, 13.1 user `pnpm test:e2e`, 14 final checkpoint. Optional property tests (4.6, 4.7, 6.3, 7.2, 7.6, 9.22 to 9.31) are skipped on purpose. Resume from the first task in the spec's tasks.md that is not completed.** It extends the existing executor and the finished format module in 7 migration steps; no new dependency is needed. Run its tasks in orchestrator mode; the final tasks include a user checkpoint for `pnpm test:e2e`.
- The thin slice is a subset of both specs and must be extended, not replaced.
- **The UI is a first pass.** Substantial UI and UX changes are expected. Ask the user for their feedback list before designing.

## Working agreements with the user
- The user wants visible progress. Prefer thin vertical slices over big upfront documents.
- Specs are run in orchestrator mode: sub-agents write code, the orchestrator only updates task status and reports.
- The agent shell has **no network and a sandbox**. Never run `pnpm install/add/update` there (a failed install once emptied `node_modules`). The user runs installs and `pnpm test:e2e` in their own terminal.
- Keep replies short and plain. Suggest useful Kiro features (hooks, steering, specs, MCP, PBT) when relevant, because the Kiroween write-up is judged on Kiro usage.
- The user commits and pushes. Never commit, push or deploy for them.

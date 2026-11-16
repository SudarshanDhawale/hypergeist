# Implementation Plan: local-persistence

## Overview

This plan implements `design.md`: a repository over IndexedDB (`idb`) with an in-memory twin, first-run seeding, restore demo stacks, trash, export and import, autosave, a minimal Stacks window, and the changes to the thin-slice text and tests that "not saved" no longer fits. Run the tasks in orchestrator mode. The only task that needs the Developer before code can run is task 1 (install). The e2e run is task 12.

Requirements and decisions: `requirements.md`. Steering rules (conventions, architecture, design-language) apply to every task and are not repeated here.

## Executor safety rules

Read these before every task. They override anything else in this file.

1. **No network, no installs.** The agent shell has no network. Never run `pnpm install`, `pnpm add`, `pnpm update`, or any command that modifies `node_modules`. A failed install once emptied `node_modules`. Task 1 is done by the Developer.
2. **Scoped commands during the work.** Use `pnpm exec vitest run <paths>`, `pnpm --filter @hypergeist/web typecheck`, `pnpm exec eslint <paths>`, and `pnpm exec prettier --write <touched files>`. Run the full suite only in the checkpoint tasks.
3. **No browser in the sandbox.** Chromium cannot run here. Writing Playwright tests is a task; running `pnpm test:e2e` is a user checkpoint (task 12). `pnpm build` needs `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false`.
4. **Do not commit, push, or deploy.** The Developer commits.
5. **Code conventions.** `strict` TypeScript, no `any`, no classes for stack data, named exports, expected failures as result values, inputs never mutated. Files `kebab-case.ts`, components `PascalCase.tsx`, tests next to code. Vitest globals are off: import `describe`, `it`, `expect`, `afterEach` from `vitest` and call `cleanup` in React tests. No `.tsx` file may contain the string `--ghost`.
6. **No clock and no randomness in `persistence/` repositories, `export-stack.ts`, `import-stack.ts`, `free-id.ts`.** Callers pass `now` and ids in.
7. **Property tests.** Use `assertProperty` from `packages/shared/test-support/seed.ts` and the arbitraries there. Import them with a relative path. Add the comment `Feature: local-persistence, Property N: <title>` and a `Validates` line. Never hand-write a property harness.
8. **Existing tests stay green.** Change an expectation only in the files task 9 names.
9. **Honest reporting.** If a task cannot be finished, say so in the task result. Do not mark it done.

## Tasks

- [x] 1. USER CHECKPOINT: install the two dependencies (Developer runs this in their own terminal)
  - [x] 1.1 Ask the Developer to run `pnpm --filter @hypergeist/web add idb` and `pnpm --filter @hypergeist/web add -D fake-indexeddb`, then confirm
    - Stop and wait. Afterwards check `apps/web/package.json` lists `idb` under `dependencies` and `fake-indexeddb` under `devDependencies`, and that `pnpm check:deps` still passes. These are the only dependency changes this spec makes
    - _Requirements: 9.1_

- [x] 2. Types, memory repository, contract tests
  - [x] 2.1 Create `apps/web/src/persistence/types.ts`
    - `Result<T>`, `PersistenceError` (`code`, `message`, optional `validationErrors`), `StackRecord`, `TrashRecord`, `StackSummary`, `TrashSummary`, `ListResult` (`stacks`, `problems`), `Repository` (all methods of the design table, each returning `Promise<Result<...>>`), `SeedStack` (`{ stack }`)
    - _Requirements: 1.1, 1.5_
  - [x] 2.2 Create `apps/web/src/persistence/memory-repository.ts`
    - Implements `Repository` over `Map`s with `structuredClone` on every read and write. Same validation, quarantine, trash cap of 50, one-step moves, seeding marker and `restoreDemo` rules as the design
    - _Requirements: 1.2 to 1.6, 3.1 to 3.4, 4.2 to 4.4, 5.1 to 5.6, 8.1_
  - [x] 2.3 Create `apps/web/src/persistence/repository.contract.ts` and `memory-repository.test.ts`
    - `runRepositoryContract(name, makeRepository)` registers the example tests of the design for any `Repository`: save/load round trip, invalid save rejected and earlier record intact, `create` with used id gives `ID_IN_USE`, invalid stored record goes to the quarantine and is omitted from `list`, seeding once and not again after a delete, seeding that fails part way leaves no marker (use a seed whose stack cannot be stored, for example a poisoned value inserted through a test hook), `moveToTrash` is one step, trash overflow drops the oldest and reports it, restore into a free id, restore into a used id without `newId` gives `ID_IN_USE`, restore with `newId` stores a remix with `remixedFrom`, `restoreDemo` replaces seeds, moves edited copies to the trash and leaves other ids alone, `deleteForever` and `emptyTrash`
    - `memory-repository.test.ts` runs the contract against the memory repository
    - _Requirements: 1 to 5, 9.2_

- [x] 3. Pure helpers
  - [x] 3.1 Create `apps/web/src/persistence/free-id.ts` and `free-id.test.ts`
    - `suggestFreeId(baseId, taken)`: `<base>-copy`, then `<base>-copy-2`, `-copy-3`, and so on, with the base cut so the result matches `^[a-z0-9][a-z0-9_-]{0,63}$` and is not in `taken`. Examples include a 64-character base and a large `taken` set
    - _Requirements: 5.4, 7.4_
  - [x] 3.2 Create `apps/web/src/persistence/export-stack.ts` and `export-stack.test.ts`
    - `exportStack(stack)` returns `{ ok: true, filename, text }` with `serializeStack` text, or `{ ok: false, message }` with the first Validation_Error in a plain sentence. File name `<slug>-<id>.hypergeist.json` as in the design (slug lower-case `a-z0-9` runs joined by `-`, at most 40 characters, empty slug gives just `<id>`). Examples: non-Latin and emoji names, a 100-character name, an empty name
    - _Requirements: 6.1 to 6.3_
  - [x] 3.3 Create `apps/web/src/persistence/import-stack.ts` and `import-stack.test.ts`
    - `MAX_IMPORT_BYTES = 5 * 1024 * 1024`; `checkImportSize(bytes)`; `parseImport(text)` returns `{ ok: true, stack }` or `{ ok: false, errors: shown, more: number }` with at most 5 errors; `planImport(stack, existingIds)` returns `{ kind: 'new' }` or `{ kind: 'conflict', suggestedId }`. Examples: not JSON, wrong property, over the size, id in use, id free
    - _Requirements: 7.1 to 7.4_

- [x] 4. IndexedDB repository
  - [x] 4.1 Create `apps/web/src/persistence/idb-repository.ts`
    - `openIdbRepository({ name?, onBlocked? })` over `idb` with the stores and upgrade function of the design (`upgrade(db, oldVersion)`), one transaction per method, `blocking` closes the connection, `QuotaExceededError` maps to `QUOTA_EXCEEDED`, other errors to `STORAGE_FAILED` with a short message
    - _Requirements: 1.1 to 1.7, 3, 4, 5, 8.3_
  - [x] 4.2 Create `apps/web/src/persistence/idb-repository.test.ts`
    - `import 'fake-indexeddb/auto'`, a unique database name per test. Run `runRepositoryContract` against it. Add: upgrade from a version 0 database creates the stores, a quota error maps to `QUOTA_EXCEEDED` (inject a failing put), two repositories on one database see each other's writes
    - _Requirements: 1.7, 2.5, 9.1, 9.2_

- [x] 5. Opening, seeding, boot
  - [x] 5.1 Create `apps/web/src/persistence/seed-set.ts` and `seed-set.test.ts`
    - `loadSeedSet()` uses `import.meta.glob('../stacks/*.json', { query: '?raw', import: 'default', eager: true })`, parses each with `parseStack`, returns `{ stacks, problems }`, sorted by file name. Test: no problems, at least one stack, every stack passes `validateStack`
    - _Requirements: 3.3_
  - [x] 5.2 Create `apps/web/src/persistence/open-repository.ts` and `open-repository.test.ts`
    - `openRepository({ indexedDB?, name? })` returns `{ repository, mode, reason? }`. Examples: `indexedDB` undefined gives memory mode with a reason, `openDB` rejecting gives memory mode, success gives `indexeddb`, a blocked upgrade reports the "close the other tab" reason
    - _Requirements: 8.1, 8.3_
  - [x] 5.3 Create `apps/web/src/persistence/boot.ts` and `boot.test.ts`
    - `bootPersistence({ now, openRepository?, seedSet? })`: open, `seedIfNeeded`, `list`, read `lastOpenedId`, pick the stack to open (last opened, else first by `savedAt`, else create one with `createStack` if none), return `{ repository, mode, reason?, summaries, problems, initial }`. In memory mode the seeds are loaded into the memory repository first. Examples: first run, second run, memory mode, a quarantined record still gives a usable app, empty database after deleting everything
    - _Requirements: 3.1, 3.2, 8.1_

- [x] 6. Autosave
  - [x] 6.1 Create `apps/web/src/state/save-state-store.ts` and its test
    - Zustand store with `status: 'saved' | 'saving' | 'not-saved'`, `reason`, `canExport`. Pure setters only
    - _Requirements: 2.3_
  - [x] 6.2 Create `apps/web/src/persistence/autosave.ts` and `autosave.test.ts`
    - `createAutosave({ write, onState, debounceMs = 1000, setTimeout, clearTimeout })` returns `{ notify, flush, dispose }`. Tests with Vitest fake timers: several changes within 1 second give one write of the last value, a change during a write is written after it and never before it, `flush` writes at once, a failed write reports `not-saved` with the reason and keeps the pending stack, the next change retries, `QUOTA_EXCEEDED` sets `canExport`, `dispose` cancels the timer
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

- [x] 7. Property tests
  - Unblocked 2026-11-15: `fast-check` was added to `apps/web` (devDependency) and `check:deps` now lets `*.test.ts(x)` files of the apps import `packages/shared/test-support` by relative path. Production code keeps the strict rule.
  - [x] 7.1 Create `apps/web/src/persistence/export-import.property.test.ts`
    - **Property 1: Export then import is lossless.** For every `arbStack`, `parseImport(exportStack(stack).text)` returns a stack deeply equal to the original
    - **Property 5: File names are safe.** For arbitrary names (including Unicode) and valid ids, the file name matches `^[a-z0-9_-]+\.hypergeist\.json$` and its part before the extension has at most 105 characters
    - **Validates: Requirements 6.1, 7.7**
  - [x] 7.2 Create `apps/web/src/persistence/free-id.property.test.ts`
    - **Property 6: Free ids are free.** For every valid base id and every set of taken ids, `suggestFreeId` matches the id pattern and is not in the set
    - **Validates: Requirements 5.4, 7.4**
  - [x] 7.3 Create `apps/web/src/persistence/repository.property.test.ts`
    - **Property 2: Save then load is lossless**, **Property 3: A rejected save changes nothing** (use `arbCandidate` for invalid values and compare the stored record before and after), and **Property 4: Model-based sequence**: random sequences of `save`, `create`, `moveToTrash`, `restoreFromTrash`, `restoreDemo`, `deleteForever` give the same `list` and `listTrash` in the memory and IndexedDB repositories after every step, every listed stack passes `validateStack`, and the trash never exceeds 50. Use a small number of runs per property if needed so the file stays under 20 seconds, and set an explicit test timeout
    - **Validates: Requirements 1.2, 1.3, 3, 4, 5.1, 5.6, 9.2**

- [x] 8. UI
  - [x] 8.1 Create `SaveIndicator.tsx` and `MemoryModeBanner.tsx` with tests
    - `SaveIndicator` shows "Saved", "Saving" or "Not saved: <reason>" in the stack window, with `role="status"`, and an Export button when `canExport`. `MemoryModeBanner` shows "Changes are lost when you close this page. Export before leaving." Follow the design-language steering. Replace the old `note` text in `StackWindow.tsx` and update `StackWindow.test.tsx` and `StackWindow.smoke.test.tsx` as needed
    - _Requirements: 2.3, 2.4, 2.5, 8.1, 8.2_
  - [x] 8.2 Create `apps/web/src/components/AppRoot.tsx` and its test, and change `main.tsx`
    - Runs `bootPersistence`, shows "Opening your stacks..." while it runs, then renders the existing Desktop with one stack store that `replaceStack` re-loads when another stack is opened (no remount, so the Stacks window stays open). Wires the autosave to the stack store, flushes on `visibilitychange` (hidden) and `pagehide`, writes `lastOpenedId`. `App` and its `stackText` prop stay for the existing tests
    - _Requirements: 2.1, 2.2, 3.1, 8.1_
  - [x] 8.3 Create `apps/web/src/components/StacksWindow.tsx` and its test, add the "Stacks" button to `MenuBar.tsx`
    - Modal window as in the design: stacks list (Open, Export, Delete), Import (file input with the size check before reading), Restore demo stacks (confirm), Trash (Restore, Delete permanently, Empty trash with confirms), quarantine line, copy dialog for id conflicts. Export triggers a download with `Blob`. Deleting the open stack opens another or creates one. Keyboard: Escape closes, focus returns to the button, controls are at least 24 px. Tests with an in-memory repository: each action, each confirm, an invalid import showing at most 5 errors, a conflict offering a copy and cancel changing nothing
    - _Requirements: 4.1, 5, 6, 7, 1.4_

- [x] 9. Update the text and tests that said "not saved"
  - [x] 9.1 Rewrite the Limits text and update the tests that read it
    - Change the "Changes are not saved..." sentence in the Limits card of `apps/web/src/stacks/thin-slice-todo.json` to the real limits: stacks are stored in this browser only, clearing site data deletes them, two tabs on one stack overwrite each other (the last save wins), the last second before closing a tab may be lost, the open card and mode are not saved. Update `demo-stack.test.ts`, `App.startup.test.tsx` and `StackWindow.test.tsx` accordingly. Run `pnpm stack validate apps/web/src/stacks/thin-slice-todo.json` equivalent through the existing test
    - _Requirements: 8.4_
  - [x] 9.2 Update `README.md`
    - Replace "No saving" in "Limits of the thin slice" with the real storage limits, add a short "Saving and the Stacks window" section (what is stored, where, export and import, trash, restore demo stacks, Memory_Mode). Do not claim anything not implemented
    - _Requirements: 8.4_

- [x] 10. Playwright tests (write only, do not run)
  - [x] 10.1 Update `e2e/thin-slice.spec.ts` and add `e2e/persistence.spec.ts`
    - Replace "a reload resets the stack and shows the not-saved notice" with "a reload keeps the added item". New tests: first run shows the seeded stack; delete then restore from the trash; restore demo stacks; export then import the same file (use the download event and `setInputFiles`); an invalid import shows errors and stores nothing. Each test starts in a fresh context, so the database is empty. Use the recorded-response provider only (no AI is involved yet)
    - _Requirements: 9.3_

- [x] 11. Verification and docs
  - [x] 11.1 Write `docs/manual-verification-persistence.md`
    - The numbered manual list from the design, each with steps, the expected result and a "Result" column left empty for the Developer
    - _Requirements: 9.4_
  - [x] 11.2 Run the full verification suite
    - In this order: `pnpm format` then `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm check:deps`; `pnpm test` with `HYPERGEIST_TEST_SEED=1`, `20261115` and `424242`; `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false pnpm build`; `pnpm stack validate apps/web/src/stacks/thin-slice-todo.json`. Also check: no `.tsx` contains `--ghost`, `.kiro` is not in `.gitignore`, `git diff --stat` shows `package.json` and the lockfile changed only by `idb` and `fake-indexeddb`. If a seed fails, record the seed and the shrunk counterexample and fix the cause in a follow-up task. Do not commit
    - _Requirements: 9.1, 9.2_
  - [x] 11.3 Update `docs/handoff.md`, `.kiro/steering/project-status.md` and `docs/kiro-journal.md`
    - Record the repository API, Memory_Mode, the seed rule (one JSON file per demo stack in `apps/web/src/stacks/`), the known limits, the changed tests, and the journal entry. Do not state that the e2e run or the manual checks passed
    - _Requirements: 9.4_

- [x] 12. USER CHECKPOINT: run the end-to-end tests (Developer runs this in their own terminal)
  - [x] 12.1 Ask the Developer to run `pnpm test:e2e`
    - Chromium cannot run in the agent sandbox. Stop and ask for the result. If a test fails, record it and fix it in a follow-up task. Mark this done only after the Developer reports a pass
    - _Requirements: 9.3_

- [x] 13. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise. Remind the Developer to do the manual list in `docs/manual-verification-persistence.md`, review the diff and commit; no task commits, pushes, or deploys.

## Notes

- Property 1 and 5 share a file, as do Properties 2, 3 and 4. All six are required: persistence loses user work if they fail.
- Existing tests that change expectations: `demo-stack.test.ts`, `App.startup.test.tsx`, `StackWindow.test.tsx`, `StackWindow.smoke.test.tsx` (tasks 8.1 and 9.1), and the e2e reload test (task 10.1).
- The retro desktop (icons, drag, trash icon) is the `retro-ui-shell` spec. The Stacks window here is deliberately plain.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "3.2", "3.3", "6.1"] },
    { "id": 2, "tasks": ["2.2", "6.2", "7.1", "7.2"] },
    { "id": 3, "tasks": ["2.3", "4.1", "5.1"] },
    { "id": 4, "tasks": ["4.2", "5.2"] },
    { "id": 5, "tasks": ["5.3", "7.3"] },
    { "id": 6, "tasks": ["8.1", "8.2"] },
    { "id": 7, "tasks": ["8.3", "9.1"] },
    { "id": 8, "tasks": ["9.2", "10.1", "11.1"] },
    { "id": 9, "tasks": ["11.2", "11.3"] },
    { "id": 10, "tasks": ["12.1"] }
  ]
}
```

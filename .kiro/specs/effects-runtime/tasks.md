# Implementation Plan: effects-runtime

## Overview

Implements `design.md` for `requirements.md`. Run in orchestrator mode. No user step is needed before code runs (no new dependency; `idb` and `fast-check` are already in `apps/web`). Tasks in one wave touch different files.

## Executor safety rules

1. **No network, no installs.** Never run `pnpm install/add/update`. No test may call a real provider or the network; use scripted, recorded or fake `fetch`, fake timers and fake `Notification`.
2. **Never deploy, never touch a secret.**
3. **Scoped commands**: `pnpm exec vitest run <paths>`, `pnpm --filter @hypergeist/web typecheck`, `pnpm exec eslint <paths>`, `pnpm exec prettier --write <files>`. Full suite only in checkpoint tasks.
4. **No browser in the sandbox.** Write Playwright tests, never run them.
5. **Do not commit or push.** Edit files with the edit tools, not shell writes.
6. **Conventions.** `strict` TypeScript, no `any`, named exports, results as values, never throw for expected failures, components `PascalCase.tsx`, Vitest globals off (import from `vitest`; `cleanup` in `afterEach`), explicit `.ts` import extensions in `apps/web` as the neighbours do. The `--ghost` string never appears in a `.tsx` file. CSS only in existing files named by the task. Tokens only, touch targets at least 24 px, visible focus, reduced motion.
7. **Layers.** `packages/shared` is not changed. Components import AI code only from `apps/web/src/ai/index.ts`. The only `role="status"` in the stack window is the status bar; new live regions use `aria-live="polite"` without a role.
8. **Existing tests stay green**; change an expectation only in files a task names.
9. **Honest reporting.** If a task cannot be finished, say so. Report every deviation from the design.

## Tasks

- [x] 1. Foundations (parallel)
  - [x] 1.1 Reminder types, pure logic and tests: `apps/web/src/reminders/types.ts`, `due-time.ts`, `reminder-logic.ts`, `due-time.test.ts`, `reminder-logic.test.ts`, `due-time.property.test.ts`, `reminder-logic.property.test.ts`
    - Requirements 4.1, 4.2, 4.4, 4.5, 7.2, 7.3. Cover the formats, rejected text, past, over 366 days, impossible dates (2026-02-30), a non-existent DST hour (run the test with a fixed `TZ` only through arguments; do not depend on the host zone: build local times with the same `Date` constructor the code uses and compare), `Z` and offsets, seconds, never throws on random strings. Property: no reminder fires twice and none is lost across random sequences of schedule, time passing, reload and cancel
    - _Requirements: 4.1, 4.2, 4.4, 4.5, 7.3_
  - [x] 1.2 `completeTextWithFallback` and `demoNote` generalisation: `apps/web/src/ai/complete-text-fallback.ts`, its test, edit `ai/fallback.ts` (the `demoNote` parameter type only), `ai/index.ts`
    - Requirements 2.1, 2.5. Tests with scripted providers: proxy error then recorded answer gives `fallback`; `AUTH`, `ABORTED`, `BAD_REQUEST` and `DEMO_ONLY` do not fall back; empty chain gives a `BAD_REQUEST` error; never rejects; `demoNote` still passes its old tests
    - _Requirements: 2.1, 2.5_
  - [x] 1.3 Stack store hook: edit `state/stack-store.ts` and its tests (`stack-store.test.ts`, `stack-store.smoke.test.ts` only where they break)
    - Requirement 1. `attachEffects`, `setStatus`, handler called once with the right kinds and the stack that ran the Handler, detach works, with no handler attached the four messages stay exactly as today, with one attached only `fetch_news` and `transcribe_audio` get the "later release" message, the handler is called synchronously inside `activateButton`
    - _Requirements: 1.1 to 1.4_
  - [x] 1.4 Effects store and context: `state/effects-store.ts`, `state/EffectsContext.tsx`, `state/effects-store.test.ts`
    - Design "Effects store". `useEffects()` returns `null` without a provider
    - _Requirements: 3.1_

- [x] 2. Reminder storage and the runtime
  - [x] 2.1 Reminder repositories: `reminders/idb-reminder-repository.ts`, `memory-reminder-repository.ts`, `open-reminder-repository.ts`, `reminder-repository.contract.ts`, tests
    - Requirements 4.8, 4.9. One contract run against memory and `fake-indexeddb` if the persistence tests already use it (copy their approach; do not add a dependency). Corrupt record dropped on read; `put` over an existing id replaces; `remove` of an unknown id is ok; never throws
    - _Requirements: 4.8, 4.9_
  - [x] 2.2 Effects runtime: `state/effects-runtime.ts`, `effects-runtime.test.ts`, `effects-runtime.property.test.ts`
    - Requirements 2 and 4. Fake timers, fake `Notification` port, scripted providers through an injected `chooseChain`. Cases: field success (stack valid, value written, quota refreshed), rejected operation, other stack open, object deleted meanwhile, provider error text from the fixed table, recorded fallback adds the note, `DEMO_ONLY`, 60 s timeout, double press, 4th concurrent run waits, own mode with missing settings (no silent demo); reminder success text, past time, too far, 51st pending, permission requested once and only when `default`, denied and unsupported sentences, timer fires and marks `fired` with a notice, overdue on `init` becomes `missed`, `visibilitychange` re-check, `cancelReminder`, `dispose` removes listeners and the timer, a throwing repository or `Notification` never throws out. Property: random field results, deletions and stack switches keep the open stack valid
    - _Requirements: 2.1 to 2.7, 4.2 to 4.8, 7.2, 7.3_

- [x] 3. UI (parallel)
  - [x] 3.1 AI field in the UI: edit `components/ObjectView.tsx`, `ObjectView.test.tsx`, `styles/canvas.css` or `controls.css` (whichever holds object styles)
    - Requirement 3. Visible "Thinking..." text, `aria-busy`, new placeholder, polite live region, nothing changes without an `EffectsProvider`
    - _Requirements: 3.1 to 3.3_
  - [x] 3.2 Reminders UI: `components/RemindersWindow.tsx`, `RemindersButton.tsx`, `ReminderNotices.tsx`, tests; edit `MenuBar.tsx` (and its test), `Desktop.tsx` (notices), `styles/window.css`, `styles/controls.css`
    - Requirement 4.4 (notice), 4.7. Button shows the count of pending and missed; window lists message, local due time, state, Cancel and Dismiss, the limit sentence; Escape closes and focus returns; notices dismiss; nothing renders without an `EffectsProvider`
    - _Requirements: 4.4, 4.7_
  - [x] 3.3 Wiring: `components/EffectsRoot.tsx` (or inside `AppRoot.tsx`), edit `AppRoot.tsx`, `AppRoot.ai.test.tsx` or a new `AppRoot.effects.test.tsx`
    - Design "Wiring". Runtime created once, attached and detached, `init` once under StrictMode, reminder repository injected in tests, a button press in a rendered app with a fake provider fills the ai-field
    - _Requirements: 1.1, 2.1, 4.4_

- [x] 4. Stacks, scenarios, text
  - [x] 4.1 Stacks and scenarios: `apps/web/src/stacks/smart-todo.json`, `study-deck.json`, scenario files in `apps/web/src/ai/scenarios/`, `apps/web/src/stacks/showcase-stacks.test.ts`; validate with `pnpm stack validate <file>`
    - Requirements 5 and 6. Tests: both stacks parse, have the specified objects and actions, every ai-field prompt has a scenario, running the Smart To-Do buttons through the store and runtime with the recorded provider fills the field, "Use this time" copies it, "Remind me" with a future time typed by the test stores a reminder and appends the task, the seed set includes both stacks and the thin-slice stack is unchanged (adapt `seed-set.test.ts` and `load-stack.test.ts` expectations only where the number of bundled stacks is pinned)
    - _Requirements: 5.1, 5.2, 6.1 to 6.4_
  - [x] 4.2 Honest text and docs: edit `thin-slice-todo.json` (Limits paragraph) and its tests, `README.md`, create `docs/manual-verification-effects.md`
    - Requirement 7.1, 7.5. Manual cases `E-01...`: real model fills each field, wrong date correction flow, notification allowed, blocked, unsupported, reminder fires with the tab in the background, missed reminder after closing the tab, reload keeps reminders, Memory_Mode, quota counter after a run, own key, 200% zoom, phone width, reduced motion. Mark which need the deployed Worker or a real provider
    - _Requirements: 7.1, 7.5_

- [x] 4b. Findings from task 4.1 (added 2026-11-17)
  - [x] 4.3 First stack and seeded count: all bundled stacks are seeded with the same `savedAt`, so `smart-todo` sorted first and became the first-run stack, which breaks `e2e/thin-slice.spec.ts`, `e2e/ai.spec.ts` and `e2e/persistence.spec.ts` (they expect the thin-slice stack and one seeded stack). Decision: the thin-slice to-do stays the first-run stack for now (the order can change in the polish pass). Seeding gives the bundled stacks a fixed order (thin-slice first, then smart-todo, then study-deck) through strictly ordered `savedAt` values; update the seed, boot and Stacks window tests that pin the order or count; update the count assertions in `e2e/persistence.spec.ts` to the new seeded count (three) by deriving them from one constant, and any other e2e text that assumes one seeded stack. Write only, do not run e2e
  - [x] 4.4 Smart To-Do: "3. Remind me" no longer appends the task (the append ran even when the reminder was rejected and again on every press). Add a separate button "Add to my list" that appends the task. Update `smart-todo.json`, `showcase-stacks.test.ts`, the how-to text inside the stack, `README.md` and `docs/manual-verification-effects.md` (case E-11 and the button names)

- [x] 5. e2e and verification
  - [x] 5.1 Write `e2e/effects.spec.ts` (write only, do not run)
    - Requirement 7.4. Locators by role and accessible name copied from the components. The Worker answers 503 for the AI in e2e, so the recorded fallback answers. Stub `Notification` with `page.addInitScript`. The reminder test types a time a few minutes ahead computed in the test
    - _Requirements: 7.4_
  - [x] 5.2 Run the full suite
    - `pnpm format` then `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm check:deps`; `pnpm test` with `HYPERGEIST_TEST_SEED=1`, `20261115`, `424242`; `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false pnpm build`; `pnpm stack validate` on all three bundled stacks; no `--ghost` in any `.tsx`; `.kiro` not ignored; no dependency change. Record each result. Update `docs/handoff.md`, `.kiro/steering/project-status.md` (also the "Last updated" date) and `docs/kiro-journal.md`; do not claim the e2e run or manual checks passed
    - _Requirements: 7_

- [ ] 6. USER CHECKPOINT: run `pnpm test:e2e` (Developer). After it passes, use "Restore demo stacks" in the Stacks window to get the two new stacks in a browser that already seeded.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["2.2"] },
    { "id": 3, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 4, "tasks": ["4.1", "4.2"] },
    { "id": 5, "tasks": ["5.1"] },
    { "id": 6, "tasks": ["5.2"] },
    { "id": 7, "tasks": ["6"] }
  ]
}
```

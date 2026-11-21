# Implementation Plan: ai-assistant-ui

## Overview

Implements `design.md`. Run in orchestrator mode. No user step is needed before code runs (no new dependency). Tasks in one wave touch different files.

## Executor safety rules

1. **No network, no installs.** Never run `pnpm install/add/update`. No test may call a real provider or the network; use scripted, recorded or fake `fetch`.
2. **Never deploy, never touch a secret** (no `wrangler deploy`, `secret`, `login`). The dry-run build needs `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false`.
3. **Scoped commands**: `pnpm exec vitest run <paths>`, `pnpm --filter @hypergeist/web typecheck`, `pnpm --filter @hypergeist/worker typecheck`, `pnpm exec eslint <paths>`, `pnpm exec prettier --write <files>`. Full suite only in checkpoint tasks.
4. **No browser in the sandbox.** Write Playwright tests, never run them.
5. **Do not commit or push.**
6. **Conventions.** `strict` TypeScript, no `any`, named exports, results as values, components `PascalCase.tsx`, Vitest globals off (import from `vitest`; `cleanup` in `afterEach`). No `--ghost` string in any `.tsx` file; the accent is applied by a CSS class (the CSS scan test fails otherwise). CSS only in the existing files named by the task (a test pins the file list). Follow `.kiro/steering/design-language.md`: tokens only, hard edges, touch targets at least 24 px, visible focus, reduced motion.
7. **Imports.** Components import AI code only from `apps/web/src/ai/index.ts`. The only `role="status"` inside the stack window is the status bar hint: new live regions use `aria-live="polite"` without a role.
8. **Existing tests stay green**; change an expectation only in the files a task names.
9. **Honest reporting.** If a task cannot be finished, say so.

## Tasks

- [x] 1. Worker origin fix
  - [x] 1.1 Change `apps/worker/src/lib/origin.ts`, its test, `chat-route.ts`, `quota-route.ts` (pass the method) and their tests; update `docs/manual-verification-worker.md` and `docs/deployment.md` where they describe the origin check or the quota `curl`
    - Requirement 6. `checkOrigin(headers, allowedOrigins, method)`. Tests: GET with no Origin and `Sec-Fetch-Site: same-origin` passes, GET without `Sec-Fetch-Site` fails, POST without Origin fails even with `same-origin`, GET with a wrong Origin fails, HEAD behaves like GET, `cross-site` fails. The `curl` examples for quota need `-H 'Sec-Fetch-Site: same-origin'` (curl has no Origin on GET, so say so). Update `app.test.ts` and the property test only if they break
    - _Requirements: 6.1, 6.2_
  - [x] 1.2 Stack store: AI edit mode and `applyStack`
    - Edit `state/stack-store.ts`, `state/hints.ts`, `components/ModeControl.tsx`, `Desktop.tsx` (Alt+M cycle goes through `toggleMode`), and every component or lib that tests `'edit'` (Canvas, ObjectView, SelectionOverlay, PropertyReadout, StatusBar, `lib/*`): find them with a search for `'edit'`. Tests updated and added: three-way toggle, selection in `ai-edit`, buttons inert in `ai-edit`, `applyStack` cases (keeps mode, keeps or resets current card, keeps or clears selection, new reference triggers subscribers, input not mutated), hint text, status bar text "Mode: AI edit", the mode control radios. Requirement 2.1, 2.2, 2.4
    - _Requirements: 2.1, 2.2, 2.4_

- [x] 2. AI store and controller
  - [x] 2.1 Create `state/ai-store.ts`, `state/ai-controller.ts`, `state/AiContext.tsx`, tests; wire `AppRoot.tsx`
    - As in the design. Controller tests with the scripted provider (inject `chooseProvider` or build real chains over a fake `fetch`): success (stack replaced, Undo entry pushed, lines added), partial, failed (no change, no undo), aborted (Stop), history cut to 6, own mode with missing settings (error line, no silent demo), demo fallback note, `makeStack` returns the stack for `done` and `partial` and null for `failed`, undo pops and restores, undo list capped at 10, busy blocks a second send, never throws on a throwing provider, quota refresh sets and hides the counter (fake `fetch` returning 200, 403, throwing, malformed JSON), `checkProvider` sets `jsonMode` when tool calling is `no`, settings save keeps the key out of storage (read the settings DB after saving). `AppRoot` creates and provides them (test: the provider is present, `init` is called once, the stack store reference is the one the controller uses)
    - _Requirements: 1.2 to 1.6, 1.9, 3.2, 4.3, 4.4, 5_

- [x] 3. Components
  - [x] 3.1 Ghost chat panel: `components/GhostWindow.tsx`, `GhostWindow.test.tsx`, `styles/ghost.css`
    - Requirement 1 and 2.3. Existing `GhostWindow.test.tsx` expectations about the sleeping Ghost change: without a provider show the sprite and "AI is not available in this build"; with a provider the full panel. Tests: send by button and Enter, Shift+Enter newline, Example_Prompt fills the input, thinking class while busy, Stop, Undo enabled only when an entry exists and not busy, lines rendered per kind, selected chip in AI edit mode, `aria-live` present and no role `status`
  - [x] 3.2 AI settings: `components/AiSettingsDialog.tsx`, `DemoCounter.tsx`, tests; edit `MenuBar.tsx` (and its test), `styles/controls.css`
    - Requirement 4 and 5. Tests: demo default, switching to own shows the three fields, URL validation messages, "Check this model" shows capability messages, Save writes settings and key holder, the memory-only and privacy sentences are present, Escape closes and focus returns to the button, counter text for N, 0 and hidden
  - [x] 3.3 Make a stack with the Ghost: `components/MakeStackSection.tsx`, test; edit `StacksWindow.tsx` (and its test), `styles/window.css`
    - Requirement 3. Tests with the recorded scenarios and an in-memory repository: "Make me a to-do list" creates, stores and opens a valid stack with a field, a list and a button, and the new stack's card works through the store (typing and Add append an item), a failed Turn stores nothing and shows the Ghost message, Stop, busy state, the Example_Prompt buttons

- [x] 4. Text, tests of the whole path, docs
  - [x] 4.1 Honest text
    - Rewrite the Limits card paragraph about AI in `apps/web/src/stacks/thin-slice-todo.json` (demo answers come from a shared model or recorded examples; an own key is kept only in memory; the AI can be wrong; every AI change can be undone with Undo), update `demo-stack.test.ts`, `App.startup.test.tsx`, and any other test that reads the old text; update `README.md` (replace "No AI" in the limits list and the sentence in the AI orchestrator section that nothing calls it; add a short "Using the Ghost" section); validate with `pnpm stack validate apps/web/src/stacks/thin-slice-todo.json`
  - [x] 4.2 Write `e2e/ai.spec.ts` and update `e2e/thin-slice.spec.ts` (write only, do not run)
    - The Ghost text assertion in `thin-slice.spec.ts` (about "AI arrives in a later release") changes. New tests as in Requirement 7.3; locators by role and accessible name copied from the components. In e2e the Worker serves `/api/ai/chat` with the AI disabled (no model variable), so the proxy answers 503 and the controller falls back to the recorded examples with the demo note; the quota route answers 503 and the counter stays hidden
  - [x] 4.3 Write `docs/manual-verification-ai-ui.md`
    - Cases `U-01...` in the style of the other manual files: each chat path, AI edit with a real model, own key and base URL, JSON fallback, errors (wrong key, offline), Stop, Undo, quota counter on a deployed Worker, privacy sentences, keyboard, 200% zoom, phone width, reduced motion. Mark which need a real provider or the deployed Worker

- [x] 5. Final verification
  - [x] 5.1 Run the full suite
    - `pnpm format` then `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm check:deps`; `pnpm test` with `HYPERGEIST_TEST_SEED=1`, `20261115`, `424242`; `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false pnpm build`; `pnpm stack validate apps/web/src/stacks/thin-slice-todo.json`; no `--ghost` in any `.tsx`; `.kiro` not ignored; no dependency change. Record each result. Update `docs/handoff.md`, `.kiro/steering/project-status.md` and `docs/kiro-journal.md` (do not claim the e2e run or manual checks passed)

- [x] 6. USER CHECKPOINT: run `pnpm test:e2e` (Developer). Passed 22 of 22 on 2026-11-17, after two fixes (exact radio names in `e2e/thin-slice.spec.ts`; cancel the unread body of a non-OK quota response in `ai-controller.ts`)

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1"] },
    { "id": 2, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 3, "tasks": ["4.1", "4.3"] },
    { "id": 4, "tasks": ["4.2"] },
    { "id": 5, "tasks": ["5.1"] },
    { "id": 6, "tasks": ["6"] }
  ]
}
```

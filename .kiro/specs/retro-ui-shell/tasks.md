# Implementation Plan: retro-ui-shell

## Overview

Implements `design.md`. Run in orchestrator mode. No user step is needed before code runs (no new dependency). Tasks in one wave edit different files. The order puts what a reviewer sees first (waves 0 and 1) and the cut candidates last.

## Executor safety rules

1. **No network, no installs.** Never run `pnpm install/add/update`.
2. **Never deploy, never touch a secret.**
3. **Scoped commands**: `pnpm exec vitest run <paths>`, `pnpm --filter @hypergeist/web typecheck`, `pnpm exec eslint <paths>`, `pnpm exec prettier --write <files>`. Full suite only in the final task.
4. **No browser in the executor shell.** Write Playwright tests, never run them. Visual checks are done by the orchestrator with the browser tool and saved in `docs/ui-audit/after/`.
5. **Do not commit or push.** Do not add authorship or tool-credit text anywhere (code, comments, docs, commit text).
6. **Conventions.** `strict` TypeScript, no `any`, named exports, components `PascalCase.tsx`, Vitest globals off (import from `vitest`; `cleanup` in `afterEach`). No `--ghost` string in any `.tsx` file. CSS only in the existing files a task names (a test pins the CSS file list; a task that needs a new CSS file also edits that test). Follow `.kiro/steering/design-language.md`: tokens only, hard edges, 24 px targets, visible focus, reduced motion.
7. **Imports.** Components import AI code only from `apps/web/src/ai/index.ts`. The only `role="status"` inside the stack window is the status bar hint; new live regions use `aria-live="polite"`.
8. **Narrow layouts.** Wherever the requirements say "under 700 px", use `@media (orientation: portrait)`, as `window.css` and `ghost.css` already do: the CSS scan test forbids literal lengths in media queries and a media query cannot read a token.
9. **Existing tests stay green**; change an expectation only in the files a task names.
10. **Honest reporting.** If a task cannot be finished, say so.

## Tasks

- [x] 1. Foundations (parallel)
  - [x] 1.1 Gesture math: `lib/gesture.ts`, `lib/gesture.test.ts`, `lib/gesture.property.test.ts`
    - Requirement 1.2, 1.8. Pure functions `applyGesture`, `rectToChanges` as in the design. Property tests with the repo's seed helper
    - _Requirements: 1.2, 1.8_
  - [x] 1.2 History in the stack store: `state/stack-store.ts`, `state/stack-store.test.ts`
    - Requirement 2.4. `past`, `future` (entries carry `source: 'user' | 'ai'`), `commitStack`, `editObject`, `addObjectToCard`, `removeSelected`, `addCard`, `deleteCurrentCard`, `undoEdit`, `redoEdit`, `goToCard`, and a selector `lastEntrySource`; `applyStack` records (source from its caller, default `'ai'`); `replaceStack` clears. Tests: limit 50, clear on replace, rejection leaves the stack and sets status, undo and redo keep card and selection when valid, input never mutated. Also change `ai-controller.ts` and `ai-store.ts` so the Ghost's Undo calls `undoEdit()` and the separate AI undo list is removed (update their tests)
    - _Requirements: 1.3, 1.4, 2.1 to 2.4, 3.2, 3.3_
  - [x] 1.3 CSS test and tokens: `styles/css-tokens.test.ts`, `styles/tokens.css`
    - Requirement 5.5. `ghost.css` may reference `--ghost`; add any new tokens the later tasks list (handle hit size, card bar width, chat window size, sprite size steps). Keep the `.tsx` rule
    - _Requirements: 5.5, 8.3_
  - [x] 1.4 Sound module: `lib/sound.ts`, `lib/sound.test.ts`
    - Requirement 7.2, 7.3. `createSound()` as in the design with a fake `AudioContext` in tests

- [ ] 2. Interaction (parallel, after wave 1)
  - [ ] 2.1 Move and resize on the Canvas: `components/useObjectGesture.ts`, `ObjectView.tsx`, `SelectionOverlay.tsx`, `Canvas.tsx`, `styles/canvas.css`, tests
    - Requirement 1. Pointer layer, preview rect, one `editObject` per Gesture, Escape cancels, handle hit areas and cursors, arrow keys, only in Edit mode. Tests: drag by simulated pointer events in jsdom (a drag below 3 px selects only, a move commits one edit, a resize clamps, Escape cancels, a rejected edit snaps back, AI edit and Interact do not move)
    - _Requirements: 1.1 to 1.7_
  - [ ] 2.2 Card bar: `components/CardBar.tsx`, `StackWindow.tsx`, `styles/window.css` (card bar rules only), tests
    - Requirement 3. Vertical bar, current marked, keyboard list, Add card, Rename and Delete in Edit mode, horizontal under 700 px
    - _Requirements: 3.1 to 3.5_
  - [ ] 2.3 Tools panel (properties, add object, undo and redo): `components/PropertyReadout.tsx` (becomes the Tools panel), `Desktop.tsx` (Ctrl or Cmd plus Z, Delete), `styles/controls.css`, tests
    - Requirement 2. One fixed-width column in Edit mode: property editor (including x, y, width, height) when something is selected, Add object, Undo and Redo when not; error line under a field; Delete key; keys ignored in text inputs
    - _Requirements: 2.1 to 2.4_

- [ ] 3. Ghost and Stacks (parallel with wave 2)
  - [ ] 3.1 Ghost dock and Chat window: `components/GhostDock.tsx`, `ChatWindow.tsx`, `GhostWindow.tsx` (body reuse), `Desktop.tsx` (remove the rail; mount the dock in `StackWindow`; coordinate the one `Desktop.tsx` edit with 2.3 by doing the rail removal in this task and the keyboard keys in 2.3 as separate small edits, run these two tasks one after the other if both touch it), `state/ui-store.ts`, `styles/ghost.css`, `styles/window.css` (chat window rules only), tests
    - Requirement 4. Closed by default, dock toggle, Escape, focus return, marker when a Turn ends while closed, open on AI-edit selection, bottom sheet under 700 px. Update the tests that expect the rail Ghost (`App.startup.test.tsx`, `GhostWindow.test.tsx`)
    - _Requirements: 4.1 to 4.7_
  - [ ] 3.2 Ghost animation: `components/GhostSprite.tsx`, `lib/ghost-state.ts`, `state/ai-store.ts` (`lastEvent`), `state/ai-controller.ts` (set it), `styles/ghost.css` (animation rules), tests, `docs/assets-licenses.md`
    - Requirement 5. Six states as pixel maps, `deriveGhostState` with a fake clock, accent classes, reduced-motion static frames
    - _Requirements: 5.1 to 5.6_
  - [ ] 3.3 Stacks window redesign: `components/StacksWindow.tsx`, `StackList.tsx`, `StacksMore.tsx`, `MakeStackSection.tsx`, `styles/window.css` (stacks rules only), tests
    - Requirement 6. All existing actions reused unchanged; layout, wording and disclosure change; adjust existing tests only where labels moved
    - _Requirements: 6.1 to 6.6_

- [ ] 4. Menu bar and text
  - [ ] 4.1 Sound toggle: `components/SoundToggle.tsx`, `MenuBar.tsx`, `ModeControl.tsx` (mode blip), `styles/controls.css`, tests
    - Requirement 7
    - _Requirements: 7.1 to 7.3_
  - [ ] 4.2 Honest AI-field text: `components/ObjectView.tsx` and the tests that read it; README line about the UI
    - Requirement 8.1
    - _Requirements: 8.1_

- [ ] 5. Checks and docs
  - [ ] 5.1 Write `e2e/ui-shell.spec.ts` (write only) and update specs that expect the old layout (`e2e/thin-slice.spec.ts`, `e2e/ai.spec.ts`, `e2e/persistence.spec.ts`)
    - Requirement 9.2. Locators from the components
    - _Requirements: 9.2_
  - [ ] 5.2 Write `docs/manual-verification-ui-shell.md`
    - Requirement 9.3. Cases for drag and resize at 1x and 2x, keyboard, Card bar, Ghost animations (each state), reduced motion, phone width, sound
  - [ ] 5.3 Full verification
    - `pnpm format` then `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm check:deps`; `pnpm test` with `HYPERGEIST_TEST_SEED=1`, `20261115`, `424242`; `pnpm build`; no `--ghost` in any `.tsx`; `.kiro` not ignored; no dependency change. Orchestrator then runs the app with the browser tool and saves screenshots in `docs/ui-audit/after/`. Update `docs/handoff.md`, `.kiro/steering/project-status.md`, `docs/kiro-journal.md`; do not claim the e2e run or manual checks passed

- [ ] 6. USER CHECKPOINT: run `pnpm test:e2e` (Developer)

## Cut order if time runs short

Last in, first cut: sound (1.4, 4.1), the Add object part of 2.3 and the Delete key, the Delete card button, the "More" Trash and Restore polish in 3.3, bottom-sheet layout under 700 px. Never cut: move and resize (1.1, 1.2, 2.1), Card bar selection, Ghost dock and Chat window, Stacks window redesign, Ghost animation states.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["2.1", "2.2", "3.2", "3.3"] },
    { "id": 2, "tasks": ["2.3", "3.1"] },
    { "id": 3, "tasks": ["4.1", "4.2"] },
    { "id": 4, "tasks": ["5.1", "5.2"] },
    { "id": 5, "tasks": ["5.3"] },
    { "id": 6, "tasks": ["6"] }
  ]
}
```

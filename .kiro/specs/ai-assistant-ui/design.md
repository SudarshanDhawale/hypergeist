# Design Document

## Overview

Three small layers. (1) `stack-store` learns the third mode and one new action, `applyStack`. (2) A React-free `ai-controller` plus an `ai-store` run Turns and own the chat log, busy flag, undo list, settings and quota. (3) Thin React components render them: Ghost chat panel, AI settings dialog, demo counter, "make a stack" section. `AppRoot` creates the controller once and provides it through a context; components never import `apps/web/src/ai` internals, only its `index.ts`.

No new dependency. No change to `packages/shared`. One Worker fix (Requirement 6).

## Stack store changes (`state/stack-store.ts`)

- `type Mode = 'interact' | 'edit' | 'ai-edit'`. `toggleMode` cycles interact, edit, ai-edit, interact. `selectObject` and `clearSelection` work in `edit` and `ai-edit`. `activateButton`, `typeInField` and `followLink` stay `interact` only.
- New action `applyStack(stack: Stack)`: sets `stack`; keeps `mode`; keeps `currentCardId` if that card still exists, else uses `stack.startCardId`; keeps `selectedObjectId` only if that object still exists on the current card; clears `status`; does not touch `statusSeq`. It is how both an AI Turn and Undo change the open stack (the autosave subscriber sees a new `stack` reference and saves).
- `hints.ts`: `hintForMode(mode)` gains `AI_EDIT_HINT`.
- Everything that tests `mode === 'edit'` for selection, the Property_Readout, the selection overlay and the Canvas cursor/styling accepts `ai-edit` too (grep for `'edit'`); the status bar shows "Mode: AI edit".

## AI store and controller

`state/ai-store.ts` (zustand vanilla, same style as the other stores):
```ts
type ChatLine = { id: number; kind: 'user' | 'ghost' | 'step' | 'note' | 'error'; text: string };
type AiState = {
  lines: readonly ChatLine[]; busy: boolean; thinkingSeq: number;
  undo: readonly { stack: Stack; label: string }[];      // newest first, at most 10
  settings: AiSettings; hasKey: boolean; capability: CapabilityReport | null; jsonMode: boolean;
  quota: { remaining: number } | null;                    // null hides the counter
};
```
with plain actions (`addLines`, `setBusy`, `pushUndo`, `popUndo`, `setSettings`, `setQuota`, ...), each pure over state.

`state/ai-controller.ts`: `createAiController(deps)` with `deps = { stackStore, aiStore, settingsRepo, keyHolder, fetch, scenarios, now, setTimeout? }` returning:
- `send(text)`: ignore when busy or the text is empty; add the user line; set busy; `chooseProviderChain({ settings, getKey: keyHolder.get, fetch, scenarios })` (not ok: add an error line with its message and stop); build `TurnInput` from the stack store (`stack`, `currentCardId`, `selectedObjectId` only when mode is `ai-edit`, `history` = the last 6 user and Ghost lines, `newStack: false`, `jsonMode` from the store, `clock: now`, `signal` from a new `AbortController`); `await runTurnWithFallback`; add Ghost lines (say texts, one step line per step via `describeCall`/`describeResult` semantics already in `step.description`, a status line, the `demoNote`); when `after !== before`, push an Undo entry (`before`, label = first step description) and call `stackStore.applyStack(after)`; store `usedJsonMode`; refresh the quota; clear busy. Never throws.
- `makeStack(text, { takenIds })`: same but with `startNewStack({ takenIds })`, `newStack: true`, and returns `{ result, stack | null }` (stack when status is `done` or `partial`); no Undo entry, no `applyStack`; the caller (Stacks window) stores and opens the stack. Uses a separate `busy` flag `busyNewStack` so the chat and the Stacks window do not block each other incorrectly (both disable only their own Send).
- `undo()`: pop and `applyStack`; add a note line.
- `stop()`: abort the running Turn's controller.
- `saveSettings(next, key?)`, `checkProvider()` (runs `detectCapabilities` with the key holder, stores the report, sets `jsonMode` when tool calling is `no`), `refreshQuota()` (demo only: `fetch('/api/ai/quota', { credentials: 'omit' })`, parse `{ dailyLimit, dailyUsed, visitorLimit, visitorUsed }` with Zod, `remaining = max(0, min(daily - dailyUsed, visitor - visitorUsed))`; any failure sets `quota: null`), `init()` (load settings from the repository, refresh quota).

## Components (all plain, tokens only)

- `GhostWindow.tsx`: sprite (class `is-thinking` while busy; CSS in `ghost.css` colors it with the accent), message log (`aria-live="polite"`, no role), selected-object chip, input (textarea, Enter sends), Send / Stop, Example_Prompt buttons, Undo button. Title bar stays "Ghost". The accessible name no longer says AI is absent.
- `AiSettingsDialog.tsx` (uses `Modal`), opened from a new "AI settings" button in `MenuBar.tsx`; `DemoCounter.tsx` next to it.
- `StacksWindow.tsx` gets the "Make a stack with the Ghost" section (a small `MakeStackSection.tsx` component to keep the file readable).
- `ModeControl.tsx` gets the third radio.
- Providers: `state/AiContext.tsx` (`AiProvider({ controller, store })`, `useAi()` returning `null` when absent so existing tests that render components bare keep working; components render nothing AI-related without a provider, except `GhostWindow`, which then shows the old sleeping sprite with the line "AI is not available in this build").

CSS goes only into existing files: `ghost.css` (Ghost panel and thinking class), `controls.css` (inputs, chips, counter), `window.css` (dialogs and the make-stack section). The test `css-tokens.test.ts` pins the file list.

## Wiring in `AppRoot`

`AppRoot` creates, once per mount: the key holder, the settings repository (`createSettingsRepository()`), the scenarios (`loadScenarios()` and its `scenarios` array), the AI store and the controller (with the real `fetch` looked up at call time, `Date.now` through the existing `clock`), calls `controller.init()`, and wraps the tree in `AiProvider`. The controller reads the open stack through the stack store of the current mount; since the stack store is created once per app (after the persistence change), it holds one reference. `AppRoot` tests inject `fetch` and `scenarios`.

## Worker fix

`checkOrigin(headers, allowedOrigins, method)`: with no `Origin`, return true only when `method` is `GET` or `HEAD` and `Sec-Fetch-Site` is `same-origin`; otherwise as before. `handleChat` passes `POST`, `handleQuota` passes `GET`.

## Honest text

New Limits paragraph for the bundled stack and the Ghost fallback line; the settings dialog copy from Requirement 4.2; the Ghost status lines never claim success when the status is `partial` or `failed`.

## Verification

Unit tests next to each file (controller with the scripted provider and the recorded provider; store; components with testing-library); Playwright specs written, not run here (`e2e/ai.spec.ts`); manual file `docs/manual-verification-ai-ui.md`.

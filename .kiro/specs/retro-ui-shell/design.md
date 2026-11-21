# Design Document

## Overview

Five pieces, each in its own files so they can be built in parallel. No change to `packages/shared` or the stack format. The engine is used as it is (`applyOperation` with `update_object`, `add_object`, `remove_object`, `create_card`, `delete_card`).

1. **Gestures** (move and resize): a pure math module plus a pointer layer on the Canvas.
2. **History**: one shared undo and redo stack of whole stacks in the stack store.
3. **Card bar** and **property editor**.
4. **Ghost dock, Chat window and Ghost animation.**
5. **Stacks window redesign**, **menu bar clock and sound**.

## 1. Gestures

`lib/gesture.ts` (pure, no React):

```ts
type Rect = { x: number; y: number; w: number; h: number };            // card units
type Handle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
applyGesture(start: Rect, handle: Handle, dx: number, dy: number,   // dx, dy in card units (already divided by scale and rounded)
             card: { w: number; h: number }, limits: { min: number; max: number }): Rect
```

Rules: `move` shifts x and y and clamps so `0 <= x`, `x + w <= card.w` (same for y). A resize handle moves only its edges; width and height stay within `limits` and the opposite edge stays fixed (when the minimum is hit, the moving edge stops); the result is clamped to the card. All outputs are integers. `rectToChanges(rect)` gives the `update_object.changes` object (`x`, `y`, `width`, `height`, only those that differ). Properties (fast-check): output always inside the card and within limits for any inputs; applying a gesture with `dx = dy = 0` returns the start; `move` keeps `w` and `h`; a resize never moves the opposite edge unless clamped by the card edge.

Pointer layer (`components/useObjectGesture.ts` and changes in `ObjectView.tsx`, `SelectionOverlay.tsx`, `Canvas.tsx`): `pointerdown` on an object body in Edit mode selects it and starts a `move` Gesture after 3 px of travel (so a click stays a click); `pointerdown` on a handle starts a resize. Uses `setPointerCapture`, `pointermove` computes `dx = round((clientX - startX) / scale)`, stores the preview rect in a local `useState` and passes it to the object and the selection overlay as `--x --y --w --h` overrides (the CSS already reads those variables). `pointerup` commits one `applyOperation('update_object', { id, changes })` through a new store action `editObject(id, changes)` (see History); Escape cancels. The selection overlay becomes interactive (`pointer-events: auto` on the handles only), and each handle gets a 24 px hit area with a pseudo-element, the cursor from a map, and `touch-action: none`. Keyboard: the object wrapper (already focusable) handles arrows with `applyGesture` and the same store action.

The Canvas keeps `chooseCanvasScale` unchanged. Text sizes inside objects stay on the `--canvas-fs` scale.

## 2. History

`stack-store.ts` gains `past: Stack[]`, `future: Stack[]` (at most 50 each), and actions:

- `commitStack(next, { source })`: pushes `{ stack: current, source }` to `past`, clears `future`, sets `stack`. `applyStack(stack, source = 'ai')` (used by AI Turns) keeps its behavior and now also records. Manual actions pass `'user'`.
- The Ghost's Undo is enabled when the newest `past` entry has `source: 'ai'` and no Turn runs; it calls `undoEdit()`. The AI undo list of `ai-store` and its cap of 10 are removed.
- `editObject(id, changes)`, `addObjectToCard(type)`, `removeSelected()`, `addCard()`, `deleteCurrentCard()`, `renameCurrentCard(name)`: each calls `applyOperation`; on `ok` they call `commitStack`; on rejection they set `status` to the first error message and change nothing.
- `undoEdit()` and `redoEdit()`: move one entry between `past` and `future` and set the stack (keeping the current card and selection when they still exist, as `applyStack` does).
- `replaceStack` (open another stack) clears both lists.

The existing AI undo list (`ai-store`) is kept for the Ghost's Undo button and its note line, but it now calls `undoEdit()`-compatible logic: the Ghost's Undo restores the stack that was current before the Turn, only if the current stack is still the one the Turn produced; otherwise it says so (existing safeguard). Ctrl or Cmd plus Z and Shift plus Z are handled in `Desktop.tsx` and ignored while focus is in a text input or textarea.

## 3. Card bar and property editor

`components/CardBar.tsx`: `<nav aria-label="Cards">` with a `<ul>` of buttons (`aria-current="true"` on the current one). It reads `stack.cards` and calls a `goToCard(id)` store action (add it if the store only has `followLink`; it sets `currentCardId`, clears the selection). Edit mode shows a final "Add card" button and a "Card" row with Rename and Delete. CSS in `window.css`: vertical on wide screens, a horizontal flex strip under 700 px (`@media`).

`components/PropertyReadout.tsx` becomes `PropertyEditor` in Edit mode (the read-only readout remains for AI edit): labeled controls per object type, each committing on blur or Enter via `editObject`; an inline error line under the field shows a rejection. The "Add object" row (`ObjectPalette.tsx`) lists Button, Field, List, Image and calls `addObjectToCard(type)` with these defaults: button 96x28 labeled "Button"; field 160x28; list 160x96; image 96x96 with alt "Image"; at x 16, y 16 shifted by 8 per existing object so new objects do not stack exactly (clamped).

## 4. Ghost dock, Chat window, animation

- `GhostDock.tsx`: a button at the bottom right of `.stack-window` (absolute inside it), holds `GhostSprite` with `state` from `useGhostState()`. State `open` lives in a small `ui-store` (zustand vanilla) so the AI-edit selection can open it.
- `ChatWindow.tsx`: the current `GhostWindow` content moved here (the file `GhostWindow.tsx` keeps the chat body and is reused). It is a `role="dialog"` non-modal (`aria-modal="false"`, `aria-labelledby`), anchored above the dock, with the standard title bar, a close box and Escape. Focus moves to the input when it opens and back to the dock when it closes. Under 700 px it is `position: fixed; inset: auto 0 0 0` as a bottom sheet.
- `useGhostState()`: pure function `deriveGhostState(aiState, now)` plus a hook that re-renders at the next boundary with `setTimeout` (modifying 1200 ms, done 1200 ms, error 3000 ms). The controller exposes `lastEvent: { kind: 'changed' | 'error' | 'none'; at: number }` in the AI store, set when a Turn applies a change or ends with an error. Tests use a fake clock.
- `GhostSprite.tsx`: frames are pixel maps (arrays of strings, as today) per state. Rendering stays SVG rects. Animation: the sprite renders all frames of the current state stacked in one SVG group and a CSS `steps(n, end)` animation on a `.frame` class toggles visibility, or one `<svg>` per frame with `animation-delay`; whichever keeps `--ghost` out of the `.tsx` (colors come from classes `.ghost-accent` in `ghost.css`, set by the state). `prefers-reduced-motion: reduce` sets `animation: none` and shows the first frame of each state (poses differ).
- `css-tokens.test.ts`: the "does not reference --ghost" check skips `ghost.css` (by file name); the `.tsx` check stays.

## 5. Stacks window, menu bar

`StacksWindow.tsx` is rebuilt as three parts, reusing every existing action function (`beforeAction`, `run`, open, import, export, delete, restore, empty trash). New or changed files: `StackList.tsx` (rows as a `role="listbox"` with `aria-activedescendant` or simple buttons; Up and Down move, Enter opens), `MakeStackSection.tsx` (visual change only: one input row plus chips), `StacksMore.tsx` (a `<details>`-style disclosure built with a button and `aria-expanded`). Time text uses `Intl.DateTimeFormat` in local time with "Saved today at 14:05" wording. `window.css` changes; existing StacksWindow tests keep their behavior assertions and change only where labels moved ("Make it" and the examples stay).

Menu bar: `SoundToggle.tsx` with `lib/sound.ts` (`createSound()` returns `{ play(name), setEnabled(b), isSupported() }`, lazily creating the `AudioContext` on the first user gesture, with five square-wave blips from frequency and duration tables; the toggle persists through `localStorage` inside try and catch). Sound is invoked from the mode control, the dock, the Chat window open and close, and Turn end. Tests use a fake `AudioContext`.

## Honest text

The AI-field placeholder in `ObjectView.tsx` and the tests that read it.

## Verification

Vitest next to each file (gesture math with properties; store history; components with testing-library; Ghost state with a fake clock). Playwright specs written, not run here (`e2e/ui-shell.spec.ts`). Manual file `docs/manual-verification-ui-shell.md`. The agent shell has no browser, so after each wave the Developer or the Playwright browser tool run gives the visual check; screenshots of the results go in `docs/ui-audit/after/`.

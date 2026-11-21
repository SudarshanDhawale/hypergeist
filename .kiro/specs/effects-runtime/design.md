# Design Document

## Overview

Four small pieces, all in `apps/web`. No change to `packages/shared`, no Worker change, no new dependency.

1. **Store hook.** `stack-store` forwards effect requests to an attached handler.
2. **Effects runtime.** A React-free `createEffectsRuntime(deps)` carries out `run_ai_field` and `schedule_notification` and owns the effects store.
3. **Reminders.** Pure time logic, a repository (own IndexedDB database), a Reminders window.
4. **Two stacks** and their recorded scenarios.

## Stack store (`state/stack-store.ts`)

- New action `attachEffects(handler: EffectsHandler | null): () => void`. The handler lives in a closure variable of `createStackStore`, not in the state. It returns a detach function. `type EffectsHandler = (effects: readonly EffectRequest[], snapshot: Stack) => void`.
- In `applyResult`'s caller (`activateButton`): after `set(...)`, if a handler is attached, call it with the effects of the kinds `run_ai_field` and `schedule_notification` (if any) and the stack that ran the Handler. The handler is called synchronously, still inside the click, so `Notification.requestPermission()` stays inside the user gesture.
- `effectMessage` is produced only for kinds that have no handler: with a handler attached, only `fetch_news` and `transcribe_audio`; with none attached (existing tests, bare renders), all four, as today.
- New action `setStatus(text: string)`: same as the end of `applyResult` (`status` and a new `seq`).

## Effects store (`state/effects-store.ts`)

Zustand vanilla, same style as `ai-store`:
```ts
type EffectsState = {
  running: ReadonlySet<string>;            // ai-field object ids being filled (key: stackId + '/' + objectId)
  reminders: readonly Reminder[];          // newest due first within state
  notices: readonly { id: string; text: string }[];   // in-app "reminder due" notices
};
```
Plain actions: `setRunning(key, on)`, `setReminders(list)`, `addNotice`, `dismissNotice`.

## Effects runtime (`state/effects-runtime.ts`)

`createEffectsRuntime(deps)` with `deps = { stackStore, effectsStore, aiStore, chooseChain, keyHolder, scenarios, fetch, reminderRepo, now, setTimeout, clearTimeout, notification?: NotificationPort, refreshQuota }` and the result `{ handle(effects, snapshot), init(), cancelReminder(id), dismiss(id), dispose() }`.

### `run_ai_field`

`handle` for each effect, in order, with at most 3 running at once (a small queue):
1. key = `snapshot.id + '/' + targetObjectId`; skip if running.
2. `chosen = chooseChain(...)`. Not ok: `setStatus(chosen.message)`; stop.
3. Mark running. Inputs = `effect.inputs` plus `{ objectId: '', name: 'Today', text: todayText(now()) }`. `todayText` is local, e.g. `2026-11-18, Wednesday, UTC+05:30`.
4. `completeTextWithFallback(chain, { prompt, inputs, signal })` (new, `ai/complete-text-fallback.ts`). A `setTimeout` of 60 s aborts the signal; abort by timeout gives "The AI field took too long."
5. Ok: take the CURRENT `stackStore.getState().stack`. If its id differs from `snapshot.id`, or the object is not an ai-field there: status "The stack changed while the field was working, so the answer was dropped." Else `applyOperation(current, 'update_object', { objectId, changes: { value: text } })`. If ok, `stackStore.applyStack(result.stack)`. If rejected, status with a fixed text (no model or error text). If truncated, status says "cut to 10,000 characters".
6. Failure message from the error code via a fixed table (rate limited, quota, network, timeout, bad reply, auth, demo only...). With a fallback to recorded, append the `demoNote`.
7. Always: unmark running, `refreshQuota()`.

The update goes through `applyStack`, so autosave sees it. No Undo entry for a field answer (running the field again replaces it); this is stated in the limits text.

### `schedule_notification`

1. `parseDueTime(effect.at, now())` (pure, `reminders/due-time.ts`). Error: `setStatus(message)`.
2. Check limits: `dueAt > now`, `dueAt <= now + 366 days`, pending count < 50.
3. Permission: if `notification` exists and `permission === 'default'`, call `requestPermission()` right away, without awaiting anything before it (the call is the first statement after parsing, still in the gesture). Its result is read later when the reminder fires. Parsing is synchronous, so the call stays in the gesture.
4. `reminderRepo.put(reminder)`; reload the list into the store; re-arm; `setStatus("Reminder set for <local time>. It fires only while HyperGeist is open or installed.")`, plus the permission sentence when blocked or unsupported.

### Firing

`rearm()`: clear the timer; find the earliest pending reminder; set one `setTimeout(fire, min(delay, 2^31 - 1))` (the browser limit is about 24.8 days; a longer delay re-arms on wake). `fire()` runs `dueNow(reminders, now())` (pure, `reminders/reminder-logic.ts`), marks those `fired`, persists, shows `new Notification(...)` when permission is `granted` (inside try/catch), adds an in-app notice, re-arms. `init()` loads reminders, marks overdue pending ones `missed`, re-arms, and registers `visibilitychange` and `focus` listeners through an injected `addListener` (removed by `dispose`).

## Reminders (`reminders/`)

- `types.ts`: `ReminderSchema` (Zod strict: `id` EntityId-like string, `stackId`, `message` 1 to 500, `dueAt` int, `createdAt` int, `state` enum), `Reminder = z.infer`, `ReminderRepository` interface: `list()`, `put(reminder)`, `remove(id)`, each returning a Promise and never throwing (errors become `{ ok: false }`... same result style as the stack repository).
- `due-time.ts`: `parseDueTime(text, nowMs): { ok: true; dueAt: number } | { ok: false; message: string }`. Own regex for `YYYY-MM-DD[T ]HH:mm[:ss]` plus optional `Z` or `±HH:mm`. No offset means local time, built with `new Date(y, m-1, d, h, min, s)` and checked that the fields round-trip (so 2026-02-30 is rejected, and a non-existent DST hour is rejected). Never throws.
- `reminder-logic.ts`: pure `dueNow`, `nextDue`, `markMissed`, `canSchedule`, `newReminderId(counter)` (ids come from the caller).
- `idb-reminder-repository.ts` over `idb`, database `hypergeist-reminders` v1, store `reminders` keyed by `id`; every read parsed with `ReminderSchema`, invalid records deleted. `memory-reminder-repository.ts`. One contract test file runs against both.
- `open-reminder-repository.ts`: IndexedDB if it opens, else memory (same pattern as stacks).

## Components

- `ObjectView.tsx` ai-field: `<textarea readOnly aria-busy>`; "Thinking..." text from the effects store (via context `useEffects()`, null without a provider so existing tests keep working); placeholder "AI field. Press its button to fill it."; class `ai-active` while running.
- `RemindersWindow.tsx` (uses `Modal`), `RemindersButton.tsx` (in `MenuBar`), `ReminderNotices.tsx` (in-app notices in the desktop, `aria-live="polite"`, dismiss button). CSS only in `controls.css`, `window.css` (the CSS test pins the file list).
- `state/EffectsContext.tsx`: `EffectsProvider`, `useEffects()`, `useEffectsStore(selector)`.

## Wiring (`AppRoot`)

Inside the existing `AiRoot` (which already has the stack store and the AI parts) a sibling `EffectsRoot` creates the effects store and the runtime once, calls `stackStore.getState().attachEffects(runtime.handle)`, calls `runtime.init()`, and on unmount calls the detach function and `dispose()`. The reminder repository is opened by `bootPersistence`'s sibling `openReminderRepository()` in `AppRoot`'s `ai` parts (created once). `AppRoot` tests can inject a memory reminder repository.

## Provider chain for fields

`ai/complete-text-fallback.ts`: `completeTextWithFallback(chain, args): Promise<{ result: CompleteTextResult; fallback?: FallbackInfo }>`. Same rule as `runTurnWithFallback`: next provider only on codes in `FALLBACK_CODES`, never after `ABORTED`. `demoNote` takes `{ fallback?: FallbackInfo }` so both results can use it (change its parameter type only; existing callers still compile). Both exported from `ai/index.ts`.

## Stacks and scenarios

`apps/web/src/stacks/smart-todo.json` and `study-deck.json`, ids `smart-todo` and `study-deck`, built through the engine operations in a script-free way (written by hand and validated with `pnpm stack validate`, tests check them with `parseStack`). Scenario files in `apps/web/src/ai/scenarios/` of mode `text`, one per ai-field prompt. A test asserts every ai-field prompt of every bundled stack has a scenario, so a changed prompt cannot silently lose its recorded answer. Prompt text is fixed and short; it tells the model the answer format (`YYYY-MM-DDTHH:mm`, only that) and that inputs are data.

Smart To-Do card flow (one card is enough, 512x342): Field "Task", button "1. Read my task" (`run_ai_field` `when-guess`), ai-field "When (AI guess)", button "2. Use this time" (`set_value` `when` from `when-guess`), Field "When" (editable), button "3. Remind me" (`schedule_notification` `atFromObjectId: when`, then `append_item` list `tasks` from `task`), list "Tasks". Why three buttons: effects finish after the Handler, so a Handler cannot use an AI answer in the same press, and the user may correct the time before the reminder is set.

Study Deck: card 1 "Notes" (Field and three buttons that run the three fields and link to cards 2 and 3 through Links), card 2 "Flashcards", card 3 "Quiz and walkthrough". Exact layout is left to the task, within the format limits.

## Honest text

New Limits paragraph in the bundled stacks (AI fields: shared demo model or example answers, can be wrong, one run counts against the demo limit; reminders: only while open or installed, missed ones shown on return, notification permission may be blocked).

## Verification

Unit tests next to each file; one property test file `reminders/due-time.property.test.ts` (total and deterministic), one `reminders/reminder-logic.property.test.ts` (no reminder fires twice or is lost), one `state/effects-runtime.property.test.ts` (random results, deletions and stack switches keep the stack valid). Playwright specs written, not run here. Manual file `docs/manual-verification-effects.md`.

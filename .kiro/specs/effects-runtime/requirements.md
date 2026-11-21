# Requirements Document

## Introduction

The engine already turns a button press into effect requests (`run_ai_field`, `fetch_news`, `transcribe_audio`, `schedule_notification`) as plain data, and the web app answers each with "arrives in a later release". This spec carries out two of them in the browser, with no new Worker route: **`run_ai_field`** (a runtime AI field fills itself from a prompt and its input objects) and **`schedule_notification`** (a reminder that fires while the app is open or installed). It then ships two showcase stacks that need only those two: **Smart To-Do with Reminders** and **Study Deck**.

`fetch_news` (Morning Briefing) and `transcribe_audio` (Voice Notes) are NOT in this spec. They need Worker routes and your deployment. They keep their "arrives in a later release" message. They are the next spec, `effects-runtime-2`.

**Status: written 2026-11-17, decisions confirmed by the Developer (order 1A, news sources 2A).**

**Dependencies.** `stack-engine` (`executeHandler` effect requests, `applyOperation`), `ai-orchestrator` (`completeText`, `chooseProviderChain`, recorded provider, scenarios), `ai-assistant-ui` (AI store and controller, settings, quota, Stacks window), `local-persistence` (autosave saves any change of the open stack). Steering applies, especially `design-language` and the honesty rule.

**Out of scope.** News and transcription (next spec), `onOpen` handlers running (still validated, not run), voice, push notifications from a server, reminders while the browser is closed, sound, visual polish, sharing.

## Glossary

- **Effects_Runtime**: React-free module that carries out effect requests of the open stack (`apps/web/src/state/effects-runtime.ts`).
- **Effects_Store**: Zustand store with the set of running AI field ids and the reminder list.
- **Reminder**: `{ id, stackId, message, dueAt, createdAt, state }` with state `pending`, `fired` or `missed`.
- **Reminder_Repository**: Storage for reminders, in its own IndexedDB database `hypergeist-reminders` (the stacks database is not touched), with an in-memory twin.
- **Due_Time**: The instant a reminder is due, as epoch milliseconds, parsed from the text of a Field.

## Requirements

### Requirement 1: Effects reach the runtime

**User Story:** As a user, I want a button that asks for AI text or a reminder to do it, not to say "later release".

#### Acceptance Criteria

1. `createStackStore` SHALL accept an optional `onEffects(effects, snapshot)` callback. After a button press runs a Handler, THE store SHALL call it once with the returned effect requests of the kinds `run_ai_field` and `schedule_notification`, and the stack as it was when the Handler ran.
2. THE store SHALL keep the "arrives in a later release" message for `fetch_news` and `transcribe_audio`, and SHALL no longer add one for `run_ai_field` and `schedule_notification` when a runtime is attached.
3. THE store SHALL gain a `setStatus(text)` action that shows a status message the same way handler messages are shown.
4. THE executor SHALL stay pure: no timers, network or storage enter `packages/shared`.

### Requirement 2: Runtime AI field

**User Story:** As a user, I want to press a button and see the AI field fill itself.

#### Acceptance Criteria

1. WHEN a `run_ai_field` effect arrives, THE Effects_Runtime SHALL mark the field as running, append one extra input `{ name: "Today", text: <local date, weekday and time zone> }` to the effect's inputs, and call `completeText` through the provider chain of the AI settings with `completeTextWithFallback` (demo: proxy then recorded; own: direct only, never a silent fallback to the demo).
2. WHEN the text arrives, THE runtime SHALL write it with `applyOperation(update_object, { objectId, changes: { value } })` on the CURRENT stack of the store (not the snapshot), through `applyStack`. It SHALL write only if the open stack has the same id and the object still exists as an ai-field; otherwise it drops the result and says so in the status bar.
3. A result SHALL never leave the stack invalid: the operation result is checked, and a rejected operation shows a status message and changes nothing.
4. WHILE a field runs, pressing the same button again SHALL not start a second run for that field. A run SHALL stop after 60 seconds and report a timeout. The Stop button of the Ghost chat does not stop field runs; the status bar offers no cancel in this release (stated in the limits text).
5. ON failure THE runtime SHALL show one plain status message built from the error code, never from a response body, and the field keeps its old value. The message SHALL include "recorded example" wording when the recorded provider answered (the demo note) and the plain `DEMO_ONLY` message ("In demo mode this field only answers its recorded example") when nothing matched.
6. A run SHALL count against the same demo limits as a chat message (it goes through `/api/ai/chat`). The quota counter SHALL refresh after a run.
7. THE runtime SHALL not run more than 3 field runs at once; extra runs wait.

### Requirement 3: AI field in the UI

#### Acceptance Criteria

1. THE ai-field SHALL show "Thinking..." (visible text, not only colour) and `aria-busy="true"` while it runs, and the accent class `ai-active` may be set, never the string `--ghost` in a `.tsx` file.
2. THE placeholder SHALL say "AI field. Press its button to fill it." instead of "AI arrives in a later release".
3. THE text SHALL stay read-only in the field and SHALL be announced in a polite live region when it changes.

### Requirement 4: Reminders

**User Story:** As a user, I want "remind me" to remind me, and to be told honestly when it cannot.

#### Acceptance Criteria

1. `parseDueTime(text, nowMs)` SHALL accept `YYYY-MM-DDTHH:mm` and `YYYY-MM-DD HH:mm` (local time), the same with seconds, and ISO 8601 with `Z` or an offset. It SHALL reject everything else with a plain message, SHALL never throw, and SHALL not depend on the host's locale parsing (own regular expression, not `Date.parse` on free text).
2. WHEN a `schedule_notification` effect arrives, THE runtime SHALL: parse the due time; reject a past time ("That time has already passed") or one more than 366 days away; reject when 50 reminders are pending; otherwise store a pending Reminder and show "Reminder set for <local time>. It fires only while HyperGeist is open or installed."
3. THE runtime SHALL ask for browser notification permission only inside the user gesture that pressed the button, only when the permission is `default`, and SHALL say plainly when it is denied or unsupported ("Notifications are blocked, so the reminder shows inside HyperGeist only").
4. WHEN a pending reminder becomes due while the app is open, THE runtime SHALL mark it `fired`, show a `Notification` when permission is granted, and ALWAYS show an in-app notice that stays until dismissed.
5. WHEN the app opens and finds pending reminders already past due, THE runtime SHALL mark them `missed` and list them in the Reminders window with the text "Missed while HyperGeist was closed".
6. THE runtime SHALL use one timer for the next due reminder, re-armed after every change, and SHALL re-check on `visibilitychange` and on `focus` (timers in background tabs are throttled).
7. THE menu bar SHALL have a "Reminders" button with the count of pending and missed reminders; it opens a window that lists reminders (message, due time, state), lets the user cancel a pending one and dismiss a fired or missed one, and states the limit sentence.
8. Reminders SHALL be stored in the Reminder_Repository, SHALL survive a reload, and in Memory_Mode (IndexedDB unavailable) SHALL live in memory with the existing banner covering it. A reminder SHALL never be written into a stack, an export or a share link.
9. A corrupt stored reminder SHALL be dropped on read (parsed with a Zod schema), never thrown.

### Requirement 5: Recorded answers for AI fields

#### Acceptance Criteria

1. Scenarios of mode `text` SHALL answer an ai-field whose prompt matches exactly (after `normalizePrompt`). The two showcase stacks SHALL ship one scenario per ai-field prompt so each field answers in demo mode when the Worker has no model.
2. A recorded answer SHALL be labelled in the status bar as a recorded example. A recorded reply SHALL never claim to read the user's text.

### Requirement 6: Showcase stacks

**User Story:** As a reviewer, I want two real tools in the app on first run.

#### Acceptance Criteria

1. **Smart To-Do with Reminders.** THE stack SHALL have: a Field for the task text ("dentist Thursday 5pm"), an ai-field that reads it and answers the date and time as `YYYY-MM-DDTHH:mm`, a plain Field "When" the user can type or correct, a button "Read my task" (runs the ai-field), a button "Use this time" (copies the ai-field to "When"), a button "Remind me" (`schedule_notification` from "When" and `append_item` of the task text into a list), and a list of tasks. The reminder is scheduled from the text of the Field when the button is pressed, so the user presses the buttons in order. THE stack text SHALL say so.
2. **Study Deck.** THE stack SHALL have: a Field for notes or a topic, an ai-field "Flashcards" ("Question: ... Answer: ..." lines), an ai-field "Quiz" (5 questions), an ai-field "Walkthrough" (a short slide-style outline), one button per ai-field, and links between three cards. The text SHALL say the answers can be wrong.
3. BOTH stacks SHALL pass `pnpm stack validate`, SHALL be seeded as bundled `.json` files in `apps/web/src/stacks/`, and SHALL not change the thin-slice stack.
4. THE seed logic SHALL pick them up for new browsers. A browser that already seeded the demo stacks gets them with "Restore demo stacks" (documented; no silent change of existing user data).

### Requirement 7: Honest text and tests

#### Acceptance Criteria

1. THE Limits card of the bundled stack and the README SHALL no longer say AI fields and reminders arrive later; they SHALL say: AI fields use the shared demo model or an example answer, can be wrong, and one run counts against the demo limit; reminders fire only while HyperGeist is open or installed, and a missed reminder is shown when you return.
2. Unit tests SHALL cover: the store hook, `parseDueTime` (accepted formats, rejected text, past, too far, DST-safe local parsing, never throws), the due-time logic, the runtime for each outcome (success, rejected operation, other stack open, object deleted, provider error, recorded answer, timeout, concurrent limit, double press), the reminder repositories (one shared contract test against memory and IndexedDB, corrupt record dropped), the Reminders window, and the ai-field component.
3. Property tests (fast-check, reported seed) SHALL cover: `parseDueTime` is total and deterministic; the due-selection logic never fires a reminder twice and never loses one; any sequence of field results leaves the stack valid (`validateStack` ok).
4. Playwright tests SHALL be written (the Developer runs them) for: Study Deck fills a field in demo mode with the recorded example; Smart To-Do shows "Reminder set" with a time typed by the test; a past time shows the message; the Reminders window lists and cancels it. The notification permission is stubbed in the test; no live model is called.
5. THE Developer SHALL check `docs/manual-verification-effects.md` before submission.

## Decisions made (do not reopen)

- Two effects first, no new Worker route (Developer, 1A).
- News sources, for the later spec, are a fixed Worker allowlist of RSS feeds per topic (Developer, 2A).
- Field runs share the demo limits of chat messages. Reminders fire only while the app is open or installed.
- Reminders live in their own IndexedDB database so the stacks database and its tests are not touched.

## Risks, stated now

- The model can return a wrong date. The two-step flow (read, correct, then remind) is the guard.
- Without a deployed Worker and model, only the recorded example answers, and the recorded date is fixed, so the reminder demo needs the user to type a time. The manual checklist has the real-model case.
- Notification behaviour differs per browser and OS; only the in-app notice is guaranteed.

# Requirements Document

## Introduction

This spec puts the AI in front of the user, with a plain look. The Developer asked for the working product first and visual polish later (`retro-ui-shell`, after the Developer's feedback list). It covers: a chat panel in the Ghost window, a third mode "AI edit" (click an object, then talk about it), "describe a new stack in a sentence" in the Stacks window, an AI settings dialog (demo or own model), a demo quota counter, undo of an AI Turn, and a fix for a Worker bug found while planning it.

**Status: written for execution on 2026-11-16 (the Developer wants the app as complete as possible by the next day; see the note at the end).**

**Dependencies.** `ai-orchestrator` (`apps/web/src/ai/index.ts`: `runTurnWithFallback`, `chooseProviderChain`, `demoNote`, `startNewStack`, `detectCapabilities`, settings and key holder), `worker-backend` (`/api/ai/chat`, `/api/ai/quota`), `local-persistence` (autosave saves any change of the open stack; Stacks window; repository). Steering applies, especially `design-language` (tokens only, `--ghost` accent only while the AI is active, no `--ghost` text in any `.tsx` file, keyboard operable, reduced motion) and the honesty rule (state real limits).

**Out of scope.** Voice input, streaming text, sound, window dragging, onboarding tour, visual polish beyond the tokens (all `retro-ui-shell`), the news, transcription and reminder effects (`effects-runtime`), sharing.

## Glossary

- **Ghost_Panel**: The Ghost window, now a chat panel.
- **AI_Controller**: The React-free module that runs Turns against the open stack and keeps the chat log, the undo list and the busy state (`apps/web/src/state/ai-controller.ts`).
- **AI_Store**: The Zustand store holding the chat log, busy flag, undo list, settings, quota and capability report.
- **Undo_Entry**: The stack as it was before an AI Turn changed it (`TurnResult.before`).
- **Example_Prompts**: The demo scenario prompts: "Make me a to-do list" and "Add a button".

## Requirements

### Requirement 1: Chat in the Ghost window

**User Story:** As a reviewer, I want to type a request and see my stack change, so that I can try the product in one minute.

#### Acceptance Criteria

1. THE Ghost_Panel SHALL show: the sprite, a log of messages (user lines and Ghost lines), a text input with a Send button, a Stop button while a Turn runs, and the Example_Prompts as buttons that fill the input.
2. WHEN the user sends a message, THE AI_Controller SHALL run one Turn with `runTurnWithFallback` on the open stack, the current Card and the selected object (in AI edit mode), with the last 6 chat messages as history, and SHALL show a "thinking" state while it runs.
3. WHEN the Turn finishes, THE Ghost_Panel SHALL show: the Ghost's text, one line per step in plain words (`describeCall` or the rejection text), a one-line status (done, partly done, could not do it, stopped), the demo note when the answer was a recorded example (`demoNote`), and an Undo button when the stack changed.
4. WHEN the stack changed, THE AI_Controller SHALL replace the open stack's content with `TurnResult.after` through one store action, and autosave SHALL save it as for any change.
5. WHEN the user presses Undo, THE AI_Controller SHALL restore the last Undo_Entry, and SHALL keep at most 10 entries, newest first; Undo SHALL be disabled while a Turn runs.
6. WHEN the user presses Stop, THE AI_Controller SHALL abort the Turn, keep the changes already accepted, and say so.
7. THE Ghost_Panel SHALL be usable by keyboard (Enter sends, Shift+Enter inserts a line), announce new Ghost messages in an `aria-live="polite"` region without a `role="status"` (the status bar owns the one `status` role of the stack window), and respect reduced motion.
8. THE `--ghost` accent SHALL appear only through a CSS class that is set while the AI is thinking, speaking or has just changed something, and SHALL never be written in a `.tsx` file.
9. WHEN no provider can be used (own mode with missing settings), THE Ghost_Panel SHALL say what is missing and offer the settings dialog; it SHALL never fall back silently from an own key to the demo.

### Requirement 2: AI edit mode

**User Story:** As a user, I want to click an object and talk about it, so that I can say "make this bigger" without describing where it is.

#### Acceptance Criteria

1. THE Mode SHALL gain a third value `ai-edit`, shown in the mode control as "AI edit"; Alt+M SHALL cycle Interact, Edit, AI edit.
2. IN AI edit mode, clicking an object SHALL select it as in Edit mode, the Property_Readout SHALL show it, buttons SHALL not run, and the hint line SHALL explain the mode ("AI edit mode. Click an object, then tell the Ghost what to change. Alt+M switches mode.").
3. THE Ghost_Panel SHALL show the selected object's name and type as a chip while one is selected, and the Turn SHALL send it as `selectedObjectId`.
4. WHEN the mode changes, the selection SHALL clear, as today.

### Requirement 3: A new stack from a sentence

**User Story:** As a reviewer, I want to describe a tool and get a working stack, so that the product shows its point at once.

#### Acceptance Criteria

1. THE Stacks window SHALL have a section "Make a stack with the Ghost" with a text input, a "Make it" button, and the Example_Prompts as buttons.
2. WHEN the user submits, THE AI_Controller SHALL run a Turn with `newStack: true` on `startNewStack({ takenIds })`, and on status `done` or `partial` SHALL store the resulting stack with `repository.create` (origin `user`) and open it; on `failed` or `aborted` it SHALL store nothing and SHALL show the Ghost's message in the Stacks window.
3. THE new stack's name SHALL be the one the model gave with `create_stack`, or "New stack".
4. WHILE the Turn runs, THE section SHALL show a busy state and a Stop button, and the rest of the Stacks window SHALL stay usable.

### Requirement 4: AI settings

**User Story:** As a reviewer with my own model, I want to enter my key and base URL, so that I can use my own provider.

#### Acceptance Criteria

1. THE menu bar SHALL have an "AI settings" button that opens a dialog with: a choice "Demo (no key needed)" or "My own model"; for own: base URL, model name, key (password input), a "Check this model" button that runs `detectCapabilities` and shows its messages, and Save.
2. THE dialog SHALL validate the base URL with `validateBaseUrl` and show its message; it SHALL say in plain words that the key is kept only in memory and must be entered again after a reload, and that, with an own model, the stack and the message are sent to that provider; for demo it SHALL say they go through the app's server to a hosted model provider.
3. THE settings (provider, base URL, model) SHALL be saved with the settings repository; THE key SHALL go only into the in-memory key holder.
4. WHEN the capability check reports tool calling `no`, THE AI_Controller SHALL start Turns in JSON mode for that provider.
5. THE default SHALL be demo mode.

### Requirement 5: Demo quota counter

**User Story:** As a reviewer, I want to see how much of the shared demo is left, so that I understand the limit.

#### Acceptance Criteria

1. IN demo mode, THE menu bar SHALL show "Demo: N left today", where N is the smaller of the daily and the per-visitor remainder from `GET /api/ai/quota`, refreshed at start and after each Turn.
2. IF the quota call fails or the Worker is not there (development server), THE counter SHALL be hidden and SHALL not show an error.
3. WHEN N is 0, THE counter SHALL say "Demo limit reached: examples only".

### Requirement 6: Worker origin fix

**User Story:** As a reviewer, I want the quota counter to work in a real browser.

#### Acceptance Criteria

1. Browsers do not send an `Origin` header on same-origin GET requests, so the current Worker check would answer `FORBIDDEN_ORIGIN` to every real `GET /api/ai/quota`. THE Worker SHALL accept a request without `Origin` only when the method is GET or HEAD and `Sec-Fetch-Site` is present and equals `same-origin`; POST SHALL still require a matching `Origin`.
2. THE tests and `docs/manual-verification-worker.md` SHALL be updated, and the docs SHALL say a script can forge these headers.

### Requirement 7: Honest text and tests

#### Acceptance Criteria

1. THE texts that say AI arrives later (the Ghost window, the Limits card of the bundled stack, the hints) SHALL be replaced by the real limits: demo answers come from a shared model or recorded examples, an own key is kept only in memory, the AI can make mistakes and every AI change can be undone with Undo.
2. Unit tests SHALL cover the controller (success, partial, failed, aborted, undo, history, no provider), the stack store changes, each new component, and the settings dialog.
3. Playwright tests SHALL be written (the Developer runs them) for: the Ghost chat with an Example_Prompt in demo mode (the recorded fallback answers because the Worker has no model configured), Undo, AI edit mode selection, "make a stack" creating and opening a to-do stack that then works (type a task, press Add), the settings dialog validation, and the quota counter being hidden when the Worker answers an error.
4. THE Developer SHALL check `docs/manual-verification-ai-ui.md` before submission.

## Note on schedule

The Developer asked for the whole app to be complete by 2026-11-17. This spec is the part that makes the product usable. What remains after it (showcase stacks, effects runtime, share links, `retro-ui-shell` polish, video, write-up, your manual checks) cannot all be finished and verified in one day, and the status file records the order of cuts.

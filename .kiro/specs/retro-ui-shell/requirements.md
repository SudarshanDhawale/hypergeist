# Requirements Document

## Introduction

This spec turns the plain first-pass UI into the HyperGeist the design language describes. It follows the UI audit (`docs/ui-audit/report.md`, 2026-11-21) and the Developer's answers to its questions. Standard: `.kiro/steering/design-language.md`.

**Decisions from the Developer (2026-11-21).**

1. **One main window stays.** No free-form multi-window desktop. The Ghost is a small docked button at the bottom right of the main window. Its chat window is **closed by default**. Clicking the Ghost opens a floating conversation window, like a typical AI app.
2. **Objects behave like sticky notes** on a card: the user moves and resizes them by hand, edits their properties by hand, and the Ghost can change them too.
3. **A card bar** (vertical, like the tool palette of a drawing program) lists the cards of the stack so the user picks one (for example To-do, Timer, Reminder).
4. **The `--ghost` orange is allowed in `ghost.css`.** The one CSS test that forbids it changes. The Ghost gets frame-stepped animations for sleeping, thinking, modifying, generating (plus done and error).
5. **The Stacks window is redesigned** for plain use. The current one is too crowded to understand.

**Dependencies.** `stack-engine` (`update_object`, `add_object`, `remove_object`, `create_card`, `delete_card` through `applyOperation`), `local-persistence` (autosave), `ai-assistant-ui` (controller, store, Ghost chat, Stacks section). No change to the stack format or the engine API. Steering applies: tokens only, 24 px targets, visible focus, reduced motion, honesty rule.

**Out of scope.** A free-form desktop with several windows, desktop stack icons, timer, alarm and reminder object types (not in the format; reminders use `schedule_notification` and belong to `effects-runtime`; a "Timer" or "Reminder" card can exist in a stack, but its behavior is not built here), the Spirit Menu items File, Edit, Stack, Help, a tool palette beyond "add object", share links, image dithering.

## Glossary

- **Card_Bar**: The vertical list of cards at the left of the card area.
- **Ghost_Dock**: The small Ghost button at the bottom right of the main window.
- **Chat_Window**: The floating conversation window opened from the Ghost_Dock (the existing chat content).
- **Gesture**: One pointer drag or one key press that moves or resizes an object; it commits one `update_object`.
- **Ghost_State**: One of sleeping, thinking, modifying, generating, done, error.

## Requirements

### Requirement 1: Move and resize objects by hand

**User Story:** As a user, I want to drag objects around the card and resize them, so that I can lay out my stack like sticky notes.

#### Acceptance Criteria

1. IN Edit mode, dragging a selected or unselected object body SHALL move it; dragging one of the 8 handles SHALL resize it from that edge or corner. A plain click still selects without changing anything.
2. THE position and size SHALL be whole numbers in card units (not screen pixels), converted with the current scale, and SHALL be clamped so the object stays fully inside the card and keeps a size between `LIMITS.objectSize` min and max.
3. WHILE dragging, THE object SHALL follow the pointer (a local preview, no stack write). ON release, ONE `update_object` SHALL be committed with the final `x`, `y`, `width`, `height`. Escape during a Gesture SHALL cancel it. A Gesture that changes nothing SHALL commit nothing.
4. A rejected `update_object` SHALL leave the stack unchanged and the object SHALL snap back, with the engine's message in the status bar.
5. THE handles SHALL accept pointer events and show the matching resize cursor (`nwse`, `ns`, `ew`, ...). Corner handles SHALL have a 24 px hit area. Mid-edge handles SHALL have a hit strip along the edge between the corners and SHALL be hidden on a side shorter than 48 screen px, so the hit areas of a small object never overlap. A corner always wins over an edge.
6. WITH an object selected in Edit mode, arrow keys SHALL move it by 1 card unit (8 with Shift); each key press is one Gesture. Resizing by keyboard is done through the numeric width and height fields of the Tools panel (Requirement 2.1); there is no keyboard shortcut for resize because the Alt plus arrow keys clash with browser navigation.
7. IN AI edit mode and Interact mode, objects SHALL NOT move or resize by hand.
8. THE move and resize math SHALL be a pure module with unit and property tests (clamping holds, the result is always valid, applying then reversing a Gesture returns the original).

### Requirement 2: Edit objects by hand

**User Story:** As a user, I want to change an object's text and add or delete objects without the Ghost.

#### Acceptance Criteria

1. IN Edit mode, THE right-hand column SHALL be one fixed-width "Tools" panel (it never appears or disappears while selecting, so the card does not shift). WITH an object selected it SHALL be a property editor: name, x, y, width and height (numbers), label (button), placeholder and value (field), items (list), alt (image), each committed with `update_object` on blur or Enter; invalid input SHALL show the engine's message under the field and change nothing. IN AI edit mode the same column SHALL show the read-only readout as today.
2. WITH nothing selected, THE Tools panel SHALL show "Add object" with Button, Field, List and Image, plus Undo and Redo buttons; choosing an object type SHALL add it with sensible defaults near the top left of the card through `add_object` and select it.
3. THE Delete or Backspace key (not inside a text input) SHALL remove the selected object through `remove_object`, after a one-line confirmation in the status bar line the user can undo.
4. THERE SHALL be one shared history of whole stacks for manual changes and AI Turns, with at most 50 entries per open stack, cleared when another stack opens. Each entry records its source (user or AI). Undo and Redo work with Ctrl or Cmd plus Z and Shift plus Z (not while a text input has focus) and with the buttons of the Tools panel (always visible in Edit mode). THE Ghost's Undo button SHALL be enabled only when the most recent history entry came from an AI Turn and no Turn is running, and SHALL undo exactly that entry; it SHALL replace the separate AI undo list, so Ghost Undo can never wipe later manual work.

### Requirement 3: Card bar

**User Story:** As a user, I want to see all the cards and pick one, like choosing a tool in a drawing program.

#### Acceptance Criteria

1. THE stack window SHALL show a Card_Bar at the left, in every mode, listing each card by name in stack order, with the current card marked (inverted) and each entry at least 24 px high.
2. CLICKING an entry or pressing Enter on it SHALL open that card. THE list SHALL be keyboard operable (Up and Down move focus, Enter opens) and SHALL scroll when it has many cards.
3. IN Edit mode, the Card_Bar SHALL have an "Add card" entry (`create_card`, named "Card N") and a "Delete card" button for the current card (`delete_card`, confirmed in the status line; the last card cannot be deleted). Renaming a card is left to the Ghost and is not a hand control.
4. WHEN the viewport is under 700 px wide, THE Card_Bar SHALL become a horizontal strip above the card.
5. THE existing Link bar and "Card n of m" status SHALL keep working.

### Requirement 4: Ghost dock and Chat window

**User Story:** As a user, I want the Ghost out of the way until I need it, and a chat that opens like in any AI app.

#### Acceptance Criteria

1. THE rail Ghost window SHALL be removed. THE Ghost_Dock SHALL sit at the bottom right of the main window, show the animated sprite (Requirement 5) in a 24 px minimum hit area, have the accessible name "Ghost, open chat", and be reachable by keyboard.
2. THE Chat_Window SHALL be closed on every load. Clicking the Ghost_Dock or pressing Enter on it SHALL open it as a floating window above the dock with the existing chat (log, input, Send, Stop, Undo, examples, selected-object chip). Clicking the dock again, the close box, or Escape SHALL close it. Closing SHALL NOT stop a running Turn.
3. WHEN a Turn finishes while the Chat_Window is closed, THE Ghost_Dock SHALL show a small marker (a dot with a shape, not color alone) until the window is opened.
4. THE Chat_Window SHALL have the standard window chrome (striped title bar, close box, hard shadow) and SHALL return focus to the dock when closed. IN AI edit mode, WHEN the user selects an object, THE Chat_Window SHALL open if closed.
5. THE Ghost_Dock SHALL NOT cover any object of a 512x342 card at 1280x800 (it sits in the bottom-right corner of the card frame, outside the card). THE open Chat_Window SHOULD cover the Tools column rather than the card, and the Developer checks this with screenshots; if it covers the selected object in AI edit mode, the window moves to the other side.
6. UNDER 700 px wide, THE Chat_Window SHALL be a bottom sheet over the full width.
7. THE text that tells the user the limits of the demo (shared model or recorded examples, the AI can be wrong, Undo) SHALL stay in the Chat_Window.

### Requirement 5: Ghost animation

**User Story:** As a reviewer, I want the Ghost to feel alive and to show what the AI is doing.

#### Acceptance Criteria

1. THE Ghost sprite SHALL have frame-stepped animations (`steps()` timing, no easing, whole-pixel movement) for six states: sleeping (slow breathing and floating "z"), thinking (bobbing with a dithered "..." bubble), modifying (a small wand or sparkle motion), generating (a faster spin or pulse with growing sparkles), done (a short wave), error (a flicker with a "!" mark).
2. THE Ghost_State SHALL come from the AI store: `busyNewStack` gives generating; `busy` gives thinking; a stack change from a Turn gives modifying for 1.2 seconds, then done for 1.2 seconds, then sleeping; an error line as the latest result gives error for 3 seconds. Sleeping is the default.
3. THE `--ghost` orange SHALL appear only in thinking, modifying, generating and done, always together with a shape or motion; never in sleeping. The accent SHALL be applied through CSS classes in `ghost.css` (the string `--ghost` stays out of every `.tsx` file).
4. UNDER `prefers-reduced-motion`, each state SHALL show one static frame that is still distinguishable (different pose and mark).
5. THE `css-tokens.test.ts` SHALL be changed so `ghost.css` may use `--ghost`; every other CSS file and every `.tsx` file stays forbidden.
6. THE sprite art SHALL be original, built from pixel maps, 24 by 24 cells at most per frame, and recorded in `docs/assets-licenses.md`.

### Requirement 6: A simple Stacks window

**User Story:** As a new user, I want to open a stack or make a new one without reading a wall of options.

#### Acceptance Criteria

1. THE Stacks window SHALL open with the title "Your stacks" and show, in this order: (a) the list of stacks as large rows (name, "Demo" tag if bundled, "Open now" mark, saved time in local time and plain words); a click selects a row, and double-click or Enter opens it; (b) one toolbar under the list that acts on the selected row: Open (primary), Export, Delete; (c) one primary area "Make a new stack" with a single text box, a "Make it" button and the example prompts as small chips; (d) a "More" disclosure.
2. THE "More" disclosure (closed by default) SHALL hold Import, Restore demo stacks and Trash with its restore and empty actions. Delete SHALL ask once; deleted stacks go to the Trash as today. THE window SHALL select the open stack's row when it opens.
3. THE window SHALL show no paragraph longer than one line outside "More"; the storage notice ("stored in this browser only") SHALL be one short line at the bottom.
4. THE currently open stack SHALL be marked "Open now". Opening a stack SHALL close the window as today and keep autosave behavior.
5. THE window SHALL work with the keyboard only (Up and Down select, Enter opens, Tab reaches Make a new stack and More) and keep the existing busy and error messages for making a stack.
6. EXISTING behavior (flush before every action, import limits, copy on id conflict, delete to trash, restore demo stacks, Memory_Mode notice) SHALL NOT change; only the layout and wording change.

### Requirement 7: Menu bar, clock and sound

**User Story:** As a user, I want the menu bar to feel like a computer's, and I want to be able to mute it.

#### Acceptance Criteria

1. THE menu bar SHALL show on the right: the demo counter (existing) and a sound toggle button (a speaker glyph, `aria-pressed`). A clock was considered and dropped: it adds no function.
2. SOUND SHALL use the Web Audio API with synthesized 8-bit blips (click, mode switch, window open, window close, Ghost speaks, done) and SHALL stay off until the user's first pointer or key interaction, then on by default; the toggle SHALL persist in this browser; if storage is unavailable the toggle works for the session. No sound plays on load, and none plays under reduced motion unless the user turned sound on in this session.
3. IF Web Audio is missing, THE toggle SHALL be hidden.

### Requirement 8: Honest text and accessibility

#### Acceptance Criteria

1. THE AI field's placeholder SHALL no longer say AI arrives in a later release; it SHALL say what is true at that time ("AI field. It shows text from the AI when a button runs it; not connected yet." until `effects-runtime` ships it).
2. ALL new interactive elements SHALL have the dashed focus ring, 24 px minimum targets, and accessible names; the Card_Bar, Ghost_Dock and Chat_Window SHALL follow the ARIA patterns in `design.md`.
3. NEW CSS SHALL use only tokens; new tokens go in `tokens.css`. Any new asset has its license recorded.

### Requirement 9: Tests

#### Acceptance Criteria

1. Unit tests: the move and resize math (including properties), the shared history (limit 50, clear on stack change), the Ghost_State derivation, each new component, the redesigned Stacks window (existing tests adjusted only where the layout changed).
2. Playwright tests SHALL be written (the Developer runs them) for: dragging a handle changes the object's size and survives a reload, dragging an object moves it and Undo restores it, picking a card in the Card_Bar, the Ghost_Dock opening and closing the Chat_Window, and making a stack from the new Stacks window.
3. THE Developer SHALL check `docs/manual-verification-ui-shell.md` before submission.

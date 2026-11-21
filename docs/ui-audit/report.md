# HyperGeist UI audit (2026-11-21)

Method: read the brief, `design-language.md`, `product.md` and the code of the UI shell, then ran the Vite dev server (`127.0.0.1:5173`) and drove it with a Chromium browser through the Playwright tool. All measurements below are from that run (viewport sizes, bounding boxes before and after, computed styles). Screenshots are in this folder.

Not available: `docs/demo-video-storyboard.md` and `docs/design-language.md` do not exist (the design language lives at `.kiro/steering/design-language.md`). Not tested in this run: hover and pressed states, `prefers-reduced-motion`, keyboard-only navigation of every control, real touch devices. These are marked "Not verified" below.

## Phase 0: what the UI is supposed to be (10 lines)

1. A retro desktop in the 1-bit classic Mac style: black ink on paper, with one orange accent (`--ghost`) that appears only while the AI is active.
2. A menu bar with a Spirit Menu (ghost glyph), File, Edit, Stack, Mode and Help, and on the right a clock, the demo-quota counter and a sound toggle.
3. A dithered desktop background carrying stack icons (32x32 sprites, double-click to open, the selected one inverted) and a trash icon bottom right.
4. Windows with a 2px border, a hard drop shadow, a striped title bar when active, a close box on the left and an expand box on the right, draggable by the title bar, one active at a time.
5. The card canvas is a fixed 512x342 logical size, shown at whole-number scales (1x, 2x, 3x) with pixelated rendering, and a status bar shows card n of m, the mode and a hint.
6. Three modes (Interact, Edit, AI edit) in an always-visible segmented control. Each has its own cursor and chrome: pointer, crosshair with dashed outline and 8 resize handles, and a ghost cursor with an orange outline.
7. In Edit mode: click selects, drag moves, handles resize, double-click edits properties, plus a tool palette window.
8. The Ghost is its own docked window with a sprite (about 24x24, idle animation) and typewriter text in VT323. It shows thinking, done and error states, offers inline Undo, and a "what I changed" line.
9. Dither (not grays) for shading, disabled and pressed states. Frame-stepped motion only. Synthesized 8-bit sounds, off until the first interaction, with a persistent toggle.
10. Keyboard operable with a dashed focus ring, 24 px minimum targets, reduced-motion support, and desktop first with a single full-screen window on tablet and phone.

## Phase 1: evidence

| File                                | What it shows                                           |
| ----------------------------------- | ------------------------------------------------------- |
| `01-desktop-1280x800-interact.png`  | Interact mode, 1280x800                                 |
| `02-edit-mode-1280x800.png`         | Edit mode, nothing selected                             |
| `03-edit-selected-1280x800.png`     | Edit mode, field selected (handles drawn, readout open) |
| `04-ai-edit-selected-1280x800.png`  | AI edit mode, button selected                           |
| `05-stacks-window-1280x800.png`     | Stacks dialog over the dithered scrim                   |
| `06-ai-settings-1280x800.png`       | AI settings dialog                                      |
| `07-desktop-1920x1080-interact.png` | 1920x1080, canvas at 2x                                 |
| `08-tablet-820x1180.png`            | Tablet width                                            |
| `09-after-drag-attempts.png`        | After the drag and resize attempts                      |

### Resize and drag reproductions (all measured)

| #   | Steps                                                                           | Expected                                          | Actual                                                                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Edit mode, click the "New item" field, drag the south-east handle by (+60, +40) | Field grows                                       | Nothing. Box stays 380x28 at (176, 219). The handle is 6x6 px with computed `pointer-events: none`, and `SelectionOverlay.tsx` says it "starts no drag or resize".                                       |
| R2  | Edit mode, drag the selected object body by (+50, +50)                          | Object moves                                      | Nothing. Position unchanged. `ObjectView` has click and keyboard handlers only, no pointer drag.                                                                                                         |
| R3  | Drag the stack window title bar by (+200, +140)                                 | Window moves                                      | Nothing. Window stays at (12, 36), 1032x752. The window is a fixed grid cell, not a draggable window.                                                                                                    |
| R4  | Look for a multiline field or the AI field in Interact mode and try to resize   | A resizable text area, or a documented fixed size | All inputs and the textarea have computed `resize: none`. There is no way to change a field's size by any means except the AI.                                                                           |
| R5  | Look for close and expand boxes, desktop icons, trash, clock, sound toggle      | Present per the design language                   | None exist (DOM queries: 0 close boxes, 0 expand boxes, 0 icons, no trash, no clock, no sound toggle). No `AudioContext` anywhere in the app code.                                                       |
| R6  | Resize the viewport 1280x800 to 1920x1080                                       | Whole-number scale changes                        | Works: scale 1 at 1280x800, scale 2 at 1920x1080 (canvas 1026x686). The card is letterboxed with no fractional scaling.                                                                                  |
| R7  | Tablet width 820x1180                                                           | Single full-screen window, Ghost as bottom sheet  | Layout stacks (no horizontal scroll: scrollWidth 820 = clientWidth), but the Ghost is a plain full-width block below the stack, not a bottom sheet, and the canvas stays at 1x with large empty margins. |

**Finding that changes the premise:** resizing is not broken. It is not implemented. The only code that reads a pointer position is the canvas click-to-select. What is working is the scale-to-fit of the whole card (R6). Card size is fixed by the stack (`cardWidth` and `cardHeight`, default 512x342) and no UI changes it.

Console in a plain load: one 404 for `favicon.ico`, and a 502 on `/api/ai/quota` because the Worker is not running under the Vite dev server (expected, and the counter hides itself).

## Phase 2: audit

### Design language

| Item                                                                                               | Grade   | Evidence                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Only ink, paper and the `--ghost` accent; tokens only                                              | Pass    | `css-tokens.test.ts` scans every CSS file; screenshots show no color. `--ghost` is defined but used nowhere (see Ghost row).                                                                                                                                                                                            |
| Dither instead of grays, gradients, blur, rounded corners                                          | Pass    | `tokens.css` dither tiles; hard shadows on windows (`box-shadow: 3px 3px 0 ink`); no rounding seen (01, 05).                                                                                                                                                                                                            |
| Pixel fonts, self-hosted, no smoothing                                                             | Pass    | Pixelify Sans 400 and VT323 400 loaded through Fontsource; body font-smoothing computed `none`. Caveat: UI text at 12 px is very small and reads weakly (01).                                                                                                                                                           |
| Window chrome: striped active title bar, close and expand boxes, hard shadow                       | Partial | Stripes and hard shadow present (01, 05). No close or expand box (R5). Inactive-window state cannot be seen because there is only ever one window.                                                                                                                                                                      |
| Desktop: dithered background, stack icons, trash, menu bar with clock, sound toggle, quota counter | Fail    | The dither shows only in the strip above the Ghost and behind dialogs (01, 05). No icons, no trash icon, no clock, no sound, no Spirit Menu items (File, Edit, Stack, Mode, Help). Only a "Stacks" and an "AI settings" button, plus the counter, which is hidden without the Worker.                                   |
| Card canvas 512x342, integer scale, pixelated                                                      | Pass    | Verified scale 1 and 2 (R6); `image-rendering: pixelated` in `canvas.css`.                                                                                                                                                                                                                                              |
| Status bar: card n of m, mode, hint                                                                | Pass    | Visible in 01 and 03 ("Card 1 of 3 Mode:Edit ..."). Text is tiny.                                                                                                                                                                                                                                                       |
| Mode switch always visible, distinct cursors and chrome per mode                                   | Partial | Segmented control always visible (01). Edit and AI edit both use the crosshair (measured `crosshair` in AI edit) and look identical (03, 04). The ghost cursor and orange outline are missing.                                                                                                                          |
| Ghost window: docked sprite, typewriter voice, orange only when AI is active                       | Partial | Docked at bottom right with a sprite (01). The sprite is about 24 px of art in a mostly empty panel. No typewriter effect. The accent is never shown because a CSS test forbids `--ghost` in `ghost.css`, so the "thinking" state is ink-only. VT323 is loaded but I did not find where it is used for the Ghost voice. |
| Component states, keyboard operation, focus ring, reduced motion                                   | Partial | Dashed focus ring visible (07, "AI settings" button). `base.css` has a reduced-motion guard. Hover, pressed and reduced-motion behavior: Not verified.                                                                                                                                                                  |
| No third-party trademarks or assets                                                                | Pass    | Original sprite and glyph; licenses file exists (`docs/assets-licenses.md`).                                                                                                                                                                                                                                            |

### Functionality

| Item                                     | Grade   | Evidence                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Resize of cards, windows, text fields    | Fail    | Not implemented (R1, R3, R4).                                                                                                                                                                                                                                                                                                                                                                                 |
| Dragging objects and windows             | Fail    | Not implemented (R2, R3).                                                                                                                                                                                                                                                                                                                                                                                     |
| Selection                                | Pass    | Click and keyboard (Enter, Space) select; Escape clears; property readout shows values (03).                                                                                                                                                                                                                                                                                                                  |
| Handles                                  | Fail    | Drawn, inert (R1).                                                                                                                                                                                                                                                                                                                                                                                            |
| Undo                                     | Pass    | Undo for AI turns works in unit tests; not exercised in this run. There is no undo for manual edits because there are none.                                                                                                                                                                                                                                                                                   |
| Mode behavior                            | Pass    | Buttons inert in Edit and AI edit; Alt+M cycles (unit tests; Alt+M not exercised in this run).                                                                                                                                                                                                                                                                                                                |
| Object types rendered                    | Partial | The format has 5 types: button, field and list render; image is a placeholder box ("Image"); ai-field is a read-only box with the text "AI field. AI arrives in a later release.", which is now stale and contradicts the honesty rule. The brief's text, timer, reminder and recorder types are not in the format (reminders and timers were dropped by decision; "text" and "recorder" were never specced). |
| Responsive (desktop first, tablet check) | Partial | No overflow at 820 px (R7), but not the specified single-window-with-bottom-sheet layout.                                                                                                                                                                                                                                                                                                                     |

Other things I saw: the Ghost log is an empty bordered box with no placeholder text; "Make me a to-do list" wraps onto two lines; Send and Undo render with dashed borders that look disabled; the dither scrim behind dialogs is a 1 px full-contrast checkerboard, which is noisy to look at (05, 06) though it follows the spec; the only bundled stack is one 3-card to-do list, so there is nothing else to open.

## (a) Top 5 reasons it looks ordinary

1. **No desktop.** There is one window filling the screen, with no icons, trash, clock, or sound toggle, so it reads as a web page with a retro font, not a computer.
2. **Nothing can be moved or resized.** Handles are drawn but dead, windows are fixed, so Edit mode is only a property viewer.
3. **The AI is invisible.** No orange anywhere, no typewriter voice, no dissolve-in on AI changes, and AI edit looks the same as Edit.
4. **One tiny stack.** Three small controls on a mostly empty 512x342 card at 12 px type; a lot of blank paper and no showcase content.
5. **Chrome is half-built.** No close or expand boxes, no Spirit Menu items, no tool palette, a plain bordered-box Ghost panel, stale "arrives in a later release" text.

## (b) Prioritized fix list

**P0: broken or missing behavior**

1. Implement move and resize in Edit mode: pointer drag on the object and on the 8 handles, snapped to the whole-pixel grid, clamped inside the card, with minimum and maximum size from the format limits (`LIMITS.objectSize`, `objectPosition`). Commit one `update_object` per gesture so autosave and the engine keep the stack valid. This needs no engine or format change.
2. Make the handles real (`pointer-events`, cursors per handle, keyboard nudge with arrows, Shift for bigger steps).
3. Replace the stale AI-field placeholder text.

**P1: big visual gaps** 4. A real desktop: dithered background, stack icons you double-click, trash, selected-icon inversion. 5. Window chrome: close box, expand box, drag by title bar, active and inactive windows, so the Stacks and Ghost windows are real windows. 6. Menu bar: Spirit Menu, File, Edit, Stack, Mode, Help, clock, sound toggle (with the first synthesized sounds), the quota counter. 7. Ghost: bigger sprite with an idle animation, typewriter text in VT323, orange only while the AI works (needs a `ghost.css` exemption in the CSS test or a token alias), an orange outline on the AI-edit selection, a ghost cursor. 8. A distinct look for AI edit mode versus Edit mode. 9. More stack content: showcase stacks with bigger, better-composed cards.

**P2: polish** 10. Type scale and sizes at 1x (12 px is too small), empty states (log placeholder, sleeping Ghost hint), button labels that fit, Send and Undo disabled style. 11. Tablet layout: Ghost as a bottom sheet, integer scaling with dithered letterbox. 12. Favicon, dialog scrim density, hover and pressed states, reduced-motion check.

## (c) Specs too vague, or code ignoring them?

- **Steering too vague / spec gap:** the design language describes the whole look but no spec ever turned it into tasks. The `thin-slice` spec deliberately built a plain slice, and the planned `retro-ui-shell` spec was deferred ("waits for the feedback list") and never written. Move, resize, windows, icons, clock, sound and the Spirit Menu have no requirements anywhere. Nobody ignored them; they were never assigned.
- **Specs vague on a key point:** the thin-slice and AI specs say the handles are "purely visual", which is what the code does. Only the design language implies they work.
- **Code ignoring the steering:** the stale "AI arrives in a later release" AI-field text, the ink-only Ghost despite the accent rule, and AI edit sharing Edit's cursor and chrome. These contradict written rules that existed at the time.
- **Missing source documents:** the storyboard file you named does not exist, so nothing defines what the demo shot must look like.

## Open questions for Phase 3 (please answer when you approve)

1. Should the stack window and Ghost become real draggable windows on a free-form desktop, or keep the current fixed layout with only the desktop icons, clock and sound added? The first is a larger rewrite of `Desktop.tsx` and the layout CSS.
2. By "resizing cards" do you mean changing the card size of a stack (512x342), or resizing objects on a card? I assumed objects and will keep the card fixed unless you say otherwise.
3. May I add the Ghost accent exemption to `css-tokens.test.ts` (one test changes) so the AI can show orange?
4. Should a `retro-ui-shell` spec (requirements, design, tasks) come first, as the project's working agreements imply, or should I fix straight from this list?

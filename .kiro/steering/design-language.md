---
inclusion: auto
name: design-language
description: HyperGeist visual design language (1-bit classic Mac style, ink and paper with a single AI accent). Use for any UI, styling, CSS tokens, components, windows, the Ghost AI character, motion, sound, accessibility, or responsiveness work, and when writing specs for the UI shell.
---

# HyperGeist Design Language: 1-Bit Classic Mac Style

Place this file at `.kiro/steering/design-language.md`. Every UI task must follow it.

## 1. Intent

HyperGeist resurrects the *feel* of 1980s HyperCard-era desktop computing (monochrome, dithered, pixel-precise) and lets modern AI show up inside it. The look is **inspired by** that era. It is **not a copy** of any trademarked product.

**The one-line rule:** *Everything is black ink on paper. The only color on screen is the AI.*

## 2. Legal / originality guardrails (hard rules)

The demo video and app must contain **no third-party trademarks**. Therefore:

- DO NOT use the Apple logo, the Chicago font, the original Mac system icons, the original Finder/Macintosh names or sounds, or any Microsoft/Apple assets.
- DO NOT name UI elements "Finder", "Macintosh", "System 6", or "Apple Menu". Use our own: **Desktop**, **Stack**, **Card**, **Ghost**, **Spirit Menu**.
- Draw all icons, the mascot, and sounds ourselves, or use assets whose licenses permit it (OFL fonts, MIT/CC0 icon packs). Record the source and license of each asset in `docs/assets-licenses.md`.

## 3. Design tokens

Define every token once as a CSS variable (in `apps/web/src/styles/tokens.css`). Never hardcode colors, sizes or fonts in components.

```css
:root {
  /* Ink and paper (the entire 1-bit palette) */
  --ink:   #0B0B0B;
  --paper: #F6F3EC;

  /* The only accent. Reserved for AI activity (section 8). */
  --ghost: #FF6B1A;

  /* Geometry */
  --px: 1px;                 /* base pixel; scale in whole integers only */
  --border: 2px;
  --shadow-offset: 3px;      /* hard drop shadow, never blurred */
  --menubar-h: 24px;
  --titlebar-h: 22px;
  --radius: 0;               /* no rounded corners, except the 2px "chamfer" on window corners */

  /* Type */
  --font-ui: "Pixelify Sans", "Silkscreen", monospace;
  --font-mono: "VT323", monospace;   /* ghost voice, code, timers */
}
```

Rules:
- **Two tones plus one accent.** Do not add grays, gradients, blur, soft shadows, or opacity-based tints. Use dither patterns instead.
- **Integer scaling.** The card canvas and sprites render at whole-number scales (1x, 2x, 3x) with `image-rendering: pixelated`.
- **Hard edges only.** Borders are solid ink. Shadows are solid ink offset blocks.

## 4. Dither patterns

Shading, disabled states and backgrounds use dithering, never gray.

| Token | Use |
|---|---|
| `--dither-50` (checkerboard) | desktop background, disabled controls |
| `--dither-25` (sparse dots) | window drop shadow area, subtle panels |
| `--dither-75` (dense dots) | pressed-state fill, selected-icon backdrop |
| `--stripe` (horizontal lines) | active window title bar |

Implement as small repeating CSS backgrounds (inline SVG or data-URI, 2x2 to 8x8 tiles). Provide them in `tokens.css` and reuse them everywhere.

## 5. Typography

- **UI text:** Pixelify Sans (fallback Silkscreen). **Terminal/ghost/timers:** VT323. All are OFL-licensed. **Self-host the font files** (for example via Fontsource), no runtime requests to external font servers.
- Sizes use a fixed scale (12 / 16 / 24 / 32 px). Never scale fonts fractionally.
- Disable font smoothing to keep edges crisp: `-webkit-font-smoothing: none; font-smooth: never;`.
- Titles are sentence case. Menu items are Title Case. No all-caps except tiny labels.

## 6. Layout and window chrome

**Desktop**
- Menu bar fixed at the top (`--menubar-h`): Spirit Menu (our logo glyph, a small ghost), File, Edit, Stack, Mode, Help. Right side: clock, demo-quota counter, sound toggle.
- Desktop background is `--dither-50`. Stacks appear as **icons** (32x32 pixel sprites with a label beneath). Double-click opens a stack. A selected icon inverts (ink fill, paper text).
- A **trash** icon at the bottom right for deleted stacks (restorable). A **Ghost** window docks at the bottom right.

**Window**
- 2px ink border, hard drop shadow, paper fill.
- Title bar is `--titlebar-h`, striped when active and plain when inactive. Centered title with paper-colored padding behind the text. Close box on the left (a 13x13 square), expand box on the right.
- Windows are draggable by the title bar. Only one window is active at a time. Inactive windows lose their stripes.

**Card canvas (inside a stack window)**
- Fixed logical size **512 x 342** (and integer multiples). Content is positioned in that coordinate space so stacks look identical everywhere.
- A thin status bar at the bottom of the window shows: card number ("Card 2 of 5"), mode, and a hint line.

## 7. Components

Every component supports these states: default, hover (Edit/AI-edit modes only), pressed, focused, disabled.

- **Button:** 2px border, rounded-corner "capsule" is *not* allowed. Default = paper fill, ink text. Pressed = ink fill, paper text (inverted). Primary buttons get a **double border**.
- **Text field:** 2px border, inset 1px, blinking block cursor. Focus = thick left bar.
- **Checkbox/radio:** square and diamond marks, not circles. Checked = X or filled diamond.
- **Scrollbar:** classic arrow boxes with a dithered track.
- **Menu:** inverted highlight bar on the hovered item; separators are dotted lines.
- **Dialog:** modal window with a double-border default button and a dithered scrim over the desktop (not a gray overlay).
- **Tooltip:** one-line paper box with a hard shadow.
- **Timer/stopwatch object:** large VT323 digits in a bordered inset; start/stop/lap are standard buttons.
- **Reminder object:** a small bell glyph plus time; when due, it shakes (3 frames) and the ghost speaks.
- **Image object:** displayed with a 1px frame. All images should pass through a **1-bit dither filter** by default (a "Keep original colors" toggle is allowed per image).

## 8. The three modes (visual language)

The mode must always be obvious at a glance.

| Mode | Cursor | Chrome | Behavior |
|---|---|---|---|
| **Interact** | Pointer | Plain status bar | Objects behave as the user intends. Nothing can be edited or moved. |
| **Edit** | Crosshair | Dashed selection outline, resize handles (8 small squares), a tool palette window | Click to select, drag to move, double-click to edit properties. |
| **AI-edit** | Ghost cursor (small ghost glyph) | `--ghost` accent outline on the selected object, ghost window highlighted | Click an object, then type or speak a request; the ghost edits it. |

- The mode switch is a **segmented control in the menu bar** and a keyboard shortcut. It is never hidden.
- Switching modes plays a short sound and changes the status bar text.

## 9. The Ghost (the AI's face)

- A small **ghost sprite** in its own docked window ("Ghost"). It is original artwork (about 24x24 px, 2-3 frame idle animation).
- It speaks with a **typewriter effect** in VT323. Messages are short.
- **Accent rule:** `--ghost` orange appears **only** when the AI is thinking, speaking, or has just changed something. If orange is visible, the AI is involved. This is how modern AI shows up inside a 1-bit world.
- States: idle (slow blink), thinking (floating bob with dithered "..." bubble), done (small wave), error (flickers, shows a plain-language message plus a retry button).

### How AI changes appear
- New or changed objects appear with a **dissolve-in** (dither fade over ~400 ms) and a brief `--ghost` outline that fades to ink.
- Every AI edit is one undoable step. After an edit the ghost offers **Undo** inline.
- Show a compact **"what I changed"** line in the ghost window (for example "Added a timer to Card 2").

## 10. Motion and sound

- Animations are **frame-stepped** (use `steps()` timing), never smooth easing. Keep durations under 500 ms except idle loops.
- Respect `prefers-reduced-motion`: replace animations with instant state changes.
- Sound uses the Web Audio API with synthesized 8-bit-style blips: click, open/close window, mode switch, ghost speaks, reminder due, startup chime. All original.
- Sound is **off until the user's first interaction**, then on by default with a persistent toggle in the menu bar. Never autoplay on load.

## 11. Accessibility (non-negotiable even in a retro style)

- Contrast is already high (ink on paper). Keep all text at 4.5:1 or better, including `--ghost` text on paper (use ink text with an orange outline or underline instead of orange text for body copy).
- **Full keyboard support:** every control reachable by Tab, visible focus ring (a 2px dashed ink outline), Esc closes dialogs, arrow keys navigate menus.
- Provide ARIA roles and labels for custom windows, menus and objects.
- Never rely on color alone: the accent is always paired with a shape or animation.
- Minimum hit target of 24x24 px, scaled up on touch devices.

## 12. Responsiveness

- **Desktop browsers are the primary target** (1024 px and up): full multi-window desktop.
- **Tablet/phone (secondary):** a single full-screen window at a time, the menu bar collapses to the Spirit Menu, the Ghost becomes a bottom sheet, and cards scale by integer factors with letterboxing in dithered paper.
- Never stretch cards to fractional scales.

## 13. Do / Don't

**Do**
- Use dithering for every shade and state.
- Keep orange meaningful (AI only).
- Reuse tokens and component primitives.
- Make empty states charming (a sleeping ghost with a hint).

**Don't**
- Don't use gradients, blur, opacity fades, rounded buttons, or drop-shadow blur.
- Don't use emoji in the UI chrome (use pixel glyphs).
- Don't copy any third-party logo, icon, font or sound.
- Don't add colors beyond ink, paper and ghost.
- Don't hide the mode indicator.

## 14. Definition of done for any UI task

A UI change is complete only when:
- [ ] It uses only tokens from `tokens.css`, with no hardcoded colors, sizes, or fonts.
- [ ] It renders correctly at 1x, 2x and 3x integer scales.
- [ ] All states (default, hover, pressed, focused, disabled) exist.
- [ ] It is fully keyboard-operable with a visible focus ring.
- [ ] It respects `prefers-reduced-motion`.
- [ ] Any accent (`--ghost`) usage indicates AI activity only.
- [ ] Any new asset has its source and license recorded.
- [ ] It looks right as a still frame in the demo video.

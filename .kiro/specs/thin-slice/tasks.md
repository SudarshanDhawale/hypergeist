# Implementation Plan: Thin Slice

## Overview

The plan builds the slice from the bottom up: tooling settings, the format module (schemas, validator), the engine (executor), the demo stack, the CLI, the web helpers that need no new package, a Developer checkpoint for the dependency install, then the Zustand store, the React shell, tests, README, and verification. The language is TypeScript (strict, Zod 4), as fixed by the design and the tech-stack steering.

Every task refers to the requirement numbers in `requirements.md` and the module names in `design.md`. Property tests use `assertProperty` from `packages/shared/test-support/seed.ts`. Each property test file carries the comment `Feature: thin-slice, Property N: <title>`.

## Executor safety rules (apply to every task)

- This shell has no network access. Never run `pnpm install`, `pnpm add`, `pnpm update`, `npm install`, `pnpm approve-builds`, or any command that changes `node_modules`. A failed install earlier emptied `node_modules/.pnpm`.
- Never edit dependency lists in a `package.json` by hand, and never edit `pnpm-lock.yaml`. Task 11 hands the install to the Developer.
- Until task 11.2 passes, `@hypergeist/shared` is not linked at the repository root, so root-level commands that resolve it (`pnpm test`, `pnpm typecheck`, anything under `scripts/stack`) fail. Before task 11.2 use scoped commands only: `pnpm --filter @hypergeist/shared test`, `pnpm --filter @hypergeist/shared typecheck`, `pnpm --filter @hypergeist/web test`, `pnpm --filter @hypergeist/web typecheck`, or `pnpm exec vitest run <path>` with a path inside `packages/shared` or `apps/web`.
- Run `pnpm format` before any `pnpm format:check`.
- `pnpm build` in this sandbox needs `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false` in front of it.
- Never run `pnpm test:e2e` here. Chromium cannot create pages in the sandbox. Task 20.1 hands it to the Developer.
- Do not commit, push, or deploy. The Developer commits.
- Write relative imports in `packages/shared/src` and `scripts/` with explicit `.ts` extensions, and use erasable TypeScript syntax only.

## Tasks

- [x] 1. Tooling settings that need no new package
  - [x] 1.1 Configure root tooling for `.ts` specifiers and the CLI script
    - In `tsconfig.base.json` add `"allowImportingTsExtensions": true`.
    - In `eslint.config.mjs` add the `no-restricted-imports` block from the design for `packages/shared/src/**/*.ts` and `scripts/**/*.ts`, so a relative import without `.ts` fails lint.
    - In `.prettierignore` add `scripts/stack/fixtures`.
    - In the root `package.json` add only the script `"stack": "node scripts/stack/cli.ts"`. Do not touch `devDependencies`.
    - Fix any existing relative import that the new lint rule flags in `packages/shared/src` or `scripts/` (the existing `test-support` folder is outside the rule).
    - _Requirements: 10.1, 10.10, 21.6_

  - [x] 1.2 Configure the web app for `?raw` imports and font files
    - In `apps/web/tsconfig.json` set `"types": ["vite/client"]`.
    - Create `apps/web/src/vite-env.d.ts` with `/// <reference types="vite/client" />`.
    - In `apps/web/vite.config.ts` set `build.assetsInlineLimit: 0` so fonts always emit as files.
    - _Requirements: 21.1, 12.7_

- [x] 2. Format module in `packages/shared/src/format`
  - [x] 2.1 Create limits, errors, and text helpers
    - `limits.ts`: `LIMITS`, `ENTITY_ID_PATTERN`, `FORMAT_VERSION`, `SUPPORTED_OBJECT_TYPES`, `UNSUPPORTED_OBJECT_TYPES`, `SUPPORTED_ACTION_TYPES`, `UNSUPPORTED_ACTION_TYPES`, with the values from the design.
    - `errors.ts`: `VALIDATION_ERROR_CODES` (all 14 codes), `ValidationError`, `ValidationResult`, `ValidationErrorCode`.
    - `text.ts`: hand-written `utf8ByteLength` (no `TextEncoder`), `codePointLength`, JSON Pointer escape helpers (`~0`, `~1`).
    - Write `constants.test.ts` that pins every `LIMITS` value, the pattern, both type lists, and the closed code list.
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 2.6, 2.7, 6.3_

  - [x] 2.2 Create the Zod 4 schemas
    - `schemas.ts`: strict objects for Stack, Card, Link, Button, Field, List, the four Action types, `ObjectSchema` and `ActionSchema` as discriminated unions, and `HandlerSchema`. Property order follows the requirement text.
    - Use the `text(min, max)` helper so maximums count code points. Both exactly-one-of properties are optional here.
    - Derive every exported type with `z.infer`. Do not hand-write a duplicate type.
    - _Requirements: 1.1, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 2.3 Map Zod issues to raw errors
    - `zod-issues.ts`: the mapping table from the design (unknown keys, missing keys, integer and type errors, limits, `invalid_union` discriminator handling for absent, non-string, unsupported, and unknown `type`).
    - Build `expected` and `hint` for every error kind so none is empty. Use the exact "not supported in this release" and "is unknown" messages.
    - Produce segment arrays; pointer strings are built later in `finalize.ts`.
    - _Requirements: 2.7, 2.8, 2.9, 2.10, 2.11, 5.1, 5.2, 5.3, 5.4, 6.3_

  - [x] 2.4 Implement the semantic pass
    - `semantic.ts`: tolerant walk of the raw candidate with type guards. Build the entity index in document order. Report `DUPLICATE_ID`, `DANGLING_REFERENCE`, `WRONG_REFERENCE_TYPE` per the reference table, exactly-one-of `INVALID_VALUE`, `OUT_OF_BOUNDS` (once per Object, inclusive edge), and `DUPLICATE_LINK`.
    - Export one Handler walker that Buttons, Cards, and `validateHandler` all use.
    - Skip subtrees of the wrong shape and Objects or Actions of an unsupported type (except registering the Object id).
    - _Requirements: 3.5, 3.6, 4.2, 4.3, 4.4, 4.6, 4.7, 4.8, 4.9, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [x] 2.5 Implement finalize, `validateStack`, `validateHandler`, and the public API
    - `finalize.ts`: document-order key by walking the candidate, sort by key then `code`, keep the first 100, set `truncated`, build final errors with pointers and `actual` (cut to 200 code points, `null` when absent).
    - `validate.ts`: the pipeline from the design (2 MiB text limit, `JSON.parse`, non-object root, `UNSUPPORTED_VERSION`, Zod parse, semantic pass, indented-size check only when no other error). Never throw.
    - `index.ts`: export the public API listed in the design, and nothing else.
    - _Requirements: 1.1, 1.8, 6.1, 6.2, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.14_

  - [x] 2.6 Write unit tests for structure, limits, and result shape
    - `validate.test.ts`: boundary tables (at max, max plus 1, at min, min minus 1) with ASCII and astral text; one example per error code; 99, 100, and 150 violations; text at 2,097,152 bytes and one byte more; an indented stack over 2 MiB; `formatVersion` 2, 0, and 1.5; non-object roots; malformed JSON; string input; no mutation of the candidate.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 2.8, 2.9, 2.10, 2.11, 3.1, 3.2, 3.3, 3.4, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12, 6.13, 6.14_

  - [x] 2.7 Write unit tests for unsupported types and semantic rules
    - `unsupported-types.test.ts`: one test for each of `image`, `ai-field`, `remove_item`, `run_ai_field`, `fetch_news`, `transcribe_audio`, `schedule_notification` that asserts the code, the `path` (`.../type`), and the "not supported in this release" message. Add tests for an unknown type, an absent type, and a non-string type.
    - `semantic.test.ts`: duplicate ids across kinds, dangling and wrong-kind references for each reference property, exactly-one-of (both and neither), bounds at the exact edge and one past it, duplicate links, a self-link, and equal targets in different Cards. Add `validateHandler` tests.
    - _Requirements: 3.5, 3.6, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 5.1, 5.2, 5.3, 5.4, 5.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

- [x] 3. Generators and core format property tests
  - [x] 3.1 Create the fast-check generators
    - `packages/shared/test-support/arbitraries.ts`: `arbStack` (1 to 5 Cards, unique id pool, in-bounds Objects of each type including edge-flush, 500-item Lists, astral text, Links, Handlers over existing ids), `arbHandlerFor(stack)` (0 to 20 valid Actions of each type, including Actions the executor skips), `arbMutation`, and a candidate arbitrary that mixes `fc.jsonValue()`, JSON text, and mutated stacks.
    - Add a short test that checks the generator output is valid (a smoke check for the generator itself).
    - _Requirements: 22.1, 22.2, 22.3_

  - [x] 3.2 Write property test for valid stacks and JSON round trip
    - **Property 1: Valid stacks validate and survive JSON**
    - File: `valid-stacks.property.test.ts`.
    - **Validates: Requirements 6.2, 22.3, 22.7**

  - [x] 3.3 Write property test for validator totality and determinism
    - **Property 2: The validator is total, pure, and deterministic**
    - File: `validator-total.property.test.ts`. Include deeply frozen candidates.
    - **Validates: Requirements 6.1, 6.14, 22.8**

- [ ] 4. Extra format property tests (optional)
  - [ ]* 4.1 Write property test for well-formed results
    - **Property 3: Results are well-formed**
    - File: `result-shape.property.test.ts`.
    - **Validates: Requirements 1.4, 6.2, 6.3, 6.5, 6.13**

  - [ ]* 4.2 Write property test for document order
    - **Property 4: Errors follow document order**
    - File: `document-order.property.test.ts`. Use an independent traversal as the oracle.
    - **Validates: Requirements 6.6**

  - [ ]* 4.3 Write property test for unsupported and unknown types
    - **Property 5: Unsupported and unknown types are rejected cleanly**
    - File: `unsupported-types.property.test.ts`.
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4**

  - [ ]* 4.4 Write property test for inclusive bounds
    - **Property 6: Bounds are inclusive and reported once per Object**
    - File: `bounds.property.test.ts`.
    - **Validates: Requirements 3.5, 3.6**

  - [ ]* 4.5 Write property test for unique entity ids
    - **Property 7: Entity ids are unique across kinds**
    - File: `duplicate-ids.property.test.ts`.
    - **Validates: Requirements 7.1**

  - [ ]* 4.6 Write property test for reference resolution
    - **Property 8: References resolve by kind**
    - File: `references.property.test.ts`.
    - **Validates: Requirements 4.2, 4.3, 4.4, 4.7, 4.8, 7.2, 7.3**

  - [ ]* 4.7 Write property test for Link rules
    - **Property 9: Link rules**
    - File: `links.property.test.ts`.
    - **Validates: Requirements 7.4, 7.5, 7.6**

- [x] 5. Checkpoint - Format module
  - Run `pnpm format`, then `pnpm --filter @hypergeist/shared typecheck` and `pnpm --filter @hypergeist/shared test`. Ensure all tests pass, ask the user if questions arise.

- [x] 6. Engine in `packages/shared/src/engine`
  - [x] 6.1 Create engine types and immutable helpers
    - `types.ts`: `ExecutionResult`, `EffectRequest` (`never`).
    - `stack-edit.ts`: `findObject`, `withObject` (rebuilds only the changed path, never writes to inputs), `textOf`.
    - Import from `../format/index.ts` only.
    - _Requirements: 8.4, 8.5, 8.13_

  - [x] 6.2 Implement `executeHandler` and the engine public API
    - `execute-handler.ts`: validate Stack, validate Handler, run Actions in order, `go_to_card` stops the loop, `append_item` on a full List adds the "full" message, a result that fails `validateStack` is skipped with a "Skipped action" message. `effects` is always `[]`. `navigateTo` is omitted when unset.
    - `index.ts`: export `executeHandler`, `ExecutionResult`, `EffectRequest`.
    - _Requirements: 1.8, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14_

  - [x] 6.3 Write unit tests for the executor
    - `execute-handler.test.ts`: at least one example per Action type asserting the Stack, `messages`, `navigateTo`, and `effects`; empty Handler; full List (500 items); an Action that is skipped (Field copied into a List past 500 characters, or a List joined into a Field past 10,000); invalid Stack; invalid Handler; deeply frozen inputs.
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.15_

  - [x] 6.4 Write property test for purity and determinism
    - **Property 10: The executor is pure, deterministic, and effect-free**
    - File: `purity.property.test.ts`. Freeze both inputs deeply.
    - **Validates: Requirements 8.3, 8.13, 8.14, 22.4, 22.6**

  - [x] 6.5 Write property test for result validity
    - **Property 11: Results stay valid and skips are clean**
    - File: `result-validity.property.test.ts`.
    - **Validates: Requirements 8.1, 8.10, 22.5**

  - [ ]* 6.6 Write property test for `go_to_card`
    - **Property 12: go_to_card stops execution**
    - File: `go-to-card.property.test.ts`.
    - **Validates: Requirements 8.1, 8.9**

  - [ ]* 6.7 Write property test for text copying
    - **Property 13: set_value and append_item copy text exactly**
    - File: `copy-text.property.test.ts`.
    - **Validates: Requirements 8.4, 8.5, 8.6, 8.7**

  - [ ]* 6.8 Write property test for invalid input
    - **Property 14: Invalid input runs nothing**
    - File: `invalid-input.property.test.ts`.
    - **Validates: Requirements 8.11, 8.12**

- [x] 7. Demo stack and asset records
  - [x] 7.1 Create the Demo_Stack and its test
    - `apps/web/src/stacks/thin-slice-todo.json` as laid out in the design (3 Cards, 512 by 342, the exact Add handler of three Actions, read-only About and Limits Fields, Links and Buttons as specified). Every Card has `onOpen: []`.
    - `apps/web/src/stacks/demo-stack.test.ts`: import the file with `?raw`, pass the text to `validateStack`, assert `valid` is true, then assert card names and order, the start Card, the Add handler action order, only supported Object and Action types, and the required wording of the About and Limits Fields.
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9_

  - [x] 7.2 Add asset license rows and a test
    - In `docs/assets-licenses.md` add rows for Pixelify Sans and VT323 (source URL, `SIL Open Font License 1.1`, use in the Web_App, date added) and a row for the sleeping Ghost sprite that states it is original project artwork.
    - Add `scripts/stack/assets-licenses.test.ts` that reads the file and asserts the three rows.
    - _Requirements: 20.4, 20.5, 20.6_

- [x] 8. Stack CLI (code written now, run after the dependency checkpoint)
  - [x] 8.1 Implement the pure runner, entry point, and fixtures
    - `scripts/stack/run.ts`: `run(argv, readText)` returning `{ stdout, stderr, exitCode }` per the CLI table. Import `validateStack` from `@hypergeist/shared/format`. Pass the file text unparsed.
    - `scripts/stack/cli.ts`: read the file with `fs.readFileSync(path, 'utf8')`, write the output, set `process.exitCode`. No other dependency and no network call.
    - `scripts/stack/fixtures/invalid-stack.json` and `not-json.txt`.
    - `scripts/stack/run.test.ts` with an injected reader: exit 0, 1 (valid false and `INVALID_JSON`), and 2 (usage and unreadable file, empty stdout).
    - Do not run these tests yet: they need the link from task 11. Check them in task 12.1.
    - _Requirements: 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.10, 20.2_

  - [x] 8.2 Write the child-process CLI test
    - `scripts/stack/cli.test.ts`: spawn `node --disable-warning=ExperimentalWarning scripts/stack/cli.ts validate <file>` against the Demo_Stack (exit 0), `fixtures/invalid-stack.json` (exit 1, every error has `code`, `path`, `message`, `expected`, `actual`, `hint`), `fixtures/not-json.txt` (exit 1, `INVALID_JSON`), a missing file, a directory, and missing arguments (exit 2, empty stdout, one stderr line). Run it from the repository root.
    - _Requirements: 10.3, 10.4, 10.5, 10.6, 10.9_

- [x] 9. Web helpers and styles that need no new package
  - [x] 9.1 Create pure helpers with unit tests
    - `lib/canvas-scale.ts` (`chooseCanvasScale`), `lib/accessible-name.ts`, `lib/property-rows.ts`, `lib/css-vars.ts` (one commented cast), each with a `*.test.ts` file: the scale table including "no larger scale fits", the name fallback order (`name`, `label` or `placeholder`, `id`), rows per Object type, empty-string display.
    - _Requirements: 12.9, 12.10, 16.5, 19.4_

  - [x] 9.2 Create `loadStack` with tests
    - `stacks/load-stack.ts`: `loadStack(text)` validates first, then parses with `StackSchema` for a typed value, and returns `{ ok: true, stack } | { ok: false, errors }`.
    - `load-stack.test.ts`: valid text, invalid text, empty text, and text with one unsupported object type.
    - _Requirements: 11.1, 11.2, 11.3_

  - [x] 9.3 Write the CSS files
    - `styles/tokens.css`: every token from the design (palette, geometry, type, dither tiles with the `--ink` and `--paper` hex values, `--stripe`, `--hit-min`, `--focus-w`, `--fs-12/16/24/32`). `--ghost` is defined and referenced nowhere else.
    - `base.css` (font smoothing off, desktop `--dither-50`, focus outline, reduced-motion guard), `window.css`, `controls.css` (pressed state, 24 by 24 hit area, read-only Field dither), `canvas.css` (`image-rendering: pixelated`, `--x/--y/--w/--h/--scale` positioning with `--px`, cursors per mode, selection outline and handles), `ghost.css`. Use tokens for every color, length, and font family. No gradient, blur, opacity, or media query with a length.
    - _Requirements: 12.1, 12.2, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 13.5, 14.3, 16.3, 16.8, 19.2, 19.5, 19.7_

  - [x] 9.4 Create the CSS scanner and its tests
    - `styles/scan-css.ts`: `scanCss(text)` per the design (color literals and functions, named colors, font-family literals, `px`/`rem`/`em` lengths, gradients, `blur(`, `opacity`).
    - `styles/css-tokens.test.ts`: load CSS with `import.meta.glob(..., { query: '?raw', import: 'default', eager: true })`; assert every file except `tokens.css` has no findings and no `--ghost`; assert `tokens.css` defines every required token; assert the dither tiles use the `--ink` and `--paper` hex values; assert `base.css` holds both font-smoothing declarations; assert no `.tsx` source mentions `--ghost`. Add scanner unit tests with a passing and a failing snippet for each rule.
    - _Requirements: 12.1, 12.2, 12.3, 12.5, 12.8_

- [x] 10. Checkpoint - Work that needs no new package
  - Run `pnpm format`, then `pnpm --filter @hypergeist/shared typecheck`, `pnpm --filter @hypergeist/shared test`, `pnpm --filter @hypergeist/web typecheck`, `pnpm --filter @hypergeist/web test`, and `pnpm exec eslint packages/shared apps/web`. Do not run root `pnpm test` or `pnpm typecheck` yet (see the safety rules). Ensure all tests pass, ask the user if questions arise.

- [x] 11. USER CHECKPOINT - Install dependencies
  - [x] 11.1 Hand the install to the Developer and stop
    - Do not run any install command. Tell the Developer to run these two commands in their own terminal, from the repository root, then reply when both finish:
      ```sh
      pnpm --filter @hypergeist/web add zustand @fontsource/pixelify-sans @fontsource/vt323
      pnpm add -w -D '@hypergeist/shared@workspace:*'
      ```
    - The quotes around the second specifier are needed for zsh.
    - Then stop and wait for the Developer's confirmation before starting any later task.
    - _Requirements: 20.1, 20.2, 20.3_

  - [x] 11.2 Verify the manifests and lockfile without installing
    - Read `apps/web/package.json` and confirm `zustand`, `@fontsource/pixelify-sans`, and `@fontsource/vt323` are in `dependencies` and no other new third-party package appeared (compare with `git diff apps/web/package.json`).
    - Read the root `package.json` and confirm `@hypergeist/shared` is in `devDependencies` as `workspace:*`.
    - Confirm `pnpm-lock.yaml` changed (`git diff --stat pnpm-lock.yaml`) and mentions the three packages.
    - Confirm by listing directories only that `node_modules/@hypergeist/shared` and `apps/web/node_modules/zustand` exist.
    - If anything is missing, stop and report it to the Developer. Do not run an install.
    - _Requirements: 20.1, 20.3_

- [x] 12. Verify the CLI after linking
  - [x] 12.1 Run the CLI tests and the CLI on the Demo_Stack
    - Run `pnpm exec vitest run scripts` and fix failures in the files from tasks 7.2, 8.1, and 8.2.
    - Run `pnpm stack validate apps/web/src/stacks/thin-slice-todo.json` and confirm the JSON output has `"valid": true` and exit code 0.
    - Run `pnpm exec tsc -p scripts/tsconfig.json` and fix errors.
    - _Requirements: 10.2, 10.3, 10.4, 10.5, 10.6, 10.9_

- [x] 13. Web state
  - [x] 13.1 Implement hints, the Zustand store, and its context
    - `state/hints.ts` with the two hint strings (each names Alt+M, and they differ).
    - `state/stack-store.ts`: `createStackStore(stack)` using `zustand/vanilla`, with `setMode`, `toggleMode`, `selectObject`, `clearSelection`, `activateButton`, `typeInField`, `followLink`, `expireStatus`. Executor calls go through `executeHandler`. Wrong-mode calls and unknown ids are no-ops. Empty `messages` leave `status` unchanged. No timers in the store.
    - `state/StackStoreContext.tsx`: provider and `useStackStore(selector)`.
    - _Requirements: 11.2, 13.3, 13.4, 13.6, 13.7, 14.1, 14.2, 14.6, 14.7, 14.8, 14.9, 15.1, 15.3, 15.6, 16.1, 16.2, 16.7, 18.1_

  - [x] 13.2 Write unit tests for the store
    - `stack-store.test.ts`: every action; Interact versus Edit rules; Edit mode never calls the executor (spy on the engine module); `typeInField` ignores read-only Fields; `navigateTo` changes the Card and clears Selection and status; the status `seq` increments; `expireStatus` with a stale `seq` is a no-op; Mode change clears Selection and status.
    - _Requirements: 13.3, 13.4, 14.1, 14.2, 14.6, 14.7, 14.8, 15.1, 15.3, 15.6, 16.1, 16.2, 16.7_

- [x] 14. React shell
  - [x] 14.1 Create the Canvas and its object components
    - `components/Canvas.tsx` (sets `--card-w`, `--card-h`, `--scale`, `data-mode`, `data-scale`; measures the frame with `ResizeObserver` and falls back to scale 1), `ObjectView.tsx` (native controls in Interact mode; in Edit mode a focusable wrapper with `aria-pressed` around an inert preview), `SelectionOverlay.tsx` (dashed outline and 8 non-interactive handles), `LinkBar.tsx` (buttons; `aria-disabled` and no navigation in Edit mode).
    - Lists render as `<ol>` or `<ul>` with `tabindex="0"` and scroll. Multiline Fields use `<textarea>`. Read-only Fields reject typing.
    - Tab order follows `objects` order, then `links` order.
    - _Requirements: 12.9, 12.10, 14.1, 14.2, 14.3, 14.4, 14.5, 14.7, 14.10, 16.1, 16.2, 16.3, 16.4, 16.8, 16.9, 19.1, 19.3, 19.4_

  - [x] 14.2 Create the Property_Readout and Status_Bar
    - `components/PropertyReadout.tsx`: labelled read-only region with a `<dl>` from `propertyRows`, a prompt when nothing is selected, no editable control.
    - `components/StatusBar.tsx`: `Card N of M`, `Mode: Interact` or `Mode: Edit`, and the Hint_Line as `role="status"` (polite). Add the 4-second `useEffect` expiry keyed on `status.seq`.
    - _Requirements: 13.2, 13.6, 13.7, 14.8, 15.1, 15.2, 15.3, 15.4, 15.5, 16.5, 16.6, 16.10_

  - [x] 14.4 Create the Ghost window
    - `components/GhostSprite.tsx`: inline SVG from a pixel-map constant (original artwork, at most 24 by 24 cells, `--ink` and `--paper` only).
    - `components/GhostWindow.tsx`: `<aside>` with the accessible name "Ghost is asleep. AI arrives in a later release.", a title bar "Ghost", and the text "AI arrives in a later release" in the mono font. No interactive element, no animation, no `--ghost` color.
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 19.3_

  - [x] 14.3 Create the Stack_Window
    - `components/StackWindow.tsx`: `<section>` named by its title bar (`--stripe`, stack name), the Canvas, the LinkBar, the not-saved notice (`role="note"`: "Changes are not saved. Reloading the page resets this stack."), the PropertyReadout in Edit mode only, and the StatusBar.
    - _Requirements: 12.6, 14.8, 16.9, 16.10, 18.3, 19.3_

  - [x] 14.5 Create the menu bar, mode control, and desktop
    - `components/ModeControl.tsx`: native radio group "Interact" and "Edit", one Tab stop.
    - `components/MenuBar.tsx`: `<header>` with a decorative Spirit glyph, `<h1>HyperGeist</h1>`, and the Mode_Control.
    - `components/Desktop.tsx`: layout grid with the Stack_Window and a right-hand rail holding the Ghost window; global key listener for Alt+M (use `event.code === 'KeyM'`) and Escape in Edit mode.
    - _Requirements: 11.5, 12.6, 13.1, 13.2, 13.3, 13.4, 13.5, 16.7, 17.5, 19.1, 19.3_

  - [x] 14.6 Wire App, LoadErrorScreen, and main
    - `components/LoadErrorScreen.tsx`: keeps the `<h1>HyperGeist</h1>` heading and lists `code`, `path`, and `message` for each error in plain language.
    - `App.tsx`: optional `stackText` prop that defaults to the bundled Demo_Stack text; calls `loadStack`; renders `LoadErrorScreen` (no Stack_Window) or `StackStoreProvider` with `Desktop`.
    - `main.tsx`: import `@fontsource/pixelify-sans/400.css`, `@fontsource/vt323/400.css`, the five style files, and the Demo_Stack text with `?raw`.
    - Update the existing `App.test.tsx` so the heading test still passes.
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 12.7, 18.1, 18.2, 20.1_

- [x] 15. Web tests
  - [x] 15.1 Write component tests for Interact and Edit behavior
    - `StackWindow.test.tsx` (render inside the provider): Add button appends an item and clears the Field; typing updates the Field; read-only Field rejects typing; ordered and unordered Lists; Link navigation and "Card 2 of 3"; in Edit mode, activating a Button selects it, runs no Handler (executor spy) and adds no item; 8 handles; Property_Readout rows; no selection UI in Interact mode; Escape clears the Selection.
    - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.7, 14.8, 14.14, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.9, 22.14_

  - [x] 15.2 Write the Hint_Line timing test
    - `StatusBar.test.tsx` with `vi.useFakeTimers()`: a message replaces the hint, restores after 4 seconds, restarts when a new action occurs before 4 seconds, an empty message list leaves the text unchanged, and the region is polite (`role="status"`).
    - _Requirements: 15.1, 15.2, 15.3, 15.4, 15.6, 22.14_

  - [x] 15.3 Write app-level tests
    - `App.startup.test.tsx`: invalid `stackText` shows the error screen with `code`, `path`, `message`, and no Stack_Window; the heading stays; Alt+M toggles the Mode and clears the Selection; the Mode text and hints differ and name Alt+M; the Ghost window has the accessible name and no interactive element; the not-saved notice shows on all three Cards; Tab order is Mode_Control, Objects, Links; no write to `localStorage`, `sessionStorage`, `document.cookie`, or `indexedDB` (spies).
    - _Requirements: 11.3, 11.5, 13.1, 13.2, 13.4, 13.6, 13.7, 17.3, 17.4, 18.1, 18.3, 19.1, 22.14_

- [x] 16. Checkpoint - Web shell
  - Run `pnpm format`, then `pnpm --filter @hypergeist/web typecheck` and `pnpm --filter @hypergeist/web test`. Ensure all tests pass, ask the user if questions arise.

- [x] 17. End-to-end tests (written here, run by the Developer)
  - [x] 17.1 Write `e2e/thin-slice.spec.ts`
    - Keep `e2e/smoke.spec.ts` unchanged.
    - Test 1, shell: the "HyperGeist" heading, the Mode radio group, `Mode: Interact`, the Ghost text, and every request (fonts included) on the app origin.
    - Test 2, add: type in "New item", activate "Add item", assert the List shows the item, the Field is empty, and the status region shows "Item added."
    - Test 3, navigate: follow "About this stack", press "Back to to-do", assert "Card 1 of 3".
    - Test 4, edit: switch to Edit mode, select "Add item", assert the 8 handles, the Property_Readout values (`todo-add`, `button`), and that activating it adds no item.
    - Test 5, reload: add an item, reload, assert the List is empty and the not-saved notice is visible.
    - Check only with `pnpm exec tsc -p e2e/tsconfig.json`. Do not run Playwright.
    - _Requirements: 22.9, 22.10, 22.11, 22.12, 22.13, 11.4, 12.7_

- [x] 18. Documentation
  - [x] 18.1 Update the README
    - Run steps: install dependencies, `pnpm build`, start the Worker dev server (`pnpm --filter @hypergeist/worker dev`), open `http://localhost:8787`, and optionally start the Vite dev server (`pnpm --filter @hypergeist/web dev`) on port 5173.
    - Document `pnpm stack validate <file>`: output format, exit codes 0, 1, and 2, and an example on `apps/web/src/stacks/thin-slice-todo.json`.
    - List the limits: no saving, no AI, no Object editing, no `onOpen` execution, and the supported Object and Action types.
    - Replace the "scaffold only" paragraph so it matches the slice.
    - _Requirements: 21.3, 21.4, 21.5_

- [x] 19. Full verification
  - [x] 19.1 Run every check and fix failures
    - Run `pnpm format`, then `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm check:deps`, and `pnpm test`.
    - Run `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false pnpm build`. Confirm `apps/web/dist` holds the font files.
    - Confirm `pnpm check:deps` reports no import from an app to a shared internal and no cross-app import.
    - Do not run `pnpm test:e2e`. Do not commit.
    - _Requirements: 21.1, 21.2, 21.6, 21.7_

- [x] 20. USER CHECKPOINT - Run the end-to-end tests
  - [x] 20.1 Hand `pnpm test:e2e` to the Developer and stop
    - Do not run Playwright. Tell the Developer to run `pnpm test:e2e` in their own terminal from the repository root (Playwright starts the Worker on port 8787; `pnpm build` must have run first), and to report any failures.
    - The expected result is the three existing smoke tests plus the five tests of `e2e/thin-slice.spec.ts` passing.
    - If the Developer reports failures, fix the code or the spec, re-run task 19.1, and ask for another run.
    - _Requirements: 21.6, 22.9, 22.10, 22.11, 22.12, 22.13_

- [x] 21. Final checkpoint - Run it locally
  - Ensure all tests pass, ask the user if questions arise. Then give the Developer these steps:
    - Build once: `pnpm build`.
    - Worker dev server, which serves the built app: `pnpm --filter @hypergeist/worker dev`, then open `http://localhost:8787`. Check `http://localhost:8787/api/health` returns `{"ok":true}`.
    - Optional Vite dev server with hot reload: `pnpm --filter @hypergeist/web dev`, then open `http://localhost:5173` (it proxies `/api` to port 8787, so keep the Worker running).
    - Validate the demo stack: `pnpm stack validate apps/web/src/stacks/thin-slice-todo.json` (expect `"valid": true` and exit code 0).
    - Try it: add an item, follow the About and Limits links, switch to Edit mode with Alt+M, select a button, then reload and see the list reset.
    - Commit when satisfied. The executor does not commit.

## Notes

- Tasks marked with `*` are optional extra property tests (Properties 3 to 9 and 12 to 14). The core properties (1, 2, 10, 11) are required because Requirement 22 names them.
- Unit, example, and component tests are required, not optional.
- Task 11 is a gate. No task after it may start until the Developer confirms and task 11.2 passes. Task 20 is the second gate for the browser tests.
- Tasks 8.1 and 8.2 write the CLI before the link exists, so they cannot be run until task 12.1.
- Each property test file carries `Feature: thin-slice, Property N: <title>` and reports its seed and replay command through `assertProperty`.
- Each task refers to specific requirements for traceability.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["2.1", "7.2", "9.3"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4"] },
    { "id": 3, "tasks": ["2.5"] },
    { "id": 4, "tasks": ["2.6", "2.7", "3.1", "6.1", "7.1", "8.1", "9.1", "9.2", "9.4"] },
    {
      "id": 5,
      "tasks": ["3.2", "3.3", "4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "6.2", "8.2"]
    },
    { "id": 6, "tasks": ["6.3", "6.4", "6.5", "6.6", "6.7", "6.8"] },
    { "id": 7, "tasks": ["11.1"] },
    { "id": 8, "tasks": ["11.2"] },
    { "id": 9, "tasks": ["12.1", "13.1"] },
    { "id": 10, "tasks": ["13.2", "14.1", "14.2", "14.4"] },
    { "id": 11, "tasks": ["14.3", "15.2"] },
    { "id": 12, "tasks": ["14.5", "15.1"] },
    { "id": 13, "tasks": ["14.6"] },
    { "id": 14, "tasks": ["15.3", "17.1", "18.1"] },
    { "id": 15, "tasks": ["19.1"] },
    { "id": 16, "tasks": ["20.1"] }
  ]
}
```

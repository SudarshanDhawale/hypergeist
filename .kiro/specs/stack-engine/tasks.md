# Implementation Plan: stack-engine

## Overview

This plan extends the existing `packages/shared/src/engine` module (the thin-slice `executeHandler`, about 1,500 tests across the repo) into the full Stack Engine of `design.md`: nine executable Actions with Effect_Requests, seven Operations behind `applyOperation`, `buildRenderModel`, `remixStack`, `createStack`, and the Operation JSON Schemas for the tool registry. It follows the 7-step migration order of the design, so the existing tests stay green at the end of every step. No new dependency is needed (`ajv` is already a dev dependency of `@hypergeist/shared`). The implementation language is TypeScript (strict, erasable syntax only), as in the design.

Step map (design "Migration" table to top-level tasks): step 1 is task 1, step 2 is task 2, step 3 is task 4, step 4 is task 6, step 5 is task 7, step 6 is task 9, step 7 is task 11. Tasks 12 to 14 are final verification, the e2e user checkpoint, and the final checkpoint.

File layout notes for parallel work:

- Every module task leaves `engine/index.ts` and `smoke.test.ts` alone. One small "export" task per step (6.4, 7.7, 9.13) wires the module into the public API and updates the `smoke.test.ts` export pin. This keeps parallel tasks off the same files.
- Each property test gets its own file, so property tasks can run in parallel. The design's grouping of property files is a suggestion; the file names in this plan win.
- The internal types and the three-stage pipeline of `applyOperation` live in `operations/definition.ts`, so the per-operation files and `operations/index.ts` do not import each other in a cycle. This splits the "internal contract" of the design into its own file and changes no behavior.

## Executor safety rules

Read these before every task. They override anything else in this file.

1. **No network, no installs.** The agent shell has no network. Never run `pnpm install`, `pnpm add`, `pnpm update`, `npm install`, `pnpm approve-builds`, or any command that modifies `node_modules`. A failed install once emptied `node_modules`. No new dependency is needed for this spec. Never edit a dependency list or `pnpm-lock.yaml`.
2. **Scoped commands during the work.** Use `pnpm exec vitest run <paths>`, `pnpm --filter @hypergeist/shared typecheck`, `pnpm --filter @hypergeist/web typecheck`, and `pnpm exec eslint <paths>`. Run `pnpm exec prettier --write <touched files>` on the files the task touched only, because other tasks run in parallel. Run `pnpm format` only in the final verification task (12.2).
3. **No browser in the sandbox.** Chromium cannot run here. Writing e2e changes is a task. RUNNING `pnpm test:e2e` is a user checkpoint (task 13). `pnpm build` in the sandbox needs `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false` in the environment.
4. **Do not commit, push, or deploy.** The Developer commits.
5. **Code conventions.** Relative imports in `packages/shared/src` and `scripts/` use explicit `.ts` extensions. Only erasable TypeScript (no enums, no parameter properties, no namespaces). Vitest globals are off: import `describe`, `it`, `expect` from `vitest`, and call `cleanup` in `afterEach` in React tests. No `.tsx` file may contain the string `--ghost`. No `any`; use `unknown` and narrow it. The engine must not import DOM or Node APIs and must not use `Date`, `Math.random`, `crypto`, `process`, `fetch`, timers, or storage. `engine` imports only `../format/index.ts` (never a file inside `format/`), `zod`, and its own files.
6. **Property tests.** Each property test has the comment `Feature: stack-engine, Property N: <title>` and a `Validates` line, and runs through `assertProperty` from `packages/shared/test-support/seed.ts`. Never hand-write a property harness. The shared package's vitest config already has `testTimeout: 30_000`; do not lower `numRuns` below 100 to save time, shrink the generator instead.
7. **Existing tests.** The existing tests stay green. Change an expectation only in the files each task names. The files that legitimately change are: `smoke.test.ts` (export pins, in tasks 1.1, 6.4, 7.7, 9.13), `engine/execute-handler.test.ts` (the "Actions that are only validated" block, task 4.2), `format/type-lists.test.ts` (the "engine's executable subset" `NOT_EXECUTABLE` case, task 4.2; the design did not name this file, it was found by searching for the "not supported" text), and `apps/web/src/state/stack-store.test.ts` (the "validated but not executable" block, task 4.4). If any other existing test fails, stop and report it instead of editing it.
8. **Honest reporting.** If a task cannot be finished (a failing test that is not understood, a missing file), say so in the task result. Do not mark it done.

## Tasks

- [x] 1. Step 1: Format helper `checkAgainstSchema`
  - [x] 1.1 Create `packages/shared/src/format/schema-check.ts`, export it, and test it
    - Implement `checkAgainstSchema(schema, candidate, options?)`, `createValidationError(input)` and the `toJsonPointer` re-export exactly as in the design section "Format addition". `checkAgainstSchema` is `safeParse`, then the existing `mapZodIssues`, then `finalize` (same codes, sorting, and 100-error cap as `validateStack`), inside the same try/catch as `check.ts`, so a cyclic or throwing value returns the existing unreadable-value error and never throws
    - `rangePaths` post-pass: an error at a listed path whose code is `INVALID_VALUE` becomes `OUT_OF_RANGE`. A wrong JSON type stays `WRONG_TYPE`
    - `createValidationError` cuts `actual` to 200 code points and gives `null` for the absent value
    - Export `checkAgainstSchema`, `createValidationError`, `toJsonPointer`, and the types `SchemaCheck` and `SchemaCheckOptions` from `format/index.ts`
    - Update the format export list in `packages/shared/src/smoke.test.ts` (three new names; the engine list does not change in this task)
    - Unit tests in `schema-check.test.ts`: success returns the parsed value, a missing property gives `MISSING_PROPERTY` at the nearest existing ancestor, a wrong type gives `WRONG_TYPE`, an unknown key gives `UNKNOWN_PROPERTY`, `rangePaths` turns a non-integer and an out-of-range number into `OUT_OF_RANGE` but leaves a string as `WRONG_TYPE`, the 100-error cap sets `truncated`, a cyclic object does not throw, errors have the full `Validation_Error` shape
    - _Requirements: 1.10, 8.13, 8.14, 9.5, 9.6_

- [x] 2. Step 2: Engine foundations (no behavior change)
  - [x] 2.1 Widen `EffectRequest` in `packages/shared/src/engine/types.ts` and export the types
    - Replace `EffectRequest = never` with the union of `RunAiFieldEffect`, `FetchNewsEffect`, `TranscribeAudioEffect`, `ScheduleNotificationEffect` and add `EffectInput`, exactly as in the design section "Types". Discriminant is `kind`; every effect has `actionIndex`. Update the doc comment of `ExecutionResult` (the "always `[]` in the slice" note goes away). `ExecutionResult` keeps its fields, so `effects: readonly EffectRequest[]` still accepts `[]`
    - Export the new type names from `engine/index.ts` (types only, so the `smoke.test.ts` pin does not change)
    - Add `types.test.ts` with compile-time `satisfies` checks of one value per effect kind, and a runtime check that each sample survives `JSON.parse(JSON.stringify(x))` unchanged (effects are plain data)
    - Existing tests: `stack-edit.test.ts` ("ExecutionResult" block) must still pass unchanged
    - _Requirements: 5.10, 5.11_
  - [x] 2.2 Create `packages/shared/src/engine/ids.ts` and `ids.test.ts`
    - `collectEntityIds(stack)` returns a `Set<string>` of every Card, Object and Link id. `nextEntityId(used, kind)` returns `<kind>-<n>` for the smallest positive `n` not in `used`, for kinds `card`, `obj`, `link`. Uniqueness is checked across all kinds
    - Examples: empty set gives `card-1`; gaps (`obj-1`, `obj-3` used gives `obj-2`); `card-1` held by an Object forces `card-2`; ids such as `constructor` and `__proto__` in the set do not break it; the result always matches `ENTITY_ID_PATTERN`
    - _Requirements: 1.6, 1.11_
  - [x] 2.3 Create `packages/shared/src/engine/clone.ts` and `clone.test.ts`
    - `deepCopyJson(value)`: recursive copy of plain objects, arrays, strings, numbers, booleans and `null`. No `structuredClone` (not in the ES2022 lib of the shared tsconfig). Preserves key order. The copy shares no object or array with the input
    - Examples: nested copy is deeply equal and shares no reference, key order is kept, strings are returned as is, a frozen input gives an unfrozen copy
    - _Requirements: 1.3, 6.5, 6.7_
  - [x] 2.4 Add `findCard` and `withCard` to `packages/shared/src/engine/stack-edit.ts` (additive) and test them
    - `findCard(stack, cardId)` returns the Card or `undefined`. `withCard(stack, index, replacement)` returns a new Stack with only that Card replaced; the other Cards keep identity. Existing `findObject`, `withObject`, `textOf` do not change
    - Extend `stack-edit.test.ts` with new describe blocks only (do not edit existing cases): found and not found, other Cards keep identity, input not mutated (frozen input)
    - _Requirements: 1.3, 2.1, 3.1_
  - [x] 2.5 Create `packages/shared/src/engine/handler-prune.ts` and `handler-prune.test.ts`
    - `actionReferences(action)` returns the Entity_IDs an Action refers to (`cardId`, `targetObjectId`, `fromObjectId`, `atFromObjectId`). `pruneHandler(handler, isRemoved)` drops every Action that references an id for which `isRemoved` is true and returns `{ handler, removed }`. It returns the same array (same reference) and `removed: 0` when nothing is dropped
    - Examples for all nine Action types: each reference field alone, two references in one Action (counted once), order of the remaining Actions preserved, empty Handler, same-reference return when nothing matches
    - _Requirements: 2.4, 2.5, 3.8_
  - [x] 2.6 Create `packages/shared/src/engine/operation-result.ts` and `operation-result.test.ts`
    - Types `OperationSummary` (`created`, `updated`, `removed`, `removedActions`) and `OperationResult` exactly as in the design. Helpers: `emptySummary()`, `rejected(errors, truncated?)`, `unknownEntityError(path, id, kind, validIds)` (code `UNKNOWN_ENTITY`, hint lists up to 20 valid ids), `remapErrors(errors, mapPath)` (maps Stack pointers to parameter pointers via a per-operation `mapPath`; an unmappable pointer becomes `/stack` plus the Stack pointer)
    - Examples: a rejected result has no `stack` property, the hint cuts the id list at 20, `remapErrors` maps a mappable pointer, falls back to `/stack...` otherwise, and keeps code, message, expected, and actual
    - _Requirements: 1.1, 1.2, 1.8, 1.9, 1.10_
  - [x] 2.7 Create `packages/shared/test-support/freeze.ts` and `freeze.test.ts`
    - `deepFreeze(value)` (returns the same value, recursively frozen) and `deepCopy(value)` (plain recursive copy for before/after comparison). Existing tests keep their local copies
    - Examples: nested frozen, a write to a frozen object throws in strict mode, `deepCopy` is deeply equal and unfrozen
    - _Requirements: 1.3, 10.2_

- [ ] 3. Checkpoint - Ensure all tests pass
  - Run `pnpm --filter @hypergeist/shared test`, `pnpm --filter @hypergeist/shared typecheck`, `pnpm --filter @hypergeist/web typecheck`, and `pnpm exec vitest run apps/web scripts`. Only the `smoke.test.ts` format pin changed so far. Ensure all tests pass, ask the user if questions arise.

- [x] 4. Step 3: Executor runs all nine Actions, and the web store reports effects
  - [x] 4.1 Create `packages/shared/src/engine/effects.ts` and `effects.test.ts`
    - `effectFor(stack, action, index)` returns one `EffectRequest` for `run_ai_field`, `fetch_news`, `transcribe_audio`, `schedule_notification`, and `undefined` for every other Action type. Pure; never changes the Stack
    - `run_ai_field`: the target's `prompt` and one `{ objectId, name, text }` per `inputObjectIds` entry, in order, with the text from `textOf` (List items joined by newlines, other Objects' `value`). `fetch_news`: `topics` copied. `transcribe_audio`: target id only. `schedule_notification`: `message`, `at` (the literal, or the text of the `atFromObjectId` Field, with `atFromObjectId` set only in that case). Every effect carries `actionIndex`
    - Examples: two inputs in order, empty `inputObjectIds`, an input that is a List, `at` literal, `at` from a Field, `undefined` for the five other Action types, effects are JSON-safe
    - _Requirements: 5.10, 5.11_
  - [x] 4.2 Update `packages/shared/src/engine/execute-handler.ts` to run all nine Actions
    - Add `remove_item` as an edit Action: an `index` below the item count removes that item and keeps the order of the rest; any other index leaves the List unchanged and adds no message. Add the four effect Actions: each appends `effectFor(...)` to `effects` and leaves the Stack unchanged. `go_to_card` still stops the Handler, and effects and messages produced before it are kept. Replace the old "this action type is not supported" branch with an exhaustive `switch` whose default has type `never`, so a tenth Action type fails to compile
    - Keep byte for byte: the invalid Stack message, the invalid Handler message, the `Skipped action N (type): reason.` prefix, the "list is full" message, and the behavior of the four old Actions (including `set_value` onto an ai-field). Keep the defensive skip branch (result would not validate)
    - Update the doc comments in `execute-handler.ts` and the `HandlerMode` doc in `packages/shared/test-support/arbitraries.ts` ("only validated" is no longer true). The `'executable'` mode keeps its name and meaning (four state-only Action types, so effects stay `[]`)
    - Existing tests that change: in `execute-handler.test.ts`, replace the `describe('executeHandler: Actions that are only validated')` block (the five "not supported" cases and the position test) with tests of the new behavior (`remove_item` in range removes, out of range is unchanged with no message, each effect Action leaves the Stack unchanged and emits one effect, skipped positions still reported for a skip caused by a limit). In `format/type-lists.test.ts`, replace the `NOT_EXECUTABLE` "skips the %s Action with a 'not supported' message" case with a case asserting that all nine types run and that no message contains "not supported". Do not touch `apps/web` in this task: `stack-store.test.ts` is expected to fail until task 4.4 and that is part of the same step
    - Add a test that documents that the "unknown id" and "wrong type" skip reasons of Requirement 5.17 are unreachable after `validateHandler` (a Handler naming a missing id gives the invalid-Handler message and runs nothing)
    - _Requirements: 5.1, 5.6, 5.7, 5.9, 5.10, 5.12, 5.13, 5.14, 5.15, 5.16, 5.17_
  - [x] 4.3 Write example tests for the five newly executable Actions in `packages/shared/src/engine/execute-new-actions.test.ts`
    - One or more examples per Action type that run a Handler and assert the resulting Stack, `messages`, `navigateTo`, and `effects`: `remove_item` (first, middle, last, index equal to length, empty List), `run_ai_field` (two inputs in order, empty inputs), `fetch_news`, `transcribe_audio`, `schedule_notification` (literal `at`, `at` from a Field)
    - Mixed Handlers: effects and messages in execution order; `go_to_card` after an effect keeps that effect and drops later Actions; a Handler of zero Actions returns an equal Stack, `[]`, `[]`, and no `navigateTo`; input frozen with `deepFreeze` and not modified
    - _Requirements: 5.1, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 11.10_
  - [x] 4.4 Make the web store report effects and update its test
    - In `apps/web/src/state/stack-store.ts`, after the executor messages, append one status message per effect, in effect order: `Skipped action N (kind): <label> arrives in a later release.` where N is `actionIndex + 1` and the label is `AI fields` (`run_ai_field`), `News` (`fetch_news`), `Voice transcription` (`transcribe_audio`), `Reminders` (`schedule_notification`). A button with an effect Action must never do nothing silently. Messages are combined into the status text the same way as today
    - In `apps/web/src/state/stack-store.test.ts`, replace the `describe('Actions that are validated but not executable in this release')` block: `remove_item` now removes the item (or does nothing when out of range) and shows no skip message; the "Done." example is updated; add tests that a `run_ai_field`, `fetch_news`, `transcribe_audio`, and `schedule_notification` Button each show the new message, with `effects` of the spied `executeHandler` result asserted (kind and `actionIndex`)
    - Run `pnpm exec vitest run apps/web` and `pnpm --filter @hypergeist/web typecheck`; both must pass at the end of this task
    - _Requirements: 5.10, 5.14_
  - [x] 4.5 Write property test for executor result validity over all nine Actions in `packages/shared/src/engine/execute-all-actions.property.test.ts`
    - **Property 16: Executor results stay valid for all nine Actions**
    - Inputs: `arbStack` with `arbHandlerFor(stack, 'all')`. Assert the result Stack passes `validateStack`, `navigateTo` (when present) is the id of a Card, every message is a string, and a skipped Action leaves the Stack as before that Action and adds exactly one message that starts with `Skipped action`
    - **Validates: Requirements 5.12, 5.17, 11.8**
  - [ ]* 4.6 Write property test for effect order in `packages/shared/src/engine/execute-effects.property.test.ts`
    - **Property 17: Effect Actions emit Effect_Requests in order and leave the Stack unchanged**
    - Inputs: `arbStack` with Handlers made of effect Actions, `show_message`, and at most one `go_to_card` (build from `arbHandlerFor(stack, 'all')` filtered or mapped). Assert Stack equal to the input, one effect per effect Action before the first `go_to_card`, in order, same kind, resolved source text, `actionIndex` equal to its position, and none after `go_to_card`
    - **Validates: Requirements 5.9, 5.10, 5.11, 5.13**
  - [ ]* 4.7 Write property test for `remove_item` in `packages/shared/src/engine/execute-remove-item.property.test.ts`
    - **Property 18: remove_item removes exactly the item at the index**
    - Inputs: `arbStack`, a List in it, and an integer `index` of 0 or more (below, at, and above the item count). Assert exact removal with order kept below the count, and an unchanged List with no message otherwise
    - **Validates: Requirements 5.6, 5.7**

- [ ] 5. Checkpoint - Ensure all tests pass
  - Run `pnpm --filter @hypergeist/shared test`, both typechecks, and `pnpm exec vitest run apps/web scripts`. Steps 1 to 3 are now complete, including the web store change. Ensure all tests pass, ask the user if questions arise.

- [x] 6. Step 4: Render model
  - [x] 6.1 Create `packages/shared/src/engine/render-model.ts` and `render-model.test.ts`
    - `buildRenderModel(stack, cardId)` returns `{ ok: true, model }` or `{ ok: false, errors }` and types `RenderModel`, `RenderObject`, `RenderAiField`, `RenderInput`, `RenderLink`, `RenderModelResult`, exactly as in the design. The model has `cardWidth`, `cardHeight`, the Card `id` and `name`, all Objects in array order with every property and unchanged position and size, ai-fields with `inputs` (`{ id, name }` in `inputObjectIds` order), and Links in order with `targetCardName`. Built with `deepCopyJson`, so it shares nothing with the Stack. A `cardId` that is not a Card (including an Object or Link id) gives `UNKNOWN_ENTITY` at `/cardId`. On an invalid Stack it never throws (unresolved names become `""`)
    - Examples: Card with 0 Objects and 0 Links (empty arrays), a Card with 100 Objects and 50 Links, an ai-field with two inputs and with none, a Link to its own Card, Object beyond the card bounds is not clipped, JSON round trip equals the model, changing a deep copy of the model leaves the Stack equal
    - Example test for Requirement 11.11: `UNKNOWN_ENTITY` and `path` `/cardId` for an unknown id and for an Object id
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 11.11_
  - [x] 6.2 Write property test for the render model in `packages/shared/src/engine/render-model.property.test.ts`
    - **Property 19: The Render_Model is total and faithful**
    - Inputs: `arbStack`, every Card of the Stack. Assert no error and no throw; sizes, `id`, `name`, Objects (every property, position, size, order), Links (`targetCardName` equals the target's name), and ai-field `inputs` as in the design
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.6, 11.5**
  - [ ]* 6.3 Write property test for render model JSON safety in `packages/shared/src/engine/render-model-json.property.test.ts`
    - **Property 20: The Render_Model is JSON-safe and detached**
    - Inputs: `arbStack`, a Card. Assert JSON round trip equals the model, no function or `undefined` or circular reference, no object or array shared with the Stack (identity check over the whole model), and mutating a deep copy leaves the Stack deeply equal to its earlier state
    - **Validates: Requirements 6.5, 6.7**
  - [x] 6.4 Export `buildRenderModel` and its types from `packages/shared/src/engine/index.ts`
    - Update the engine export list in `packages/shared/src/smoke.test.ts` (add `buildRenderModel`). The web app is not changed in this spec
    - _Requirements: 6.1_

- [x] 7. Step 5: Remix and stack creation
  - [x] 7.1 Create `packages/shared/src/engine/remix.ts` and `remix.test.ts`
    - `remixStack(stack: unknown, newId: unknown)` returns `RemixResult`. Check `newId` first (not a string, or fails `ENTITY_ID_PATTERN`: `INVALID_VALUE` at `/newId`, no Stack). Then `validateStack(stack)`; if invalid return its errors unchanged and no Stack. Otherwise a new Stack in canonical key order with `id: newId`, `remixedFrom: stack.id`, and every other field unchanged (an existing `remixedFrom` is replaced)
    - Examples: normal remix, remix of a remix, same id as the old one, Card/Object/Link ids unchanged, bad pattern, non-string id, invalid Stack returns exactly the `validateStack` errors, both bad gives only the `newId` error, input frozen and unmodified
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [ ]* 7.2 Write property test for remix in `packages/shared/src/engine/remix.property.test.ts`
    - **Property 21: Remix changes only the identity**
    - Inputs: `arbStack` (including one with `remixedFrom`), `fc` strings matching and not matching the pattern, and `arbCandidate`/`arbMutation` for invalid Stacks. Assert as in the design property
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**
  - [x] 7.3 Create `packages/shared/src/engine/create-stack.ts` and `create-stack.test.ts`
    - `createStack(params: unknown)` returns `CreateStackResult`. Build a strict Zod schema from the format's property schemas (`StackSchema.shape.id`, `.name`, `.cardWidth`, `.cardHeight`, `CardSchema.shape.id`, `.name`), check with `checkAgainstSchema` and `rangePaths: ['/cardWidth', '/cardHeight']`. Unknown parameters give `UNKNOWN_PROPERTY` (approved). Rebuild the candidate in the order `id, name, cardWidth, cardHeight, firstCardId, firstCardName` so errors come out in that order, with missing `id` and `name` at `""`. Result: `formatVersion` 1, defaults 512, 342, `card-1`, `Card 1`, one Card with empty `objects`, `links`, `onOpen`, `startCardId` equal to that Card's id, no `remixedFrom`. Pass the result through `validateStack` as a safety net
    - Example tests for Requirement 11.15 (each asserts `ok: false`, no Stack, code, and path): omitted `id` and omitted `name` (`MISSING_PROPERTY`, path `""`), bad `id` pattern, empty `name`, `name` of 101 code points, `cardWidth` 63 and 4097, `cardHeight` 63 and 4097, a non-integer size (`OUT_OF_RANGE`), a string size (`WRONG_TYPE`), an unknown parameter. Example for Requirement 11.16: only `id` and `name` gives 512 by 342, `card-1`, `Card 1`. Also: sizes 64 and 4096 accepted, names of 1 and 100 code points (ASCII and astral) accepted, several broken parameters give one error each in the fixed order, results deeply equal for equal calls
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13, 8.14, 8.15, 11.15, 11.16_
  - [x] 7.4 Create `packages/shared/test-support/factory-arbitraries.ts` and `factory-arbitraries.test.ts`
    - `arbCreateStackParams`: valid parameter sets with the minimum, maximum and in-between values of `cardWidth` and `cardHeight`, the minimum and maximum length of `name` and `firstCardName` (code points), and each optional parameter present and omitted. `arbCorruptedCreateStackParams`: a valid set with a random subset of parameters broken, together with the expected ordered list of `{ code, path }` for Property 23
    - Coverage test with a fixed seed over a sample of 200 sets: contains 64, 4096, an in-between size for both sizes, name lengths 1 and 100, and each optional parameter both present and omitted
    - _Requirements: 11.13_
  - [x] 7.5 Write property test for stack creation in `packages/shared/src/engine/create-stack.property.test.ts`
    - **Property 22: createStack makes a valid one-Card Stack**
    - Inputs: `arbCreateStackParams`. Assert `validateStack` passes, `formatVersion` 1, exactly one Card with empty `objects`, `links`, `onOpen`, `startCardId` equal to its id, no `remixedFrom`, supplied values used, and the defaults for omitted ones
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 11.14**
  - [ ]* 7.6 Write property test for stack creation errors in `packages/shared/src/engine/create-stack-errors.property.test.ts`
    - **Property 23: createStack reports each invalid parameter once, in order**
    - Inputs: `arbCorruptedCreateStackParams`. Assert `ok: false`, no Stack, exactly one error per broken parameter with the expected code, in the order `id, name, cardWidth, cardHeight, firstCardId, firstCardName`
    - **Validates: Requirements 8.9, 8.10, 8.11, 8.12, 8.13, 8.14**
  - [x] 7.7 Export `remixStack`, `createStack` and their types from `packages/shared/src/engine/index.ts`
    - Update the engine export list in `packages/shared/src/smoke.test.ts` (add `createStack`, `remixStack`)
    - _Requirements: 7.1, 8.1, 10.1_

- [ ] 8. Checkpoint - Ensure all tests pass
  - Run `pnpm --filter @hypergeist/shared test`, both typechecks, and `pnpm exec vitest run apps/web scripts`. Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Step 6: Operations
  - [x] 9.1 Create `packages/shared/src/engine/operations/object-defaults.ts` and `object-defaults.test.ts`
    - `OBJECT_DEFAULTS` table of the design (all types `name: ""`; button `onClick: []`; field `value: ""`, `placeholder: ""`, `multiline: false`, `readOnly: false`; image `alt: ""`; list `items: []`, `ordered: false`; ai-field `value: ""`, `inputObjectIds: []`)
    - Consistency test: for each Object type, derive the full property list from the Zod `.shape` and assert `defaults ∪ required = all properties`, where required is `id`, `type`, `x`, `y`, `width`, `height` plus `label` (button), `src` (image), `prompt` (ai-field). A property added to the format later must fail this test
    - _Requirements: 1.7_
  - [x] 9.2 Create `packages/shared/src/engine/operations/definition.ts` and `definition.test.ts`
    - Internal types `RunOutcome` and `OperationDefinition<P>` of the design, and `runDefinition(definition, stack, params)`: stage A `checkAgainstSchema(def.schema, params, { rangePaths })`, stage B `def.run`, stage C `validateStack(candidate)` with errors remapped through `mapPath`. `checkAgainstSchema` and `validateStack` never throw. Do not wrap `run` in a try/catch that hides bugs: an exception from `run` is a programmer error and must surface, and the "never throws for any parameters" guarantee is covered by Property 15 (task 9.19)
    - Tests with a fake definition: schema error stops before `run` (run not called), precondition errors stop before stage C, a candidate that fails `validateStack` is rejected with remapped errors and no `stack`, an unmappable pointer becomes `/stack...`, a good candidate returns `ok: true` with the candidate and summary, the input Stack is not modified
    - _Requirements: 1.1, 1.2, 9.3, 9.6_
  - [x] 9.3 Create `packages/shared/src/engine/operations/params.ts` (part 1: five schemas) and `params.test.ts`
    - Zod 4 strict-object parameter schemas with `.meta({ description })` for `create_card` (`name`, `id?`, `index?`), `delete_card` (`cardId`), `remove_object` (`objectId`), `link_cards` (`fromCardId`, `toCardId`, `label`, `id?`), `set_action` (`ownerId`, `handler`). Reuse the format's property schemas (`CardSchema.shape.name`, `LinkSchema.shape.label`, `HandlerSchema`, Entity_ID schema), so bounds and `maxLength` metadata have one definition. No `.default()`, `.transform()`, `.refine()`, `.pipe()`. Each top-level `description` is at most 1,000 characters, each parameter `description` is non-empty and at most 500 characters and states meaning, type and constraints, written for an AI reader. Export `z.infer` param types
    - Examples: parse accepts a minimal and a full parameter object per schema, rejects an unknown key, a wrong type, a missing required key, an empty `name`, a 101-character `name` and `label`, a non-integer or negative `index`
    - _Requirements: 9.1, 9.2, 2.11, 4.10_
  - [x] 9.4 Add the `add_object` and `update_object` schemas to `packages/shared/src/engine/operations/params.ts` and extend `params.test.ts`
    - `add_object`: one flat strict object with `cardId`, `type` (`z.enum(OBJECT_TYPES)`), `x`, `y`, `width`, `height` required, and `id`, `index`, `name` and every type-specific property (`label`, `onClick`, `value`, `placeholder`, `multiline`, `readOnly`, `items`, `ordered`, `src`, `alt`, `prompt`, `inputObjectIds`) optional, using the format's property schemas. The description of each parameter names which Object types need or accept it. `update_object`: `objectId` and `changes`, where `changes` is a strict object whose keys are the union of every mutable property of every Object type (no `id`, no `type`), all optional, and may be empty
    - Extend the tests: flat schema accepts each type's minimal parameters, rejects unknown keys, `changes` accepts `{}` and rejects `id` and `type` keys (as unknown keys at the schema level; the `INVALID_VALUE` code comes from the pre-pass in task 9.8)
    - _Requirements: 9.1, 9.2, 3.1, 3.4_
  - [x] 9.5 Implement `create_card` in `packages/shared/src/engine/operations/create-card.ts` and `create-card.test.ts`
    - Definition per the design (`rangePaths: ['/index']`): `id` already used gives `DUPLICATE_ID` at `/id`; 200 Cards gives `LIMIT_EXCEEDED` at `""`; `index` above the Card count gives `OUT_OF_RANGE` at `/index`; insert a Card with `objects: []`, `links: []`, `onOpen: []` at `index` or at the end; `startCardId` unchanged; summary `created: [cardId]`; id from `nextEntityId` when absent
    - Examples through `runDefinition`: accepted at start, middle, end, default end; rejected: missing `name` (`MISSING_PROPERTY`, path `""`), empty `name` (`INVALID_VALUE`), 101 characters (`LIMIT_EXCEEDED`), bad id pattern (`INVALID_VALUE`), duplicate id, `index` -1, 1.5 and too large (`OUT_OF_RANGE` at `/index`), `index` as a string (`WRONG_TYPE`), a Stack with 200 Cards. This is the `OUT_OF_RANGE` example for `create_card` required by Requirement 11.12
    - _Requirements: 1.6, 1.11, 2.1, 2.2, 2.9, 2.10, 2.11, 11.9, 11.12_
  - [x] 9.6 Implement `delete_card` in `packages/shared/src/engine/operations/delete-card.ts` and `delete-card.test.ts`
    - Definition per the design: not a Card gives `UNKNOWN_ENTITY` at `/cardId` (including an Object or Link id); the only Card gives `LIMIT_EXCEEDED` at `/cardId`. Cascade on a new Stack: remove the Card; in remaining Cards drop Links targeting it, prune Handlers (`onClick`, `onOpen`) with `pruneHandler` for the deleted Card id and the deleted Objects' ids, filter `inputObjectIds`; reset `startCardId` to `cards[0].id` when the start Card was deleted. Summary `removed` ordered as the deleted Card, its Objects, its Links, then removed Links of remaining Cards in document order; `removedActions` counts pruned Actions; `updated` lists owners whose Handler or `inputObjectIds` lost entries
    - Examples: delete a plain Card; delete the start Card; delete a Card that other Cards link to (Links removed, ids in `removed` in the required order); Actions with `cardId`, with `targetObjectId`, `fromObjectId` and `atFromObjectId` of a deleted Object are removed and counted; owners listed in `updated`; the `inputObjectIds` filter is a no-op on valid Stacks (pin this); unknown id, Object id as `cardId`, single-Card Stack
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 1.9, 11.9_
  - [x] 9.7 Implement `add_object` in `packages/shared/src/engine/operations/add-object.ts` and `add-object.test.ts`
    - Definition per the design (`rangePaths: ['/index']`): `cardId` not a Card gives `UNKNOWN_ENTITY` at `/cardId`; 100 Objects gives `LIMIT_EXCEEDED` at `/cardId`; `index` above the Object count gives `OUT_OF_RANGE` at `/index`; supplied `id` in use gives `DUPLICATE_ID` at `/id`; assign `obj-<n>`; build the candidate from `OBJECT_DEFAULTS` plus the supplied properties (not `cardId`, `index`); validate it with `ObjectSchema` through `checkAgainstSchema` (gives `MISSING_PROPERTY` for `label`, `src`, `prompt`, `UNKNOWN_PROPERTY` for a property of another type, `INVALID_VALUE` for a bad value); insert the parsed Object. Provide `mapPath` so stage C errors (`OUT_OF_BOUNDS`, ai-field inputs on another Card, Handler references) map to `/<prop>` or `""`
    - Examples: one accepted add per Object type with defaults stored for every omitted optional property (Requirement 1.7), at an index, at the end; rejected: unknown `type` (`INVALID_VALUE`), missing `label` for a Button, missing `src` for an Image, missing `prompt` for an ai-field, `label` on a Field (`UNKNOWN_PROPERTY`), out of card bounds, `inputObjectIds` naming an Object of another Card, `index` out of range (`OUT_OF_RANGE` at `/index`, the `add_object` example required by Requirement 11.12), `index` as a string (`WRONG_TYPE`), 100 Objects, unknown Card, duplicate id
    - _Requirements: 1.6, 1.7, 1.11, 3.1, 3.2, 3.3, 3.10, 3.11, 3.12, 11.9, 11.12_
  - [x] 9.8 Implement `update_object` in `packages/shared/src/engine/operations/update-object.ts` and `update-object.test.ts`
    - Definition per the design. Pre-pass on the raw parameters, before the strict schema: an own `id` or `type` key in `changes` gives `INVALID_VALUE` at `/changes/id` or `/changes/type`. Then `objectId` not an Object gives `UNKNOWN_ENTITY` at `/objectId`; a key the Object's type does not define (from the type's Zod `.shape`) gives `UNKNOWN_PROPERTY` at `/changes/<key>`; validate the merged Object with `ObjectSchema` and prefix its error paths with `/changes`. Empty `changes` returns the input Stack and a summary of empty arrays. Summary `updated: [objectId]`. `mapPath` maps Object pointers to `/changes/...`
    - Examples: change `label` of a Button, `value` of a Field, `items` of a List, `inputObjectIds` of an ai-field; only the named properties change; empty `changes` returns the same Stack; `id` and `type` rejected with `INVALID_VALUE`; `label` on a List rejected with `UNKNOWN_PROPERTY`; invalid value (`width: 0`); an update that pushes the Object out of the card is rejected by stage C and the Stack is unchanged; unknown Object; a Card id as `objectId` gives `UNKNOWN_ENTITY`
    - _Requirements: 3.4, 3.5, 3.6, 3.7, 3.10, 3.12, 3.13, 11.9_
  - [x] 9.9 Implement `remove_object` in `packages/shared/src/engine/operations/remove-object.ts` and `remove-object.test.ts`
    - Definition per the design: not an Object gives `UNKNOWN_ENTITY` at `/objectId`; remove the Object, prune every Button `onClick` and every `onOpen` of Actions whose `targetObjectId`, `fromObjectId` or `atFromObjectId` equals the id, remove the id from every ai-field `inputObjectIds`. Summary `removed: [objectId]`, `removedActions`, `updated` for owners that lost entries
    - Examples: remove a plain Object; remove a Field that a Button's Actions reference (Actions removed and counted, Button in `updated`); remove an Object listed in an ai-field's `inputObjectIds` (entry removed, ai-field in `updated`); remove a Button; a Card id as `objectId` gives `UNKNOWN_ENTITY`; unknown id; the result of an existing Object is always `ok: true`
    - _Requirements: 3.8, 3.9, 3.10, 3.13, 11.9_
  - [x] 9.10 Implement `link_cards` in `packages/shared/src/engine/operations/link-cards.ts` and `link-cards.test.ts`
    - Definition per the design: `fromCardId` or `toCardId` not a Card gives `UNKNOWN_ENTITY` at that parameter; an existing Link from the source Card to `toCardId` gives `DUPLICATE_LINK` at `/toCardId`; 50 Links gives `LIMIT_EXCEEDED` at `/fromCardId`; supplied `id` in use gives `DUPLICATE_ID` at `/id`; collect all precondition errors; a self-link is allowed. Append the Link last, id `link-<n>` when absent. Summary `created: [linkId]`. `mapPath` maps `label` and `targetCardId` as in the design table
    - Examples: accepted, self-link, explicit `id`; rejected: unknown from, unknown to (both reported together), duplicate Link, 50 Links, empty `label` (`INVALID_VALUE`), 101-character `label` (`LIMIT_EXCEEDED`), duplicate `id`, an Object id as `toCardId`
    - _Requirements: 4.1, 4.2, 4.3, 4.9, 4.10, 4.11, 1.6, 11.9_
  - [x] 9.11 Implement `set_action` in `packages/shared/src/engine/operations/set-action.ts` and `set-action.test.ts`
    - Definition per the design: `ownerId` not an entity gives `UNKNOWN_ENTITY` at `/ownerId`; an existing entity that is neither a Button nor a Card gives `WRONG_REFERENCE_TYPE` at `/ownerId`; `validateHandler(stack, handler)` errors get the prefix `/handler`; on any error the owner's Handler is untouched. Replace the whole `onClick` (Button) or `onOpen` (Card). Summary `updated: [ownerId]`. `mapPath` maps owner pointers to `/handler/...`
    - Examples: set a Button's `onClick`; set a Card's `onOpen`; replace (not merge) a non-empty Handler; empty Handler; applying twice gives equal Stacks; rejected: owner is a Field and a Link (`WRONG_REFERENCE_TYPE`), unknown owner, Action naming a missing Object (path under `/handler/0/...`), an Action violating exactly-one-of, a Handler of 21 Actions, an unknown Action type (stage A, `/handler/0/type`)
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 4.8, 11.9_
  - [x] 9.12 Create `packages/shared/src/engine/operations/index.ts` (registry, `applyOperation`, `OPERATIONS`, `operationJsonSchema`) and its tests
    - `OPERATION_NAMES` (the seven names, in the design's order), `OperationParams`, `applyOperation(stack, name, params)` (own-property lookup so `constructor` and `__proto__` are not Operations; unknown name gives `INVALID_VALUE` at `/operation`; then `runDefinition`), `OPERATIONS` (exactly seven `{ name, description, schema }` entries), `operationJsonSchema(name)` (`z.toJSONSchema(schema)` with defaults, fresh object each call). Types `OperationName`, `OperationInfo`, `OperationJsonSchema`
    - Tests in `operations/index.test.ts` (use `createSchemaValidator` from `test-support/schema-validator.ts`): seven unique names and no other; each document validates under the 2020-12 meta-schema; each root is `type: "object"` with `additionalProperties: false`; each top-level description is non-empty and at most 1,000 characters; every parameter description is non-empty and at most 500; every `maxLength` and `maxItems` in an output equals the matching `LIMITS` row (guards the Zod metadata-merge assumption); `OPERATIONS[i].description` equals the document's description; unknown names (`'nope'`, `''`, `'constructor'`, `'__proto__'`) give `INVALID_VALUE` at `/operation` and no Stack; parameters that are not an object (`null`, array, string) give `WRONG_TYPE` at `""`; a cyclic parameter object does not throw; `applyOperation` works for each of the seven names
    - _Requirements: 1.12, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_
  - [x] 9.13 Export the Operations from `packages/shared/src/engine/index.ts`
    - Export `applyOperation`, `OPERATION_NAMES`, `OPERATIONS`, `operationJsonSchema` and the types `OperationName`, `OperationParams`, `OperationResult`, `OperationSummary`, `OperationInfo`, `OperationJsonSchema`. Do not export `findObject`, `withObject`, `textOf`, `ids.ts`, `handler-prune.ts`, `clone.ts`, or the per-operation modules
    - Update the engine export list in `packages/shared/src/smoke.test.ts` (final list: `OPERATIONS`, `OPERATION_NAMES`, `applyOperation`, `buildRenderModel`, `createStack`, `executeHandler`, `operationJsonSchema`, `remixStack`)
    - _Requirements: 9.1, 9.4, 10.1_
  - [x] 9.14 Create `packages/shared/test-support/operation-arbitraries.ts` and `operation-arbitraries.test.ts`
    - `arbOperationTemplate`, `resolveOperation(stack, template)` returning `{ name, params, expectedCode? }`, and `arbOperationSequence` (0 to 50 templates). A template holds choices as fractions in `[0, 1)` plus a `fault` tag (`none`, `unknown-entity`, `duplicate-id`, `bad-id-pattern`, `index-out-of-range`, `missing-required`, `wrong-type`, `unknown-property`, `over-limit`, `wrong-reference-kind`, `bad-handler`). `resolveOperation` builds the parameters against the current Stack, so ids stay real after earlier steps changed it
    - Coverage test with a fixed seed over 200 sequences: every Operation name occurs, both accepted and rejected results occur, a sequence of length 0 and one of length 50 occur
    - _Requirements: 11.2_
  - [ ] 9.15 Write property test for operation closure in `packages/shared/src/engine/operations/closure.property.test.ts`
    - **Property 1: Operations keep the Stack valid**
    - Inputs: `arbStack` and `arbOperationSequence`. After every step, accepted or rejected, the held Stack passes `validateStack`; an accepted step has `ok: true` and a valid Stack
    - **Validates: Requirements 1.1, 11.6**
  - [ ] 9.16 Write property test for rejected operations in `packages/shared/src/engine/operations/rejected-unchanged.property.test.ts`
    - **Property 2: A rejected Operation changes nothing**
    - Inputs: `arbStack` and operation templates that resolve to rejected calls (and mutated parameters). Assert `ok: false`, at least one error, no `stack` property, error codes in the closed set, non-empty `message`, `expected` and `hint`, `actual` of `null` or at most 200 code points, `path` of `""` or starting with `/` and not with `/stack`, and the deeply frozen input equal to a copy taken before the call
    - **Validates: Requirements 1.2, 1.3, 1.10, 3.13, 4.7, 9.6, 11.7**
  - [ ] 9.17 Write property test for engine purity in `packages/shared/src/engine/purity.engine.property.test.ts`
    - **Property 3: Engine functions are pure and deterministic**
    - Inputs: `arbStack`, `arbHandlerFor(stack, 'all')`, operation templates, Card ids, new Stack ids, and `arbCreateStackParams`. Call `applyOperation`, `executeHandler`, `buildRenderModel`, `remixStack`, `createStack` twice on deeply frozen inputs; results deeply equal and no input modified
    - **Validates: Requirements 1.3, 1.4, 5.15, 6.7, 8.15, 10.2**
  - [x] 9.18 Write property test for `set_action` idempotence in `packages/shared/src/engine/operations/set-action.property.test.ts`
    - **Property 13: set_action replaces one Handler and is idempotent**
    - Inputs: `arbStack`, a Button or Card, and `arbHandlerFor(stack, 'all')`. Assert the whole Handler is replaced and nothing else changes, and a second identical call is accepted and returns a Stack deeply equal to the first result
    - **Validates: Requirements 4.4, 4.5, 4.8**
  - [x] 9.19 Write property test for schema and tool-schema consistency in `packages/shared/src/engine/operations/schema-consistency.property.test.ts`
    - **Property 15: Schema violations are rejected and conforming parameters never throw**
    - Inputs: `arbStack`, operation names, parameters (valid and mutated). With `createSchemaValidator` (ajv): if `operationJsonSchema(name)` reports a violation, `applyOperation` returns `ok: false` with at least one error and the Stack unchanged. For any parameters, `applyOperation` returns `ok: true` or at least one error and never throws. For `add_object` an omitted required property gives `MISSING_PROPERTY` and an invalid value gives `INVALID_VALUE`
    - **Validates: Requirements 3.12, 9.3, 9.5, 9.6**
  - [x] 9.20 Write the purity source-scan test in `packages/shared/src/engine/purity.scan.test.ts`
    - Read every non-test file under `packages/shared/src/engine/` and fail on `node:` imports and on the names `Date`, `Math.random`, `crypto`, `process`, `fetch`, `setTimeout`, `setInterval`, `localStorage`, `indexedDB`, `document`, `window` (use word-boundary matching so identifiers such as `updated` do not trip it; skip comments). Also assert that no engine file imports a path inside `format/` other than `../format/index.ts`, and that no file in `engine/` imports from `apps/`
    - _Requirements: 1.5, 5.14, 10.1, 10.2_
  - [x] 9.21 Write consolidated example tests through `applyOperation` in `packages/shared/src/engine/operations/examples.test.ts`
    - One accepted and one rejected example per Operation by name, through the public `applyOperation` (Requirement 11.9). Example that asserts the code `UNKNOWN_ENTITY` and the `path` of a rejected Operation (for example `delete_card` with a missing id, path `/cardId`; and `remove_object` given a Card id) (Requirement 11.11). `OUT_OF_RANGE` and `path` for `create_card` and `add_object` (Requirement 11.12). Unknown Operation name (`INVALID_VALUE` at `/operation`). Container limits with Stacks built in the test: 200 Cards, one Card, 100 Objects, 50 Links. Text boundaries at 1, 100, and 101 code points (ASCII and astral) for `create_card.name` and `link_cards.label`. Created ids pick the smallest unused number (including `card-1` held by an Object). Summary lists each id at most once and arrays are empty when nothing of that kind happened. The `UNKNOWN_ENTITY` and `OUT_OF_RANGE` codes are produced only by the engine (assert `validateStack` never returns them)
    - _Requirements: 1.6, 1.8, 1.9, 1.12, 2.2, 2.7, 3.3, 4.3, 9.7, 11.9, 11.11, 11.12_
  - [ ]* 9.22 Write property test for id assignment in `packages/shared/src/engine/operations/ids.property.test.ts`
    - **Property 4: Created ids are the smallest unused, and supplied duplicates are rejected**
    - Inputs: `arbStack`; `create_card`, `add_object`, `link_cards` without `id` (compare with an independently written smallest-unused-id model) and with an `id` equal to an existing Entity_ID (`DUPLICATE_ID` at `/id`, existing entity unchanged)
    - **Validates: Requirements 1.6, 1.11, 2.10, 4.11**
  - [ ]* 9.23 Write property test for the summary in `packages/shared/src/engine/operations/summary.property.test.ts`
    - **Property 5: The summary equals the difference of the two Stacks**
    - Inputs: `arbStack` and accepted operations. Compare `created`, `removed`, `updated` with an id-set difference of input and result; each id at most once; `delete_card` `removed` ordering as required
    - **Validates: Requirements 1.8, 2.8, 3.7, 3.9**
  - [ ]* 9.24 Write property test for `create_card` in `packages/shared/src/engine/operations/create-card.property.test.ts`
    - **Property 6: create_card inserts an empty Card at the index**
    - Inputs: `arbStack`, integer `index` from 0 through the Card count, and out-of-range indexes (negative, non-integer, too large). Assert insertion and shifting, `startCardId` unchanged, `OUT_OF_RANGE` at `/index`, and `LIMIT_EXCEEDED` for a 200-Card Stack
    - **Validates: Requirements 2.1, 2.2, 2.9**
  - [ ]* 9.25 Write property test for `delete_card` in `packages/shared/src/engine/operations/delete-card.property.test.ts`
    - **Property 7: delete_card removes the Card and everything that referred to it**
    - Inputs: `arbStack` with at least two Cards and any Card. Compare with an independently written filter-based model (Card, Links targeting it, Actions referencing it or its Objects, `inputObjectIds`, `startCardId` rule, `removedActions` count); every other Card otherwise unchanged
    - **Validates: Requirements 2.3, 2.4, 2.5, 2.6, 2.8**
  - [ ]* 9.26 Write property test for `add_object` in `packages/shared/src/engine/operations/add-object.property.test.ts`
    - **Property 8: add_object applies defaults and inserts at the index**
    - Inputs: `arbStack`, a Card with fewer than 100 Objects, an Object type with valid required properties that fit the Card, and `index` in range or out of range. Assert the stored Object equals the supplied properties plus the `OBJECT_DEFAULTS` row, position, and `OUT_OF_RANGE` at `/index`
    - **Validates: Requirements 1.7, 3.1, 3.11**
  - [ ]* 9.27 Write property test for add then remove in `packages/shared/src/engine/operations/add-remove.property.test.ts`
    - **Property 9: add_object then remove_object restores the Stack**
    - Inputs: as Property 8. Assert `remove_object` of the new id gives a Stack deeply equal to the original
    - **Validates: Requirements 3.1, 3.8**
  - [ ]* 9.28 Write property test for `update_object` in `packages/shared/src/engine/operations/update-object.property.test.ts`
    - **Property 10: update_object replaces only the named properties**
    - Inputs: `arbStack`, an Object, valid `changes` for its type, empty `changes`, `changes` with `id` or `type`, and a property of another type. Assert exact replacement, unchanged everything else, `INVALID_VALUE` at `/changes/id` or `/changes/type`, `UNKNOWN_PROPERTY` at `/changes/<property>`
    - **Validates: Requirements 3.4, 3.5, 3.6, 3.7**
  - [ ]* 9.29 Write property test for `remove_object` in `packages/shared/src/engine/operations/remove-object.property.test.ts`
    - **Property 11: remove_object removes the Object and every reference to it**
    - Inputs: `arbStack` and any Object. Assert `ok: true`, no remaining reference in any Handler or `inputObjectIds`, all other entities unchanged, and `removedActions` equal to the model count
    - **Validates: Requirements 3.8, 3.9**
  - [ ]* 9.30 Write property test for `link_cards` in `packages/shared/src/engine/operations/link-cards.property.test.ts`
    - **Property 12: link_cards appends one Link and refuses repeats**
    - Inputs: `arbStack` and two Cards (the same allowed) with no Link between them, plus a Card with 50 Links. Assert the appended last Link, `created`, a repeat gives `DUPLICATE_LINK` at `/toCardId`, and 50 Links gives `LIMIT_EXCEEDED` at `/fromCardId`
    - **Validates: Requirements 4.1, 4.2, 4.3**
  - [ ]* 9.31 Write property test for unknown entities in `packages/shared/src/engine/operations/unknown-entity.property.test.ts`
    - **Property 14: Unknown entities and unknown names are reported at the parameter**
    - Inputs: `arbStack`, entity-naming parameters replaced by an unused id or the id of an entity of another kind (Operations and `buildRenderModel`), `set_action` with a Link as owner, and arbitrary non-Operation names. Assert `UNKNOWN_ENTITY` at that pointer, `WRONG_REFERENCE_TYPE` for the `set_action` owner, `INVALID_VALUE` at `/operation`, and the Stack unchanged
    - **Validates: Requirements 1.9, 1.12, 3.10, 4.6, 4.9, 6.4, 9.7**

- [ ] 10. Checkpoint - Ensure all tests pass
  - Run `pnpm --filter @hypergeist/shared test`, both typechecks, `pnpm exec eslint packages/shared apps/web/src`, and `pnpm exec vitest run apps/web scripts`. Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Step 7: Docs
  - [ ] 11.1 Update `README.md` (format and engine sections)
    - Describe the engine public API from `@hypergeist/shared/engine`: `executeHandler` (all nine Actions, Effect_Requests as data), `applyOperation` and the seven Operations with `OPERATIONS` and `operationJsonSchema`, `buildRenderModel`, `remixStack`, `createStack`, and the `OperationResult` and `Validation_Error` shapes. State the remaining gap honestly: the UI does not call Operations or run effects yet, and the app shows a "later release" message for effect Actions. No claim that anything is shipped that is not
    - _Requirements: 9.4, 10.1_
  - [ ] 11.2 Update `docs/handoff.md`
    - Record the engine API, the behavior change of `executeHandler` (the five Actions no longer say "not supported"; effects are returned as data), the web store effect message, the open items that were decided (error paths for omitted parameters, `LIMIT_EXCEEDED` for over-long text, `UNKNOWN_PROPERTY` for unknown parameters, summary `removedActions`), and the next steps (UI adoption of `buildRenderModel` and `applyOperation`, the AI orchestrator building its tool registry from `OPERATIONS`, the effects runtime writing results back with `update_object`). Do not state that the e2e check passed
    - _Requirements: 9.4_
  - [ ] 11.3 Update `.kiro/steering/project-status.md`
    - Update "Where we are": `stack-engine` now has requirements, design, tasks and an implemented engine package (pending the Developer's e2e check, task 13), and describe the engine public API in two or three lines. Keep the file short, keep the working agreements section unchanged, and update the "Last updated" date to the date given by the Developer or leave the date line alone if unknown
    - _Requirements: 9.4_
  - [ ] 11.4 Update `docs/kiro-journal.md`
    - Add a short entry for the `stack-engine` spec: spec-driven workflow, orchestrator mode, property-based tests for closure, atomicity, and schema consistency, and the properties that found real issues if any were recorded during the run (do not invent findings)
    - _Requirements: 11.1_

- [ ] 12. Final verification
  - [ ] 12.1 Audit the e2e specs for changed behavior
    - Read `e2e/smoke.spec.ts` and `e2e/thin-slice.spec.ts`. Check for any dependence on "not supported" text, on `remove_item` being skipped, or on the status text of a Button with an effect Action. Change a spec only if it depends on changed behavior (writing only; do NOT run Playwright). Report "no change needed" if nothing depends on it
    - _Requirements: 5.10, 5.17_
  - [ ] 12.2 Run the full verification suite
    - From the repo root, in this order, and record the result of each: `pnpm format` then `pnpm format:check`; `pnpm lint`; `pnpm typecheck`; `pnpm check:deps`; `pnpm test` three times with three different seeds (`HYPERGEIST_TEST_SEED=1`, `HYPERGEIST_TEST_SEED=20261115`, `HYPERGEIST_TEST_SEED=424242`; check `test-support/seed.ts` for the exact variable name); `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false pnpm build`; `pnpm stack validate apps/web/src/stacks/thin-slice-todo.json` and `pnpm stack validate scripts/stack/fixtures/all-types-stack.json` (both must print a valid result)
    - Also check: `git diff --stat -- package.json pnpm-lock.yaml packages/shared/package.json apps/web/package.json apps/worker/package.json` is empty; no `.tsx` file contains `--ghost`; `.kiro` is not in `.gitignore`. If a seed run fails, record the seed and the shrunk counterexample from the output and fix the cause in a follow-up task instead of changing the test. Do not commit
    - _Requirements: 1.1, 5.12, 9.5, 10.1, 11.3, 11.4, 11.6, 11.7, 11.8, 11.14_

- [ ] 13. USER CHECKPOINT: run the end-to-end tests (Developer runs this in their own terminal)
  - [ ] 13.1 Ask the Developer to run `pnpm test:e2e`
    - Chromium cannot run in the agent sandbox. Stop and ask the Developer to run `pnpm test:e2e` from the repo root in their own terminal and report the result. If a test fails, record the failure and fix it in a follow-up task. Mark this task done only after the Developer reports a pass
    - _Requirements: 5.10_

- [ ] 14. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise. Remind the Developer to review the diff and commit; no task commits, pushes, or deploys.

## Notes

- Tasks marked with `*` are optional property tests beyond the core set (Properties 4 to 12, 14, 17, 18, 20, 21, 23) and can be skipped for a faster path. The required properties are 1, 2, 3, 13, 15, 16, 19, 22 (closure, rejected-operation-unchanged, purity and determinism, `set_action` idempotence, schema and tool-schema consistency, executor validity, render, and stack-creation validity). Example tests are never optional, so every cascade, limit, and error path keeps at least one example even when the optional properties are skipped.
- Each task references the requirement clauses it covers. Property tasks name their property number from `design.md`.
- Existing tests that change expectations, by task: `smoke.test.ts` export pins (1.1 format list, 6.4, 7.7, 9.13 engine list), `engine/execute-handler.test.ts` and `format/type-lists.test.ts` (4.2), `apps/web/src/state/stack-store.test.ts` (4.4).
- Steps 4.2 and 4.4 form one step: after 4.2 alone the web store test for effects fails by design. Do not run the web checkpoint between them.
- No task adds a dependency, edits `pnpm-lock.yaml`, commits, pushes, or deploys.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.2", "2.3", "2.4", "2.5", "2.7", "9.1"] },
    { "id": 1, "tasks": ["2.6", "4.1", "6.1", "7.1", "7.3", "7.4", "9.3"] },
    { "id": 2, "tasks": ["4.2", "6.2", "6.3", "6.4", "7.2", "7.5", "7.6", "9.2", "9.4"] },
    { "id": 3, "tasks": ["4.3", "4.4", "4.5", "4.6", "4.7", "7.7", "9.5", "9.6", "9.7", "9.8", "9.9", "9.10", "9.11"] },
    { "id": 4, "tasks": ["9.12"] },
    { "id": 5, "tasks": ["9.13", "9.14", "9.18", "9.19", "9.20", "9.21", "9.22", "9.23", "9.24", "9.25", "9.26", "9.27", "9.28", "9.29", "9.30"] },
    { "id": 6, "tasks": ["9.15", "9.16", "9.17", "9.31"] },
    { "id": 7, "tasks": ["11.1", "11.2", "11.3", "11.4", "12.1"] },
    { "id": 8, "tasks": ["12.2"] },
    { "id": 9, "tasks": ["13.1"] }
  ]
}
```

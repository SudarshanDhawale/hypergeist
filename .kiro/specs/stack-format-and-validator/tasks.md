# Implementation Plan: stack-format-and-validator

## Overview

This plan extends the existing `packages/shared/src/format` module (thin-slice subset, 770 tests) to the full Stack_Format. It follows the 9-step migration order of `design.md`, so the existing tests stay green at the end of every step. Steps 1 to 9 need no new dependency. The one user checkpoint for `ajv` comes after all work that does not need it, and the ajv-dependent tests (Property 21 and the schema checks) come after it. The implementation language is TypeScript (strict, erasable syntax only), as in the design.

## Executor safety rules

Read these before every task. They override anything else in this file.

1. **No network, no installs.** The agent shell has no network. Never run `pnpm install`, `pnpm add`, `pnpm update`, `npm install`, `pnpm approve-builds`, or any command that modifies `node_modules`. A failed install once emptied `node_modules/.pnpm`. Never edit a dependency list or `pnpm-lock.yaml` by hand. The only dependency change in this spec is `ajv`, installed by the Developer at the user checkpoint (task 14).
2. **Scoped commands before the checkpoint.** Use `pnpm --filter @hypergeist/shared test`, `pnpm --filter @hypergeist/shared typecheck`, `pnpm --filter @hypergeist/web typecheck`, `pnpm exec vitest run <paths>`, and `pnpm exec eslint <paths>`. Run `pnpm exec prettier --write <touched files>` on the files the task touched only, because other tasks run in parallel. Run `pnpm format` only in the final verification task (16.2).
3. **No browser in the sandbox.** Chromium cannot run here. Writing e2e changes is a task. RUNNING `pnpm test:e2e` is a user checkpoint (task 17). `pnpm build` in the sandbox needs `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false` in the environment.
4. **Do not commit, push, or deploy.** The Developer commits.
5. **Code conventions.** Relative imports in `packages/shared/src` and `scripts/` use explicit `.ts` extensions. Only erasable TypeScript (no enums, no parameter properties, no namespaces). Vitest globals are off: import `describe`, `it`, `expect` from `vitest`, and call `cleanup` in `afterEach` in React tests. No `.tsx` file may contain the string `--ghost`. No `any`; use `unknown` and narrow it. No new dependency other than `ajv`.
6. **Property tests.** Each property test has the comment `Feature: stack-format-and-validator, Property N: <title>` and a `Validates` line, and runs through `assertProperty` from `packages/shared/test-support/seed.ts` (seed variable `HYPERGEIST_TEST_SEED`). Never hand-write a property harness.
7. **Existing tests.** The existing 770 tests stay green. Change an expectation only in the files each task names (about 8 files: `constants.test.ts`, `unsupported-types.test.ts`, `zod-issues.test.ts`, `validate.test.ts`, `schemas.test.ts`, `semantic.test.ts`, `smoke.test.ts`, and in `apps/web` `load-stack.test.ts` and `demo-stack.test.ts`). If any other existing test fails, stop and report it instead of editing it.
8. **Honest reporting.** If a task cannot be finished (a failing test that is not understood, a missing file), say so in the task result. Do not mark it done.

## Tasks

- [ ] 1. Step 1: JSON text scanner and independent test oracles
  - [~] 1.1 Create the test oracles `packages/shared/test-support/oracles.ts` and `oracles.test.ts`
    - Write each oracle independently of production code: RFC 6901 pointer resolver (to a location or its nearest existing ancestor), depth-first document-order traversal of paths, the canonical key-order table (from the design's "Canonical key order" table), line and column from a UTF-16 offset (lines break at `\n` only, columns count UTF-16 code units, both 1-based), the image `src` predicate, and the UTC timestamp predicate (`Date.UTC` round trip)
    - Unit-test each oracle with fixed examples (CRLF text, end-of-text offset, astral characters, `2027-02-29`, `24:00:00`)
    - _Requirements: 7.4, 7.8, 9.3, 9.5, 4.4, 6.11, 12.5_
  - [~] 1.2 Create `packages/shared/test-support/json-text-arbitraries.ts`
    - Near-valid JSON text generators: arbitrary strings, valid JSON text with one character deleted, inserted, or truncated, texts with CRLF line breaks, and texts that start with a byte order mark
    - _Requirements: 7.12, 9.3, 12.2_
  - [~] 1.3 Implement `packages/shared/src/format/json-text.ts` (`findJsonSyntaxError`) and `json-text.test.ts`
    - Iterative RFC 8259 scanner with an explicit nesting stack. It accepts exactly what `JSON.parse` accepts (whitespace is space, tab, LF, CR only; no BOM; no raw control characters in strings; no leading zeros; no trailing commas). Returns `{ offset, line, column, found }` or `undefined`
    - Examples: error at the first bad character, error at end of text, CRLF and CR-only files, BOM, a 2 MiB text of `[` characters does not overflow the stack, 100,000 levels of nesting
    - Not wired into any other module yet
    - _Requirements: 7.12, 9.3_
  - [~] 1.4 Write property test for scanner agreement with `JSON.parse` in `packages/shared/src/format/json-text.property.test.ts`
    - **Property 17: JSON syntax errors are located** (scanner part: the scanner reports an error exactly when `JSON.parse` throws, the offset is within the text, line and column agree with the oracle from 1.1)
    - Inputs: arbitrary strings and valid JSON with one character deleted, inserted, or truncated (from 1.2)
    - **Validates: Requirements 7.12, 9.3**

- [ ] 2. Step 2: Shared validation pipeline
  - [~] 2.1 Create `packages/shared/src/format/check.ts` and turn `validate.ts` into thin wrappers
    - Move the pipeline of the design diagram into `check.ts` (`checkText`, `checkValue`, returning the `ValidationResult` only at this step; the Stack and canonical text come in step 4). It never throws (the outer `try` of today's `validateStack` moves here)
    - `validateStack` and `validateHandler` become wrappers. `INVALID_JSON` messages use the scanner from 1.3: `The text is not well-formed JSON: unexpected "}" at line 1, column 11.` with the hints and the line 1, column 1 fallback from the design. A leading BOM adds the BOM hint
    - Existing tests assert code, path, and `actual` only, so they pass unchanged. Run `pnpm --filter @hypergeist/shared test` and `typecheck`
    - _Requirements: 7.1, 7.9, 7.10, 7.11, 7.12, 9.3, 10.3_
  - [~] 2.2 Write example tests for the pipeline in `packages/shared/src/format/check.test.ts`
    - `INVALID_JSON` message contains `line` and `column` numbers for fixed inputs, including a CRLF text, an end-of-text error, and a BOM text
    - Text over 2,097,152 bytes gives one `LIMIT_EXCEEDED` at `""` without parsing; exactly 2,097,152 bytes is parsed
    - The pipeline never throws for cycles, throwing getters, and `undefined`
    - _Requirements: 7.12, 8.7, 9.3, 9.4, 10.3_
  - [~] 2.3 Extend `json-text.property.test.ts` with the validator part of Property 17
    - **Property 17: JSON syntax errors are located** (validator part: for text that fails, `validateStack` returns one `INVALID_JSON` at `""` whose message contains the line and column the oracle computes from the scanner offset; both are within the text)
    - **Validates: Requirements 7.12, 9.3**

- [ ] 3. Step 3: Array maximums move to the semantic pass
  - [~] 3.1 Create `packages/shared/src/format/limit-messages.ts`
    - One shared helper for the `LIMIT_EXCEEDED` message, expected, and hint texts. Refactor the array `too_big` branch of `zod-issues.ts` to use it. The texts stay byte-identical to today's, so existing tests pass
    - _Requirements: 7.5, 8.5_
  - [~] 3.2 Move array maximums from Zod to the semantic pass
    - `schemas.ts`: add `limitedArray(element, max)` (`z.array(element).meta({ maxItems: max })`, no `.max()`); keep `.min()` where a minimum exists (`cards`, and later `topics`); use it for `cards`, `objects`, `links`, List `items`, and `HandlerSchema`. `text()` gets `.meta({ maxLength: max })` so the JSON Schema keeps the code-point maximum
    - `semantic.ts`: add `checkArrayLimit(value, path, max)` reporting `LIMIT_EXCEEDED` at the array path on the raw candidate, at `/cards` (200), each Card's `objects` (100) and `links` (50), each List's `items` (500), and every Handler (20) inside `walkHandler` (so `validateHandler` is covered too). Use the helper from 3.1
    - An oversize array no longer hides its element errors. Existing array-limit tests pass because messages are identical. Run `pnpm --filter @hypergeist/shared test`
    - _Requirements: 1.4, 1.7, 3.3, 4.5, 6.1, 7.6, 8.5_
  - [~] 3.3 Write example tests in `packages/shared/src/format/array-limits.test.ts`
    - For each array site that exists now (Cards, Objects, Links, List items, Handler): content of exactly the maximum is valid; one more gives exactly one `LIMIT_EXCEEDED` at the array path; an oversize array that also holds a bad element reports both errors; `validateHandler` with 21 Actions reports `LIMIT_EXCEEDED` at `""`
    - _Requirements: 7.6, 8.5_

- [~] 4. Checkpoint - Ensure all tests pass
  - Run `pnpm --filter @hypergeist/shared test` and `typecheck`. Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Step 4: Canonical text, parser, and serializer
  - [~] 5.1 Add `parse.ts`, `serialize.ts`, and the canonical text to `check.ts`; export from `format/index.ts`
    - `check.ts` returns `{ result, stack?, canonical? }`. The canonical text is `JSON.stringify(parsedStack, null, 2) + '\n'`, built from the Zod output, so key order is the declaration order of the shapes. The 2 MiB size check measures this text
    - `parseStack(input)` returns `{ ok: true, value } | { ok: false, errors, truncated }`, same dispatch as `validateStack`. `serializeStack(stack: unknown)` returns `{ ok: true, value } | { ok: false, errors, truncated }`; a string input gives one `WRONG_TYPE` at `""`
    - Export `parseStack`, `serializeStack`, `ParseResult`, `SerializeResult`. No new dependency, no `TextEncoder` or `Buffer` in `src` (count UTF-8 bytes by hand, as the existing code does)
    - _Requirements: 8.7, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.10, 9.11, 10.2, 10.3_
  - [~] 5.2 Switch the web app `loadStack` to `parseStack`
    - `apps/web/src/stacks/load-stack.ts` calls `parseStack(text)` instead of `validateStack` plus `StackSchema.parse(JSON.parse(text))`. Behavior and error output stay the same. Run `pnpm --filter @hypergeist/web typecheck` and `pnpm exec vitest run apps/web/src/stacks`
    - _Requirements: 9.2_
  - [~] 5.3 Write example tests in `packages/shared/src/format/parse-serialize.test.ts`
    - Canonical form: two-space indentation, exactly one trailing newline, optional keys omitted, array order kept
    - `-0` in `x` validates and is written as `0`
    - Strings with astral characters, `"`, `\`, line breaks, and lone surrogates survive a round trip with the same code point sequence
    - A valid Stack whose canonical text is exactly 2,097,152 bytes validates (build it from many Cards with padded Field values); one byte more gives `LIMIT_EXCEEDED` at `""` from `validateStack`, `parseStack`, and `serializeStack`
    - Text of 2,097,153 bytes gives one `LIMIT_EXCEEDED` from `parseStack` without parsing; `serializeStack('{}')` gives `WRONG_TYPE` at `""`
    - _Requirements: 8.7, 9.1, 9.4, 9.5, 9.6, 9.9, 9.11_
  - [~] 5.4 Write property test for canonical serialization in `packages/shared/src/format/roundtrip.property.test.ts`
    - **Property 18: Canonical serialization** (key-shuffled deep copies give the same text; one trailing newline; two-space indentation; keys in the oracle's table order; array order kept; at most 2,097,152 bytes)
    - **Validates: Requirements 9.1, 9.5, 9.6**
  - [~] 5.5 Add the round-trip property to `roundtrip.property.test.ts`
    - **Property 19: Serialization round trips** (parse of serialize deep-equals the input with identical code point sequences; serialize of parse of canonical text is identical; any valid JSON formatting of a valid stack parses then serializes to the canonical text)
    - **Validates: Requirements 8.7, 9.7, 9.8, 9.9, 10.1, 12.4**
  - [~] 5.6 Add the agreement property to `roundtrip.property.test.ts`
    - **Property 20: The parser and serializer agree with the validator** (`parseStack(c).ok` equals `validateStack(c).valid`; errors and `truncated` are equal when not ok; `serializeStack` of an object returns the validator's errors and no text; a string gives one `WRONG_TYPE` at `""`)
    - **Validates: Requirements 9.2, 9.10, 9.11**

- [ ] 6. Step 5: JSON Schema export (implementation only, no ajv yet)
  - [~] 6.1 Implement `packages/shared/src/format/json-schema.ts` (`stackJsonSchema`) and `json-schema.test.ts`
    - `z.toJSONSchema(StackSchema)` with default target (draft 2020-12) and default `unrepresentable: "throw"`; returns a fresh object each call; export `stackJsonSchema` and `JsonSchemaDocument` from `format/index.ts`
    - Tests without ajv: it does not throw, `$schema` names draft 2020-12, the Stack has `additionalProperties: false`, `formatVersion` is `const 1`, and each `maxItems` and `maxLength` in the output equals the `LIMITS` row used by the semantic pass (table-driven; later steps add rows)
    - The ajv-based checks (meta-schema, Property 21) wait for task 15
    - _Requirements: 11.1_

- [ ] 7. Step 6: `image` and `ai-field` Objects (validator, engine alignment, and web in one step)
  - [~] 7.1 Update `limits.ts` and its constants test
    - Add the `LIMITS` rows `imageAlt`, `imageHttpsSrc`, `imageDataSrc`, `aiPrompt`, `aiInputObjects`, `aiFieldValue` and `IMAGE_SRC_PATTERN` (ASCII-only, two alternatives, from the design)
    - Rename `SUPPORTED_OBJECT_TYPES` to `OBJECT_TYPES` (order `button, field, image, list, ai-field`) and delete `UNSUPPORTED_OBJECT_TYPES`. Update the imports in `semantic.ts` and `zod-issues.ts` mechanically, and export the new names from `format/index.ts`. Keep `SUPPORTED_ACTION_TYPES` and `UNSUPPORTED_ACTION_TYPES` for now (step 7)
    - Existing test that changes: `constants.test.ts` (LIMITS pin and type lists)
    - _Requirements: 3.2, 4.3, 4.4, 4.6_
  - [~] 7.2 Add the `ImageSchema` and `AiFieldSchema` in `schemas.ts`
    - Properties in canonical order (common, then `src`, `alt`; common, then `prompt`, `inputObjectIds`, `value`). `imageSrc` is `z.string().regex(IMAGE_SRC_PATTERN).max(1_000_000)` plus the custom check that gives a `too_big` issue (maximum 2,000) for an `https:` source over 2,000 characters. `inputObjectIds` is `limitedArray(EntityId, 10)` with `.meta({ uniqueItems: true })`. `ObjectSchema` becomes the five-member discriminated union. Export `ImageObject`, `AiFieldObject`, `ImageSchema`, and `AiFieldSchema` from `format/index.ts`
    - Existing test that changes: `schemas.test.ts` (cases that reject `image` and `ai-field` now accept complete ones)
    - _Requirements: 3.1, 3.2, 4.3, 4.4, 4.6_
  - [~] 7.3 Update `zod-issues.ts` for Object types and image sources
    - `invalid_union` on an Object `type` is always "is unknown", with a hint that lists `OBJECT_TYPES`. Add a small pattern-to-message table for `invalid_format` with `format: "regex"`: the Entity_ID pattern (existing) and `IMAGE_SRC_PATTERN` (`INVALID_VALUE`, message names the Image id, hint from the design). A string that is too long and does not match reports `INVALID_VALUE` and `LIMIT_EXCEEDED` at the same path
    - Existing test that changes: `zod-issues.test.ts` (lines for the unsupported Object types; use `nope` where `image` was the example of an invalid type)
    - _Requirements: 3.2, 4.8, 4.9_
  - [~] 7.4 Update `semantic.ts` for ai-field and image rules
    - `EntityInfo` gains `cardIndex`. `walkObject` walks `image` (bounds only) and `ai-field` (bounds, inputs, `inputObjectIds` array limit of 10). Report for each `inputObjectIds` entry: `DANGLING_REFERENCE`; `WRONG_REFERENCE_TYPE` for its own id, a Card or Link, a `button` or `image`, or an Object on another Card (message says which and names the ai-field id); `INVALID_VALUE` at the later entry for a repeated id
    - Widen the existing Action reference rules: `set_value.targetObjectId` accepts `field` or `ai-field`; `set_value.fromObjectId` accepts `field`, `ai-field`, or `list`; `append_item.fromObjectId` accepts `field` or `ai-field`
    - Existing test that changes: `semantic.test.ts` (three cases that use a partial `image` Object as an "unsupported Object that is skipped": use an unknown type instead)
    - _Requirements: 2.4, 3.5, 4.7, 4.8, 6.4, 6.5, 8.2, 8.3, 8.4_
  - [~] 7.5 Rename `unsupported-types.test.ts` to `type-discrimination.test.ts` and update `smoke.test.ts`
    - The "unsupported Object" cases become "valid when complete" cases. The "unknown", "absent", and "non-string" `type` cases stay. The Action cases stay as they are until step 7 (task 9.5)
    - `packages/shared/src/smoke.test.ts` export list: remove `SUPPORTED_OBJECT_TYPES` and `UNSUPPORTED_OBJECT_TYPES`, add `OBJECT_TYPES`, `ImageSchema`, `AiFieldSchema`
    - _Requirements: 3.2, 4.3, 4.6_
  - [~] 7.6 Engine alignment for `ai-field`
    - `engine/stack-edit.ts`: `textOf` returns `value` of an `ai-field`. `engine/execute-handler.ts`: `set_value` may target an `ai-field`. (The design lists this under step 7. It is moved here so the validator and the executor never disagree about `ai-field`.) Add examples to `stack-edit.test.ts` and `execute-handler.test.ts`: `set_value` into an ai-field, and copying from an ai-field
    - _Requirements: 6.4, 6.5_
  - [~] 7.7 Web: render `image` and `ai-field`
    - `apps/web/src/components/ObjectView.tsx`: an `image` renders a framed placeholder (`role="img"`, `aria-label` from `alt`, then `name`, then the id) with the word "Image" and the alt text. It never creates an `<img>` and never loads `src`. An `ai-field` renders a read-only `<textarea>` showing `value`, with the placeholder "AI field. AI arrives in a later release." Both are inert in Edit mode like the other previews
    - `styles/canvas.css`: two rules for `[data-type='image']` and `[data-type='ai-field']` with existing tokens only (the CSS token scan test must stay green)
    - Add `ObjectView.test.tsx`: no `<img>` element, no network call (stub `fetch`), correct labels; call `cleanup` in `afterEach`. No `.tsx` file may contain `--ghost`
    - _Requirements: 4.3, 4.6_
  - [~] 7.8 Web: property rows and accessible names for the new types
    - `lib/property-rows.ts`: rows for `src` (cut to 80 code points followed by "…"), `alt`, `prompt`, `inputObjectIds`, `value`. `lib/accessible-name.ts`: an `image` with an empty name uses `alt` before the id. Extend `property-rows.test.ts` (a 1 MB `src` is cut) and `accessible-name.test.ts`
    - _Requirements: 4.3, 4.6_
  - [~] 7.9 Web: update the two existing web tests and get the web app compiling
    - `apps/web/src/stacks/load-stack.test.ts` and `demo-stack.test.ts` use `'nope'` as the unknown type instead of an unsupported one. Run `pnpm --filter @hypergeist/web typecheck` and `pnpm exec vitest run apps/web`. Fix only compile errors caused by the wider `StackObject` union
    - _Requirements: 3.2, 9.2_
  - [~] 7.10 Extend the generators in `packages/shared/test-support/arbitraries.ts` and `arbitraries.test.ts`
    - `arbStack` produces `image` and `ai-field` Objects. `inputObjectIds` is filled in a second pass from sibling `field`, `list`, and `ai-field` ids on the same Card (never the ai-field's own id), unique. Image sources mix short and 2,000-character `https:` URLs with data URIs for all four types; a 1,000,000-character data URI appears rarely as a cached constant, and the 1.9 MB size filter stays
    - The engine property tests (`purity`, `result-validity`) must still pass unchanged
    - _Requirements: 12.1_
  - [ ]* 7.11 Write property test for image sources in `packages/shared/src/format/values.property.test.ts`
    - **Property 14: Image sources** (the validator accepts an Image exactly when the oracle predicate from 1.1 accepts the source; every rejected source gives an error at the `src` path and the message names the Image id)
    - **Validates: Requirements 4.3, 4.4, 4.8, 4.9**
  - [~] 7.12 Extend the schema consistency tests in `json-schema.test.ts`
    - Add the new rows: `alt` and `prompt` and `value` `maxLength`, `inputObjectIds` `maxItems` 10 and `uniqueItems`, the `src` pattern, `type` as `const` for all five Object types
    - _Requirements: 11.1_

- [~] 8. Checkpoint - Ensure all tests pass
  - Run `pnpm --filter @hypergeist/shared test`, `pnpm --filter @hypergeist/shared typecheck`, `pnpm --filter @hypergeist/web typecheck`, and `pnpm exec vitest run apps/web`. Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Step 7: Five new Actions
  - [~] 9.1 Update `limits.ts` for the Actions
    - Add the `LIMITS` rows `removeItemIndex`, `newsTopics`, `newsTopicText`, `notificationMessage`. Rename `SUPPORTED_ACTION_TYPES` to `ACTION_TYPES` (glossary order) and delete `UNSUPPORTED_ACTION_TYPES`. Update imports in `semantic.ts` and `zod-issues.ts` mechanically; export the new names from `format/index.ts`
    - Existing test that changes: `constants.test.ts` (new rows, type list)
    - _Requirements: 6.2, 6.6, 6.7, 6.9, 6.11_
  - [~] 9.2 Add the five Action schemas in `schemas.ts`
    - `remove_item` (`index` is `z.int().min(0)`), `show_message`, `run_ai_field`, `fetch_news` (`topics` is `limitedArray(text(1, 100), 10).min(1)`), `transcribe_audio`, `schedule_notification` (`at` is `z.iso.datetime()`, `atFromObjectId`). Properties in the canonical order of the design's Action table. The three exactly-one-of pairs keep both members optional and add `.meta({ oneOf: [{ required: [a] }, { required: [b] }] })`. Update `ActionSchema` and export the new schemas and types
    - Existing test that changes: `schemas.test.ts` (the cases that reject the five Actions)
    - _Requirements: 6.2, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 6.12_
  - [~] 9.3 Update `zod-issues.ts` for the Actions
    - An Action `type` that is not in `ACTION_TYPES` is always "is unknown", with a hint that lists `ACTION_TYPES`. Add `invalid_format` for `format: "datetime"` (`INVALID_VALUE`, expected "a UTC timestamp such as 2026-12-01T09:00:00Z", hint "Write the time in UTC with seconds and a trailing Z.")
    - Existing test that changes: `zod-issues.test.ts` (lines for the unsupported Action types; use `nope`)
    - _Requirements: 6.2, 6.11, 6.13_
  - [~] 9.4 Update `semantic.ts` for the Actions
    - `walkAction` skips only a `type` that is not in `ACTION_TYPES`. Add the full reference table: `remove_item.targetObjectId` is a `list`; `run_ai_field.targetObjectId` an `ai-field`; `fetch_news.targetObjectId` a `list`; `transcribe_audio.targetObjectId` a `field`; `schedule_notification.atFromObjectId` a `field`. Add the `topics` array limit (10) and the exactly-one-of check for `schedule_notification` (`at` or `atFromObjectId`, `INVALID_VALUE` at the Action path)
    - Existing test that changes: `semantic.test.ts` (any case that relied on a skipped Action type)
    - _Requirements: 2.3, 2.4, 6.3, 6.4, 6.5, 6.6, 6.8, 6.9, 6.10, 6.11, 6.13, 8.2, 8.3, 8.5_
  - [~] 9.5 Update the remaining existing tests for the Actions
    - `validate.test.ts`: the `fetch_news` "not supported in this release" case (lines near 340 to 360) becomes a valid-when-complete case plus an unknown-type case. `type-discrimination.test.ts`: the Action "unsupported" cases become "valid when complete" cases. `smoke.test.ts` export list: remove `SUPPORTED_ACTION_TYPES` and `UNSUPPORTED_ACTION_TYPES`, add `ACTION_TYPES` and the new Action schema names
    - _Requirements: 6.2, 6.13_
  - [~] 9.6 Write one example per new rule in `packages/shared/src/format/new-types.test.ts`
    - An ai-field input on another Card gives `WRONG_REFERENCE_TYPE`; an input that is a button, an image, the ai-field itself, a Card, or a Link gives `WRONG_REFERENCE_TYPE`; a missing id gives `DANGLING_REFERENCE`; a repeated input gives `INVALID_VALUE`; a 2,001-character `https:` source gives `LIMIT_EXCEEDED`; `at` with an offset, without seconds, with lowercase `z`, and `2027-02-29T00:00:00Z` give `INVALID_VALUE`; `remove_item` `index` of 0 is valid, -1 and 1.5 are not; `fetch_news` with 0 and 11 topics; both or neither of each exactly-one-of pair; every error message for image and ai-field names the Object id
    - Each case asserts code and path
    - _Requirements: 4.7, 4.8, 4.9, 6.6, 6.9, 6.11, 12.8_
  - [~] 9.7 Extend the Action generators in `arbitraries.ts` and `arbitraries.test.ts`
    - `arbHandlerFor(stack, mode)` with `mode: 'executable' | 'all'`. The default `'executable'` keeps today's four Action types, so the engine property tests behave as before. `'all'` adds the five new Actions with valid references, `at` from `fc.date().toISOString()`, and values at the min and max of each limit. `arbStack` uses `'all'` for format tests only
    - _Requirements: 12.1_
  - [ ]* 9.8 Write property test for timestamps in `values.property.test.ts`
    - **Property 15: Timestamps** (any `Date` ISO string is accepted as `at`; for any `YYYY-MM-DDTHH:mm:ss(.fraction)?` followed by `Z`, an offset, or nothing, with arbitrary field values, `at` is accepted exactly when the oracle predicate accepts it)
    - **Validates: Requirements 6.11**
  - [~] 9.9 Engine: example tests for the Actions that are only validated
    - Add to `execute-handler.test.ts`: `remove_item`, `run_ai_field`, `fetch_news`, `transcribe_audio`, and `schedule_notification` are skipped with "Skipped action N (type): this action type is not supported.", the result Stack is unchanged and valid. No behavior change in `execute-handler.ts` (the `stack-engine` spec owns it)
    - _Requirements: 6.2, 6.12_
  - [~] 9.10 Web: a Button with a new Action shows the skip message
    - Add a test to `apps/web/src/state/stack-store.test.ts` (or the existing store smoke test): clicking a Button whose Handler is `remove_item` shows the skip message in the Hint_Line and leaves the Stack unchanged
    - _Requirements: 6.2_
  - [~] 9.11 Extend the schema consistency tests in `json-schema.test.ts`
    - Add the Action rows: each `type` `const`, `fetch_news` `topics` `minItems` 1 and `maxItems` 10, `show_message` and `schedule_notification` `message` `maxLength`, `index` `minimum` 0, the `at` `format` and `pattern`, and `oneOf` of two `required` lists for the three pairs
    - _Requirements: 11.1_

- [~] 10. Checkpoint - Ensure all tests pass
  - Run `pnpm --filter @hypergeist/shared test`, both typechecks, and `pnpm exec vitest run apps/web scripts`. Ensure all tests pass, ask the user if questions arise.

- [ ] 11. Step 8: Generator hardening and the remaining property tests
  - [~] 11.1 Harden the generators in `packages/shared/test-support/arbitraries.ts`
    - Text gets the hostile units `"`, `\`, `\n`, and lone surrogates (besides the existing `a`, `é`, `😀`). `arbMutationFor` gains reference sites for the new Actions and `inputObjectIds`, limit sites for the new strings, and value sites for `src` and `at`. Mutations stay the four kinds of Requirement 12.5
    - _Requirements: 12.1, 12.5_
  - [~] 11.2 Add the generator coverage test to `arbitraries.test.ts`
    - A fixed-seed sample of `arbStack` contains every Object type, every Action type, Links, `remixedFrom` present and absent, and the minimum and maximum of each limit
    - _Requirements: 12.1_
  - [~] 11.3 Write the key-order golden test in `packages/shared/src/format/canonical-order.test.ts`
    - Serialize one stack that has every Object type and every Action type, and compare the keys of every object with the design's key-order table (the oracle from 1.1)
    - _Requirements: 9.5_
  - [~] 11.4 Write boundary tables in `packages/shared/src/format/limits-boundaries.test.ts`
    - For every `LIMITS` row that applies: the maximum is valid and one more gives exactly one `LIMIT_EXCEEDED`; the minimum is valid and one less is rejected where a minimum exists. Run each text row with ASCII and with astral characters (counted in code points). Include Stack `cardWidth` and `cardHeight` 63, 64, 4096, 4097; Object `x`, `y` 0, 4096, 4097 and `width`, `height` 7, 8; `index` 0, -1, 1.5
    - _Requirements: 1.3, 1.4, 1.7, 3.3, 3.4, 4.2, 4.5, 6.1, 6.6, 6.7, 8.5_
  - [~] 11.5 Write the type-list consistency test in `packages/shared/src/format/type-lists.test.ts`
    - `OBJECT_TYPES` equals the `type` literals of `ObjectSchema`'s options and `ACTION_TYPES` equals those of `ActionSchema`, in the documented order
    - _Requirements: 3.2, 6.2_
  - [~] 11.6 Extend `valid-stacks.property.test.ts`
    - **Property 1: Valid stacks validate** (for any `arbStack` with all Object and Action types, `validateStack` of the stack, its canonical text, and its minified JSON text each return `{ valid: true, errors: [], truncated: false }`)
    - **Validates: Requirements 1.1, 1.2, 1.4, 1.5, 1.6, 1.8, 3.1, 3.2, 4.1, 4.2, 4.3, 4.5, 4.6, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 7.2**
  - [~] 11.7 Extend `validator-total.property.test.ts` with determinism
    - **Property 2: The validator is total, pure, and deterministic** (for any candidate, including deeply frozen copies, `validateStack`, `parseStack`, and `serializeStack` do not throw, leave the candidate deeply equal to a copy taken before, and return deeply equal results on two calls)
    - **Validates: Requirements 2.5, 7.11, 10.3, 12.6**
  - [ ]* 11.8 Create `validator-structure.property.test.ts` with Property 4
    - **Property 4: Root and version short-circuits** (any non-object gives exactly one `WRONG_TYPE` at `""`; any object with an integer `formatVersion` other than 1 gives exactly one `UNSUPPORTED_VERSION` at `/formatVersion` whose hint names version 1)
    - **Validates: Requirements 7.9, 7.10**
  - [ ]* 11.9 Create `semantic-rules.property.test.ts` with Property 9
    - **Property 9: Object bounds are inclusive and reported once** (an Object whose `x + width` and `y + height` equal the card size is valid; one unit past either edge, or both, gives exactly one `OUT_OF_BOUNDS` at the Object path)
    - **Validates: Requirements 3.5, 8.4**
  - [~] 11.10 Extend `validator-total.property.test.ts` with mutations
    - **Property 3: Results are well-formed and paths resolve** (`valid` is true exactly when `errors` is empty; at most 100 errors; `truncated` implies exactly 100; codes in the closed set and never `OUT_OF_RANGE` or `UNKNOWN_ENTITY`; `message`, `expected`, and `hint` non-empty; `actual` is `null` or at most 200 code points; every `path` resolves with the oracle pointer resolver to a location or its nearest existing ancestor; one random mutation of a valid stack is either valid or satisfies all of this)
    - **Validates: Requirements 1.11, 3.6, 6.13, 7.1, 7.3, 7.4, 7.5, 7.13, 8.8, 12.5**
  - [ ]* 11.11 Extend `validator-structure.property.test.ts` with Property 6
    - **Property 6: Every violation is reported, up to 100** (k unknown properties on k different entities give min(k, 100) errors; `truncated` is true exactly when k exceeds 100; the errors are the first ones in document order)
    - **Validates: Requirements 7.6, 7.7**
  - [ ]* 11.12 Extend `semantic-rules.property.test.ts` with Property 10
    - **Property 10: Entity ids are unique across kinds** (after reassigning Card, Object, and Link ids from a small pool, the `DUPLICATE_ID` paths equal the `id` paths of the later occurrences in document order, and an id used n times gives n minus 1 errors)
    - **Validates: Requirements 2.2, 8.1**
  - [ ]* 11.13 Extend `validator-total.property.test.ts` with ordering
    - **Property 5: Errors follow document order** (for any mutated candidate, errors are ordered by the oracle's depth-first path position, and equal paths are ordered by `code` in ascending code-point order)
    - **Validates: Requirements 7.8**
  - [ ]* 11.14 Extend `validator-structure.property.test.ts` with Property 7
    - **Property 7: Oversize arrays do not hide element errors** (for each array site: Cards, Objects, Links, List items, Handler, `inputObjectIds`, `topics`, growing the array past its maximum with an element violation inside gives both a `LIMIT_EXCEEDED` at the array path and the element's own error)
    - **Validates: Requirements 7.6, 8.5**
  - [ ]* 11.15 Extend `semantic-rules.property.test.ts` with Property 11
    - **Property 11: References resolve by kind** (for every reference property in the design's table, including each `inputObjectIds` entry: a missing id gives `DANGLING_REFERENCE`; an existing entity outside the allowed set gives `WRONG_REFERENCE_TYPE`; an allowed entity keeps the stack valid)
    - **Validates: Requirements 1.5, 2.3, 2.4, 2.7, 4.7, 5.6, 6.3, 6.4, 6.5, 6.8, 6.9, 6.10, 6.11, 8.2, 8.3**
  - [ ]* 11.16 Extend `validator-structure.property.test.ts` with Property 8
    - **Property 8: Unknown types are rejected cleanly** (replacing the `type` of an Object or Action with a string that is not in `OBJECT_TYPES` or `ACTION_TYPES`, including a valid type of the other kind, gives exactly one `INVALID_VALUE` at `<node>/type` with a message ending in "is unknown." and a hint that lists the valid types)
    - **Validates: Requirements 3.2, 6.2, 6.13**
  - [ ]* 11.17 Extend `semantic-rules.property.test.ts` with Property 12
    - **Property 12: Link rules** (adding a Link with a fresh id keeps the stack valid when no Link in that Card has that target, including self-links and targets shared with other Cards; otherwise exactly one `DUPLICATE_LINK` at the new Link's `targetCardId` path)
    - **Validates: Requirements 5.3, 5.4, 5.5, 8.6**
  - [ ]* 11.18 Extend `validator-structure.property.test.ts` with Property 16
    - **Property 16: Limits at the boundary** (for each applicable `LIMITS` row, content of exactly the maximum is valid and one more gives exactly one `LIMIT_EXCEEDED` at the site; text is counted in code points, so astral characters at the maximum are valid)
    - **Validates: Requirements 1.4, 1.7, 3.3, 4.2, 6.1, 6.7, 6.9, 8.5**
  - [ ]* 11.19 Extend `semantic-rules.property.test.ts` with Property 13
    - **Property 13: Exactly one of each pair** (for any `set_value`, `append_item`, or `schedule_notification` Action, both or neither member gives exactly one `INVALID_VALUE` at the Action path; exactly one member is valid)
    - **Validates: Requirements 6.4, 6.5, 6.11**

- [~] 12. Checkpoint - Ensure all tests pass
  - Run `pnpm --filter @hypergeist/shared test` and `typecheck`. Ensure all tests pass, ask the user if questions arise.

- [ ] 13. Step 9: CLI fixture and docs
  - [~] 13.1 Add the all-types fixture and CLI tests
    - Create `scripts/stack/fixtures/all-types-stack.json`: canonical text of a stack with every Object type and every Action type. Generate it with a throwaway Node script that uses `parseStack` and `serializeStack` (do not commit the script, do not hand-write the JSON). `cli.ts` does not change
    - Add to `scripts/stack/cli.test.ts`: `validate` on the fixture exits 0; `validate` on `fixtures/not-json.txt` prints a message that contains the line and column; the existing cases still pass. Use explicit `.ts` extensions
    - _Requirements: 7.12, 9.3, 12.8_
  - [~] 13.2 Update `README.md` and `docs/handoff.md`
    - README "Supported stack format" and "Limits" sections (around lines 190 to 205): five Object types, nine Actions, "unknown" instead of "not supported in this release", the image `src` rules, the timestamp rule, and the new `parseStack`, `serializeStack`, and `stackJsonSchema` entry points. `docs/handoff.md` line 24 (the slice's supported set) now says the full format is supported
    - Do not touch `.kiro/steering`. Run prettier on these two files only
    - _Requirements: 3.2, 6.2_

- [ ] 14. USER CHECKPOINT: install `ajv` (Developer runs this in their own terminal)
  - [~] 14.1 Ask the Developer to install `ajv`, then verify read-only
    - Stop and ask the Developer to run, from the repo root in their own terminal: `pnpm --filter @hypergeist/shared add -D ajv@^8`. (`ajv-formats` is NOT needed: the design uses `validateFormats: false`, and the pattern already covers `date-time`.) The Developer may run this command before any task starts, in which case this checkpoint only confirms it
    - After the Developer confirms, verify by reading only: `packages/shared/package.json` lists `ajv` under `devDependencies` with a `^8` range; `pnpm-lock.yaml` has an `ajv@8` entry for `packages/shared`; `node_modules/.pnpm` has an `ajv@8.*` folder and `packages/shared/node_modules/ajv/dist/2020.js` exists. Do not run any install command and do not edit these files. Report what was found
    - If anything is missing, report it and stop
    - _Requirements: 11.1, 12.7_

- [ ] 15. ajv-dependent schema tests
  - [~] 15.1 Create the test helper `packages/shared/test-support/schema-validator.ts`
    - Build one Ajv instance from `ajv/dist/2020.js` with `strict: false` and `validateFormats: false`. Check how the default import resolves under the package's `tsconfig` (CJS default export under NodeNext may need `.default`) and make `pnpm --filter @hypergeist/shared typecheck` pass. Never import `ajv` from `src/`
    - _Requirements: 11.1, 12.7_
  - [~] 15.2 Write the schema example tests in `packages/shared/src/format/json-schema.ajv.test.ts`
    - `stackJsonSchema()` compiles and validates against the draft 2020-12 meta-schema; it accepts the all-types fixture from 13.1 and the demo stack; it rejects a missing required property and a wrong-typed property; each of the three exactly-one-of pairs rejects both and neither; an unknown property is rejected
    - _Requirements: 11.1, 12.7_
  - [~] 15.3 Write property test for schema acceptance in `packages/shared/src/format/json-schema.property.test.ts`
    - **Property 21: The JSON Schema accepts valid stacks and rejects structural violations** (every `arbStack` is accepted; a mutation that deletes a required property, replaces a value with another JSON type, adds an unknown property, or breaks an exactly-one-of pair, and that `StackSchema.safeParse` reports as a structural issue, is rejected by the schema; the schema validates against the 2020-12 meta-schema)
    - **Validates: Requirements 11.1, 12.7**

- [ ] 16. Final verification
  - [~] 16.1 Audit the e2e specs for changed behavior
    - Read `e2e/smoke.spec.ts` and `e2e/thin-slice.spec.ts`. Check for any dependence on "not supported in this release", on the removed constants, or on the exact text of `INVALID_JSON` messages. Change a spec only if it depends on changed behavior (writing only; do NOT run Playwright). Report "no change needed" if nothing depends on it
    - _Requirements: 7.12, 9.3_
  - [~] 16.2 Run the full verification
    - In this order, from the repo root: `pnpm format`; `pnpm lint`; `pnpm typecheck`; `pnpm check:deps`; `HYPERGEIST_TEST_SEED=1 pnpm test`; `HYPERGEIST_TEST_SEED=424242 pnpm test` (two different seeds); `XDG_CONFIG_HOME=/tmp/wrangler-xdg WRANGLER_SEND_METRICS=false pnpm build`; `pnpm stack validate apps/web/src/stacks/thin-slice-todo.json` and `pnpm stack validate scripts/stack/fixtures/all-types-stack.json` (both exit 0)
    - `pnpm format` is allowed here because no task runs in parallel. Fix failures that this spec caused; report anything else. Do not run `pnpm test:e2e`
    - _Requirements: 7.2, 9.7, 10.2, 11.1, 12.2, 12.4, 12.6, 12.7_

- [ ] 17. USER CHECKPOINT: run the end-to-end tests (Developer runs this in their own terminal)
  - [~] 17.1 Ask the Developer to run `pnpm test:e2e`
    - Chromium cannot run in the agent sandbox. Ask the Developer to run `pnpm test:e2e` in their own terminal and report the result. If a test fails, record the failure and fix it in a follow-up task
    - _Requirements: 3.2, 9.2_

- [~] 18. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise. Remind the Developer to review the diff and commit; no task commits, pushes, or deploys.

## Notes

- Tasks marked with `*` are optional property tests beyond the core set. The required property tests are Properties 1, 2, 3 (determinism and mutation), 17 (JSON locator, because the scanner is hand-written), 18 to 20 (round trip and parser agreement), and 21 (schema acceptance). All example tests are required.
- Deviations from the design, made on purpose:
  - The `ajv` checkpoint (task 14) comes after all work that does not need ajv, as the safety rules ask, instead of in design step 5. Task 6.1 implements `stackJsonSchema` and tests it without ajv. The ajv tests run against the final schema, so they also catch drift from steps 6 and 7. The Developer can install `ajv` at any time before task 14 to avoid waiting.
  - The engine alignment for `ai-field` (task 7.6) is done in step 6, not step 7, so the validator and the executor never disagree about `ai-field`.
  - Properties 8, 11, and 13 are written in step 8 (not steps 6 and 7), after every type exists, so each covers the full set once. Property 17 is split across tasks 1.4 and 2.3 because its validator half needs the pipeline from step 2.
  - Property 7 and Property 16 have example tests in step 3 (task 3.3) and the full property tests in step 8.
- Existing tests whose expectations change: `constants.test.ts` (7.1, 9.1), `schemas.test.ts` (7.2, 9.2), `zod-issues.test.ts` (7.3, 9.3), `semantic.test.ts` (7.4, 9.4), `unsupported-types.test.ts` renamed to `type-discrimination.test.ts` (7.5, 9.5), `smoke.test.ts` (7.5, 9.5), `validate.test.ts` (9.5), and in `apps/web` `load-stack.test.ts` and `demo-stack.test.ts` (7.9).
- Each task references requirement numbers for traceability. Checkpoints give an incremental stop after steps 3, 6, 7, and 8.
- The `stack-engine` spec owns the real behavior of `remove_item`, `run_ai_field`, `fetch_news`, `transcribe_audio`, and `schedule_notification`. Until then the executor skips them with one message (task 9.9).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3"] },
    { "id": 2, "tasks": ["1.4", "2.1"] },
    { "id": 3, "tasks": ["2.2", "2.3", "3.1"] },
    { "id": 4, "tasks": ["3.2"] },
    { "id": 5, "tasks": ["3.3", "5.1"] },
    { "id": 6, "tasks": ["5.2", "5.3", "5.4", "6.1"] },
    { "id": 7, "tasks": ["5.5", "7.1"] },
    { "id": 8, "tasks": ["5.6", "7.2"] },
    { "id": 9, "tasks": ["7.3", "7.4", "7.6", "7.7", "7.8"] },
    { "id": 10, "tasks": ["7.5", "7.9", "7.10", "7.12"] },
    { "id": 11, "tasks": ["7.11"] },
    { "id": 12, "tasks": ["9.1"] },
    { "id": 13, "tasks": ["9.2"] },
    { "id": 14, "tasks": ["9.3", "9.4", "9.9", "9.11"] },
    { "id": 15, "tasks": ["9.5", "9.6", "9.7", "9.8", "9.10"] },
    { "id": 16, "tasks": ["11.1"] },
    { "id": 17, "tasks": ["11.2", "11.3", "11.4", "11.5", "11.6", "11.7", "11.8", "11.9"] },
    { "id": 18, "tasks": ["11.10", "11.11", "11.12", "13.1", "13.2"] },
    { "id": 19, "tasks": ["11.13", "11.14", "11.15"] },
    { "id": 20, "tasks": ["11.16", "11.17"] },
    { "id": 21, "tasks": ["11.18", "11.19"] },
    { "id": 22, "tasks": ["14.1"] },
    { "id": 23, "tasks": ["15.1"] },
    { "id": 24, "tasks": ["15.2", "15.3", "16.1"] },
    { "id": 25, "tasks": ["16.2"] },
    { "id": 26, "tasks": ["17.1"] }
  ]
}
```

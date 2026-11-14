# Requirements Document

## Introduction

This document specifies the first end-to-end vertical slice of HyperGeist, called the thin slice. The slice proves the whole path from stack data to a playable retro screen: a strict stack format, a validator, a pure action executor, a command-line validator, and a React shell in which a small to-do stack can be used in Interact mode and inspected in Edit mode. The slice ships one bundled Demo_Stack with three cards.

**The slice is a strict subset of two existing specs.** The `stack-format-and-validator` spec and the `stack-engine` spec define the full Stack_Format, Stack_Validator, and Action_Executor. This spec does not redefine them. It implements a subset that uses the same property names, bounds, limits, Entity_ID pattern, Validation_Error codes and structure, validator result shape `{valid, errors, truncated}`, and executor result shape `{stack, effects, navigateTo?, messages}`. Every Stack that the Slice_Validator accepts is a valid Stack under the full specs. The slice rejects the Object types `image` and `ai-field` and the Action types `remove_item`, `run_ai_field`, `fetch_news`, `transcribe_audio`, and `schedule_notification` with a clear Validation_Error, so the full specs can later add those members to the same schemas without changing any existing name, bound, or code.

**In scope.** Zod schemas and the semantic validator (`packages/shared/src/format`); the pure Action_Executor (`packages/shared/src/engine`); the `pnpm stack validate` command; the retro shell in `apps/web` (menu bar, one stack window, Interact and Edit modes, status bar, inert Ghost window); the bundled Demo_Stack; fonts and license records; README instructions; unit, property, and Playwright tests.

**Out of scope.** The Stack_Schema (JSON Schema export), the Stack_Serializer and Stack_Parser with Canonical_JSON, Operations and Operation_Schemas, the Render_Model_Builder, the Remix_Function, the Stack_Factory, any AI call, any network call other than loading the app itself, persistence, share links, the AI-edit mode, sound, dialogs, draggable windows, and moving or resizing Objects. The slice does not run a Card's `onOpen` Handler when the user opens the Card; the validator checks `onOpen`, and a later spec adds its execution.

**Known format limits that the slice exposes.** The Stack_Format has no conditionals, so the Demo_Stack's add button appends the current field text even when that text is empty. The slice states its limits to the user in the interface (no saving, no AI yet).

**Constraints inherited from steering.** TypeScript strict mode; Zod 4 as the single source of schemas and types; pure functions with no mutation of inputs; expected failures returned as result values; default-deny parsing at the trust boundary (the bundled stack file and the CLI input file); named exports and package entry points only; the design-language tokens and accessibility rules; the locked tech stack.

## Glossary

Terms of the `stack-format-and-validator` and `stack-engine` specs (Stack, Card, Object, Button, Field, List, Link, Action, Handler, Entity_ID, Validation_Error, Effect_Request) keep the meaning defined there. This glossary defines the terms that this spec introduces or narrows.

- **Thin_Slice**: The set of deliverables of this spec.
- **Shared_Package**: The workspace package `@hypergeist/shared` in `packages/shared`.
- **Slice_Format**: The subset of the Stack_Format accepted by the slice: Objects of type `button`, `field`, and `list`, and Actions of type `go_to_card`, `set_value`, `append_item`, and `show_message`.
- **Slice_Validator**: The function `validateStack`, exported from `@hypergeist/shared/format`, that checks a candidate against the Slice_Format and returns a Validation_Result.
- **Validation_Result**: The object `{ valid, errors, truncated }` where `valid` and `truncated` are booleans and `errors` is an array of Validation_Errors.
- **Unsupported_Object_Type**: An Object `type` that the full Stack_Format defines but the Slice_Format rejects: `image` or `ai-field`.
- **Unsupported_Action_Type**: An Action `type` that the full Stack_Format defines but the Slice_Format rejects: `remove_item`, `run_ai_field`, `fetch_news`, `transcribe_audio`, or `schedule_notification`.
- **Slice_Executor**: The pure function `executeHandler`, exported from `@hypergeist/shared/engine`, that runs a Handler against a Stack and returns an Execution_Result.
- **Execution_Result**: The object `{ stack, effects, navigateTo?, messages }` where `stack` is a Stack, `effects` is an array of Effect_Requests, `navigateTo` is an optional Card Entity_ID, and `messages` is an array of strings.
- **Demo_Stack**: The bundled JSON file `apps/web/src/stacks/thin-slice-todo.json` that holds the to-do Stack.
- **Stack_CLI**: The command `pnpm stack validate <file>`, implemented in `scripts/stack/cli.ts`.
- **Web_App**: The React application in `apps/web`.
- **Stack_Store**: The single Zustand store in the Web_App that holds the running Stack, the current Card, the Mode, the Selection, and the current Status_Message.
- **Mode**: The Web_App state that is either Interact_Mode or Edit_Mode.
- **Interact_Mode**: The Mode in which Buttons run Handlers, Fields accept typing, Lists display items, and Links navigate.
- **Edit_Mode**: The Mode in which activating an Object selects the Object and no Handler runs.
- **Selection**: The Object that is currently selected in Edit_Mode, or none.
- **Property_Readout**: A read-only panel that lists the properties of the Selection.
- **Menu_Bar**: The bar at the top of the desktop that holds the Spirit Menu glyph, the heading "HyperGeist", and the Mode_Control.
- **Mode_Control**: The segmented control in the Menu_Bar with the options "Interact" and "Edit".
- **Stack_Window**: The single window that shows one Card of the running Stack, with a title bar, the Canvas, and the Status_Bar.
- **Canvas**: The area of the Stack_Window in which the Objects of the current Card are drawn at the Stack's `cardWidth` and `cardHeight`.
- **Canvas_Scale**: The whole-number multiplier (1, 2, or 3) applied to the Canvas.
- **Status_Bar**: The bar at the bottom of the Stack_Window that shows the card position, the Mode, and the Hint_Line.
- **Hint_Line**: The text region of the Status_Bar that shows a hint for the current Mode or a Status_Message.
- **Status_Message**: Text produced by a `show_message` Action or by the Slice_Executor in `messages`, shown in the Hint_Line.
- **Ghost_Window**: The window docked at the bottom right of the desktop that shows the inert sleeping Ghost.
- **Tokens_File**: The file `apps/web/src/styles/tokens.css`.
- **Property_Test**: A fast-check test that takes its seed from `packages/shared/test-support/seed.ts`.

## Requirements

### Requirement 1: Subset contract with the full specs

**User Story:** As the author of the full specs, I want the slice to reuse the exact names, bounds, and codes, so that I can extend the same schemas without breaking changes.

#### Acceptance Criteria

1. THE Shared_Package SHALL export from `@hypergeist/shared/format` Zod 4 schemas for Stack, Card, Link, Button, Field, List, each Action type of the Slice_Format, and Handler, and SHALL derive every exported TypeScript type for those schemas with `z.infer`.
2. THE Shared_Package SHALL export from `@hypergeist/shared/format` the constant `SUPPORTED_OBJECT_TYPES` equal to `["button", "field", "list"]` and the constant `SUPPORTED_ACTION_TYPES` equal to `["go_to_card", "set_value", "append_item", "show_message"]`.
3. THE Shared_Package SHALL export from `@hypergeist/shared/format` the constant `LIMITS` that holds every numeric bound stated in Requirements 2, 3, and 4, and the constant `ENTITY_ID_PATTERN` equal to the pattern `^[a-z0-9][a-z0-9_-]{0,63}$`.
4. THE Slice_Validator SHALL use for each Validation_Error one of these codes: `INVALID_JSON`, `MISSING_PROPERTY`, `UNKNOWN_PROPERTY`, `WRONG_TYPE`, `INVALID_VALUE`, `DUPLICATE_ID`, `DANGLING_REFERENCE`, `WRONG_REFERENCE_TYPE`, `OUT_OF_BOUNDS`, `LIMIT_EXCEEDED`, `UNSUPPORTED_VERSION`, or `DUPLICATE_LINK`.
5. THE Shared_Package SHALL export a type for Validation_Error codes that also includes `OUT_OF_RANGE` and `UNKNOWN_ENTITY`, so that the closed code set equals the closed code set of the `stack-format-and-validator` spec.
6. WHEN the test suite runs, THE test suite SHALL assert that each value in `LIMITS`, `SUPPORTED_OBJECT_TYPES`, `SUPPORTED_ACTION_TYPES`, and `ENTITY_ID_PATTERN` equals the value stated in this spec, which equals the value stated in the full specs.
7. THE Shared_Package SHALL define each Zod schema as a strict object schema, so that an unknown property is rejected and never silently removed.
8. THE Shared_Package SHALL expose the Slice_Validator and the schemas only through `@hypergeist/shared/format`, and the Slice_Executor only through `@hypergeist/shared/engine`, with no import of another package's internals.

### Requirement 2: Stack, Card, and Link structure

**User Story:** As a stack author, I want the same document structure as the full format, so that a slice stack stays valid in later releases.

#### Acceptance Criteria

1. THE Slice_Validator SHALL require a Stack to have the properties `formatVersion`, `id`, `name`, `cardWidth`, `cardHeight`, `startCardId`, and `cards`, and SHALL accept the optional property `remixedFrom`.
2. THE Slice_Validator SHALL require `formatVersion` to equal the integer 1, `name` to be a string of 1 through 100 characters, and `cardWidth` and `cardHeight` to be integers from 64 through 4096.
3. THE Slice_Validator SHALL require `cards` to hold 1 through 200 Cards, and `startCardId` to equal the `id` of a Card in the Stack.
4. THE Slice_Validator SHALL require a Card to have the properties `id`, `name`, `objects`, `links`, and `onOpen`, with `name` of 1 through 100 characters, `objects` holding 0 through 100 Objects, `links` holding 0 through 50 Links, and `onOpen` being a Handler.
5. THE Slice_Validator SHALL require a Link to have the properties `id`, `label`, and `targetCardId`, with `label` of 1 through 100 characters and `targetCardId` equal to the `id` of a Card in the Stack.
6. THE Slice_Validator SHALL require every Entity_ID of a Card, Object, and Link, and the Stack `id` and `remixedFrom`, to match `ENTITY_ID_PATTERN`.
7. WHEN an array holds more elements than its maximum, or a string holds more Unicode code points than its maximum, THE Slice_Validator SHALL return one Validation_Error with the code `LIMIT_EXCEEDED` and a `path` that points to that array or string.
8. WHEN a required property is absent, THE Slice_Validator SHALL return a Validation_Error with the code `MISSING_PROPERTY` and a `path` that points to the nearest existing ancestor.
9. WHEN a property has a value of the wrong JSON type, THE Slice_Validator SHALL return a Validation_Error with the code `WRONG_TYPE` and a `path` that points to that property.
10. WHEN a property that is not defined for its Stack, Card, Object, Link, or Action is present, THE Slice_Validator SHALL return a Validation_Error with the code `UNKNOWN_PROPERTY` and a `path` that points to that property.
11. WHEN a value has the correct JSON type but violates a minimum, a pattern, or an enumeration that is not a maximum length or count, THE Slice_Validator SHALL return a Validation_Error with the code `INVALID_VALUE` and a `path` that points to that value.

### Requirement 3: Slice Objects

**User Story:** As a stack author, I want buttons, fields, and lists with the same properties as the full format, so that a to-do stack can be built from them.

#### Acceptance Criteria

1. THE Slice_Validator SHALL require every Object to have the properties `id`, `type`, `name`, `x`, `y`, `width`, and `height`, with `name` of 0 through 100 characters, `x` and `y` integers from 0 through 4096, and `width` and `height` integers from 8 through 4096.
2. THE Slice_Validator SHALL require a Button to have the additional properties `label` (1 through 100 characters) and `onClick` (a Handler).
3. THE Slice_Validator SHALL require a Field to have the additional properties `value` (0 through 10,000 characters), `placeholder` (0 through 200 characters), `multiline` (boolean), and `readOnly` (boolean).
4. THE Slice_Validator SHALL require a List to have the additional properties `items` (an array of 0 through 500 strings, each of 0 through 500 characters) and `ordered` (boolean).
5. IF the sum of an Object's `x` and `width` exceeds the Stack `cardWidth`, or the sum of its `y` and `height` exceeds the Stack `cardHeight`, THEN THE Slice_Validator SHALL return one Validation_Error with the code `OUT_OF_BOUNDS` and a `path` that points to that Object, once per Object.
6. WHEN the sum of an Object's `x` and `width` equals `cardWidth` and the sum of its `y` and `height` equals `cardHeight`, THE Slice_Validator SHALL report no `OUT_OF_BOUNDS` error for that Object.

### Requirement 4: Slice Handlers and Actions

**User Story:** As a stack author, I want a small closed set of declarative actions, so that buttons can add items, clear fields, show messages, and navigate.

#### Acceptance Criteria

1. THE Slice_Validator SHALL require a Handler to be an array of 0 through 20 Actions.
2. THE Slice_Validator SHALL require a `go_to_card` Action to have the property `cardId`, which references a Card in the Stack.
3. THE Slice_Validator SHALL require a `set_value` Action to have the property `targetObjectId`, which references a Field, and exactly one of `value` (0 through 10,000 characters) or `fromObjectId`, which references a Field or a List.
4. THE Slice_Validator SHALL require an `append_item` Action to have the property `targetObjectId`, which references a List, and exactly one of `item` (0 through 500 characters) or `fromObjectId`, which references a Field.
5. THE Slice_Validator SHALL require a `show_message` Action to have the property `text` of 1 through 500 characters.
6. IF an Action has both or neither of the properties of an exactly-one-of pair, THEN THE Slice_Validator SHALL return one Validation_Error with the code `INVALID_VALUE` and a `path` that points to the Action.
7. IF a reference property holds an Entity_ID that is not the Entity_ID of any Card, Object, or Link in the Stack, THEN THE Slice_Validator SHALL return one Validation_Error with the code `DANGLING_REFERENCE` and a `path` that points to the reference property.
8. IF a reference property holds the Entity_ID of an existing entity that is not permitted for that property by criteria 2 through 4, THEN THE Slice_Validator SHALL return one Validation_Error with the code `WRONG_REFERENCE_TYPE` and a `path` that points to the reference property.
9. WHEN a Handler holds more than 20 Actions, THE Slice_Validator SHALL return one Validation_Error with the code `LIMIT_EXCEEDED` and a `path` that points to the Handler.

### Requirement 5: Rejection of unsupported types

**User Story:** As the author of the full specs, I want unsupported Object and Action types rejected with a clear error, so that the full specs can add them to the same schemas.

#### Acceptance Criteria

1. IF an Object has a `type` that is an Unsupported_Object_Type, THEN THE Slice_Validator SHALL return one Validation_Error with the code `INVALID_VALUE`, a `path` that points to the `type` property of that Object, a `message` that names the type and states that the type is not supported in this release, and a `hint` that lists the values of `SUPPORTED_OBJECT_TYPES`.
2. IF an Action has a `type` that is an Unsupported_Action_Type, THEN THE Slice_Validator SHALL return one Validation_Error with the code `INVALID_VALUE`, a `path` that points to the `type` property of that Action, a `message` that names the type and states that the type is not supported in this release, and a `hint` that lists the values of `SUPPORTED_ACTION_TYPES`.
3. IF an Object `type` or an Action `type` is neither a supported type nor an Unsupported_Object_Type or Unsupported_Action_Type, THEN THE Slice_Validator SHALL return one Validation_Error with the code `INVALID_VALUE`, a `path` that points to the `type` property, and a `message` that states that the type is unknown.
4. WHEN the Slice_Validator reports an error under criterion 1, 2, or 3, THE Slice_Validator SHALL report no other property-level Validation_Error for the same Object or Action.
5. THE test suite SHALL include one example-based test for each Unsupported_Object_Type and each Unsupported_Action_Type that asserts the code, the `path`, and that the `message` states that the type is not supported in this release.

### Requirement 6: Validation result and errors

**User Story:** As the AI repair loop and the CLI user, I want structured, deterministic validation errors, so that every failure says what to fix.

#### Acceptance Criteria

1. WHEN a candidate is submitted, THE Slice_Validator SHALL return a Validation_Result and SHALL NOT throw an exception.
2. WHEN a candidate is a valid Slice_Format Stack, THE Slice_Validator SHALL return `valid` equal to true, an empty `errors` array, and `truncated` equal to false.
3. THE Slice_Validator SHALL give each Validation_Error a `code`, a `path` that is a JSON Pointer (RFC 6901) with the root path `""`, a non-empty `message`, a non-empty `expected`, a non-empty `hint` that states one concrete correction, and an `actual` that is the offending value serialized as JSON and cut to its first 200 characters, or null when the property is absent.
4. WHEN a candidate has between 2 and 100 violations inclusive, THE Slice_Validator SHALL return one Validation_Error for each violation and `truncated` equal to false.
5. IF a candidate has more than 100 violations, THEN THE Slice_Validator SHALL return exactly the first 100 Validation_Errors and `truncated` equal to true.
6. THE Slice_Validator SHALL order Validation_Errors by the document order of their `path`, breaking ties by `code` in ascending code-point order.
7. WHEN the candidate is a string, THE Slice_Validator SHALL treat the string as JSON text.
8. IF the candidate is text that is not well-formed JSON, THEN THE Slice_Validator SHALL return `valid` equal to false and one Validation_Error with the code `INVALID_JSON` and the path `""`.
9. IF the candidate text is longer than 2,097,152 bytes in UTF-8, THEN THE Slice_Validator SHALL return one Validation_Error with the code `LIMIT_EXCEEDED` and the path `""` without parsing the text.
10. IF the parsed candidate is not a JSON object, THEN THE Slice_Validator SHALL return `valid` equal to false and one Validation_Error with the code `WRONG_TYPE` and the path `""`.
11. IF the `formatVersion` of the candidate is an integer other than 1, THEN THE Slice_Validator SHALL return `valid` equal to false and one Validation_Error with the code `UNSUPPORTED_VERSION`, the path `/formatVersion`, and a `hint` that names the supported version 1.
12. IF the Stack, serialized as JSON with two-space indentation and a trailing newline, is longer than 2,097,152 bytes in UTF-8, THEN THE Slice_Validator SHALL return one Validation_Error with the code `LIMIT_EXCEEDED` and the path `""`.
13. IF the candidate has at least one violation, THEN THE Slice_Validator SHALL return `valid` equal to false and a non-empty `errors` array.
14. THE Slice_Validator SHALL return deeply equal results for every call with the same candidate, SHALL leave the candidate unmodified, and SHALL perform no I/O.

### Requirement 7: Semantic validation

**User Story:** As a stack consumer, I want cross-entity rules checked, so that a valid stack never breaks the interface.

#### Acceptance Criteria

1. IF an Entity_ID appears earlier in document order, THEN THE Slice_Validator SHALL return one Validation_Error with the code `DUPLICATE_ID` and a `path` that points to the `id` property of the later occurrence, where document order is Cards in array order and, within each Card, the Card `id`, then the Object `id` values in `objects` order, then the Link `id` values in `links` order.
2. IF the `startCardId` or a Link `targetCardId` holds an Entity_ID that is not the Entity_ID of any entity in the Stack, THEN THE Slice_Validator SHALL return one Validation_Error with the code `DANGLING_REFERENCE` and a `path` that points to that property.
3. IF the `startCardId` or a Link `targetCardId` holds the Entity_ID of an Object or Link, THEN THE Slice_Validator SHALL return one Validation_Error with the code `WRONG_REFERENCE_TYPE` and a `path` that points to that property.
4. IF a Link has the same `targetCardId` as an earlier Link in the same Card, THEN THE Slice_Validator SHALL return one Validation_Error with the code `DUPLICATE_LINK` and a `path` that points to the `targetCardId` property of the later Link.
5. WHERE a Link in a Card names that same Card as `targetCardId`, THE Slice_Validator SHALL accept the Link.
6. WHERE Links in different Cards have the same `targetCardId`, THE Slice_Validator SHALL accept the Links.

### Requirement 8: Action execution

**User Story:** As a UI developer, I want a pure way to run a button's actions, so that interaction logic is tested without a browser.

#### Acceptance Criteria

1. WHEN the Slice_Executor receives a valid Stack and a valid Handler, THE Slice_Executor SHALL run the Actions in array order, each Action operating on the Stack produced by the preceding Actions, and SHALL return an Execution_Result.
2. WHEN a Handler has zero Actions, THE Slice_Executor SHALL return a Stack deeply equal to the input Stack, an empty `effects` array, an empty `messages` array, and no `navigateTo` property.
3. THE Slice_Executor SHALL return an `effects` array that is empty for every input.
4. WHEN a `set_value` Action executes with `value`, THE Slice_Executor SHALL set the `value` of the target Field to the supplied string.
5. WHEN a `set_value` Action executes with `fromObjectId`, THE Slice_Executor SHALL set the `value` of the target Field to the current text of the source Object, where the current text of a List is its `items` joined by newline characters and the current text of a Field is its `value`.
6. WHEN an `append_item` Action executes and the target List holds fewer than 500 items, THE Slice_Executor SHALL append one item to the end of `items`, where the item text is `item` when supplied and otherwise the current text of the Field named by `fromObjectId`.
7. IF an `append_item` Action executes against a List that holds 500 items, THEN THE Slice_Executor SHALL leave the List unchanged and append one entry to `messages` that states that the List is full.
8. WHEN a `show_message` Action executes, THE Slice_Executor SHALL append the `text` to the end of `messages`.
9. WHEN a `go_to_card` Action executes, THE Slice_Executor SHALL set `navigateTo` to the `cardId` and skip the remaining Actions, and SHALL retain the Stack changes and `messages` produced by the preceding Actions.
10. IF an Action would produce a Stack that fails the Slice_Validator, THEN THE Slice_Executor SHALL skip that Action, leave the Stack unchanged by that Action, append one entry to `messages` that states that the Action was skipped, and continue with the next Action.
11. IF the Stack fails the Slice_Validator, THEN THE Slice_Executor SHALL run no Action and SHALL return the input Stack, an empty `effects` array, no `navigateTo` property, and a `messages` array with one entry that states that the Stack is invalid.
12. IF the Handler fails the Handler rules of Requirement 4 against the Stack, THEN THE Slice_Executor SHALL run no Action and SHALL return the input Stack, an empty `effects` array, no `navigateTo` property, and a `messages` array with one entry that states that the Handler is invalid.
13. THE Slice_Executor SHALL evaluate each Action at most once per call, SHALL leave the input Stack and the input Handler deeply equal to their state before the call, and SHALL perform no network, storage, timer, clock, random, or user-interface access.
14. THE Slice_Executor SHALL return deeply equal results for every call with the same Stack and Handler.
15. THE test suite SHALL include at least one example-based test for each Action type of the Slice_Format that asserts the resulting Stack, `messages`, `navigateTo`, and `effects`.

### Requirement 9: Demo stack

**User Story:** As a user opening the app, I want a small working to-do stack, so that the slice shows a real, playable stack.

#### Acceptance Criteria

1. THE Demo_Stack SHALL be a JSON file at `apps/web/src/stacks/thin-slice-todo.json` that the Slice_Validator reports as valid.
2. THE Demo_Stack SHALL have `cardWidth` equal to 512, `cardHeight` equal to 342, and exactly 3 Cards named "To-do", "About", and "Limits", with the "To-do" Card as the start Card.
3. THE Demo_Stack "To-do" Card SHALL hold one Field (empty `value`, a non-empty `placeholder`), one Button with the label "Add", and one List with an empty `items` array.
4. THE Demo_Stack Button "Add" SHALL have an `onClick` Handler of exactly three Actions in this order: an `append_item` Action with the List as `targetObjectId` and the Field as `fromObjectId`, a `set_value` Action with the Field as `targetObjectId` and `value` equal to the empty string, and a `show_message` Action with non-empty `text`.
5. THE Demo_Stack "To-do" Card SHALL hold one Link to the "About" Card.
6. THE Demo_Stack "About" Card SHALL hold a read-only multi-line Field that describes the stack, a Button with a `go_to_card` Action to the "To-do" Card, and a Link to the "Limits" Card.
7. THE Demo_Stack "Limits" Card SHALL hold a read-only multi-line Field that states that changes are not saved, that AI arrives in a later release, and that adding an empty field appends an empty item, and a Button with a `go_to_card` Action to the "About" Card.
8. THE Demo_Stack SHALL hold only Objects of type `button`, `field`, and `list`, and only Actions of the Slice_Format.
9. THE test suite SHALL include a test that reads the Demo_Stack file, passes its text to the Slice_Validator, and asserts `valid` equal to true.

### Requirement 10: Stack CLI

**User Story:** As a stack author or AI agent, I want to validate a stack file from the command line, so that I can read structured errors and a clear exit code.

#### Acceptance Criteria

1. THE root `package.json` SHALL define the script `"stack": "node scripts/stack/cli.ts"`.
2. THE Stack_CLI SHALL run through the native TypeScript support of Node (the versions in `engines.node`) with no build step, no loader flag, and no third-party dependency, and SHALL import the Slice_Validator from `@hypergeist/shared/format`.
3. WHEN the user runs `pnpm stack validate <file>` and the file holds a valid Slice_Format Stack, THE Stack_CLI SHALL print the Validation_Result as JSON with two-space indentation to standard output and exit with code 0.
4. WHEN the user runs `pnpm stack validate <file>` and the file does not hold a valid Slice_Format Stack, THE Stack_CLI SHALL print the Validation_Result as JSON with two-space indentation to standard output, with every Validation_Error carrying `code`, `path`, `message`, `expected`, `actual`, and `hint`, and exit with code 1.
5. IF the file holds text that is not well-formed JSON, THEN THE Stack_CLI SHALL print a Validation_Result with one Validation_Error with the code `INVALID_JSON` and exit with code 1.
6. IF the file path is missing, the file cannot be read, or the subcommand is not `validate`, THEN THE Stack_CLI SHALL print a one-line usage or read error to standard error, print nothing to standard output, and exit with code 2.
7. THE Stack_CLI SHALL read the file as UTF-8 text and pass the text to the Slice_Validator without parsing the text first.
8. THE Stack_CLI SHALL leave the input file unmodified and make no network call.
9. THE test suite SHALL include a test that runs the Stack_CLI as a child process against the Demo_Stack and asserts exit code 0, against an invalid fixture file and asserts exit code 1 and a Validation_Error with each of the six properties, and against a missing file and asserts exit code 2.
10. WHERE a module of the Shared_Package is loaded by the Stack_CLI, THE Shared_Package SHALL write its relative import specifiers with explicit `.ts` extensions and use only syntax that Node type stripping supports.

### Requirement 11: Web app startup and load errors

**User Story:** As a user, I want the app to open directly onto the to-do stack, and a clear message if the bundled stack is broken.

#### Acceptance Criteria

1. WHEN the Web_App starts, THE Web_App SHALL pass the text of the Demo_Stack to the Slice_Validator before rendering any Card.
2. WHEN the Slice_Validator reports `valid` equal to true at startup, THE Web_App SHALL load the Stack into the Stack_Store, set the current Card to the Card named by `startCardId`, set the Mode to Interact_Mode, and set the Selection to none.
3. IF the Slice_Validator reports `valid` equal to false at startup, THEN THE Web_App SHALL render a plain-language error screen that lists the `code`, `path`, and `message` of each reported Validation_Error and SHALL render no Stack_Window.
4. THE Web_App SHALL make no network request other than requests to the origin that serves the Web_App.
5. THE Web_App SHALL keep the heading "HyperGeist" visible in the Menu_Bar as an element with the heading role.

### Requirement 12: Retro shell, tokens, and fonts

**User Story:** As a user, I want a 1-bit retro desktop that matches the design language, so that the slice looks like the product.

#### Acceptance Criteria

1. THE Tokens_File SHALL define every design token of the `design-language` steering, including `--ink`, `--paper`, `--ghost`, `--px`, `--border`, `--shadow-offset`, `--menubar-h`, `--titlebar-h`, `--radius`, `--font-ui`, `--font-mono`, `--dither-50`, `--dither-25`, `--dither-75`, and `--stripe`.
2. THE Web_App SHALL take every color, length, and font family used in a CSS file from tokens defined in the Tokens_File.
3. THE test suite SHALL include a test that scans every CSS file under `apps/web/src` other than the Tokens_File and fails when the file holds a color literal, a font-family literal, or a length literal with the unit `px`, `rem`, or `em`.
4. THE Web_App SHALL render all content with the two colors `--ink` and `--paper`, and SHALL use dither tokens in place of gray, gradient, blur, opacity tint, or soft shadow.
5. THE Web_App SHALL render no element in the color `--ghost`, and no CSS rule outside the Tokens_File SHALL reference `--ghost`.
6. THE Web_App SHALL draw the desktop background with `--dither-50`, the active title bar of the Stack_Window with `--stripe`, and the Stack_Window with a `--border` ink border, a `--shadow-offset` solid ink shadow, a paper fill, and no rounded corners other than the chamfer allowed by `--radius`.
7. THE Web_App SHALL self-host the fonts Pixelify Sans and VT323 through the packages `@fontsource/pixelify-sans` and `@fontsource/vt323`, use Pixelify Sans for interface text and VT323 for the Hint_Line and the Ghost_Window text, and make no request to an external font server.
8. THE Web_App SHALL set `-webkit-font-smoothing: none` and `font-smooth: never` on the desktop and use font sizes of 12, 16, 24, or 32 pixels only.
9. THE Web_App SHALL set the Canvas_Scale to the largest whole number from 1 through 3 for which the Canvas at that scale fits the width and height of the Stack_Window area, and to 1 when no larger scale fits, and SHALL render the Canvas with `image-rendering: pixelated`.
10. WHEN the Canvas_Scale is 1, 2, or 3, THE Web_App SHALL render each Object at the position and size stored in the Stack multiplied by the Canvas_Scale.
11. THE Web_App SHALL give each interactive element a hit area of at least 24 by 24 pixels, defined by a token.
12. THE Web_App SHALL write titles in sentence case and menu items in Title Case, and SHALL use no emoji in the interface chrome.

### Requirement 13: Mode control and Mode display

**User Story:** As a user, I want to see and switch the mode at all times, so that I always know whether I am using or inspecting the stack.

#### Acceptance Criteria

1. THE Web_App SHALL render the Mode_Control in the Menu_Bar with the options "Interact" and "Edit", and SHALL expose the selected option to assistive technology.
2. THE Web_App SHALL show the current Mode as text in the Status_Bar.
3. WHEN the user activates an option of the Mode_Control, THE Stack_Store SHALL set the Mode to that option and set the Selection to none.
4. WHEN the user presses Alt+M, THE Stack_Store SHALL switch the Mode to the other Mode and set the Selection to none.
5. WHILE the Mode is Interact_Mode, THE Web_App SHALL use the pointer cursor over the Canvas, and WHILE the Mode is Edit_Mode, THE Web_App SHALL use the crosshair cursor over the Canvas.
6. WHEN the Mode changes, THE Hint_Line SHALL show the hint for the new Mode, and the hint for Interact_Mode and the hint for Edit_Mode SHALL differ.
7. THE Hint_Line for each Mode SHALL name the Alt+M shortcut.

### Requirement 14: Interact mode behavior

**User Story:** As a user, I want to type, press buttons, and read lists, so that the to-do stack works.

#### Acceptance Criteria

1. WHILE the Mode is Interact_Mode, WHEN the user activates a Button by click, Enter, or Space, THE Web_App SHALL call the Slice_Executor with the running Stack and the `onClick` Handler of the Button, store the returned Stack in the Stack_Store, and show the returned `messages` as the Status_Message.
2. WHILE the Mode is Interact_Mode, WHEN the user types in a Field whose `readOnly` is false, THE Web_App SHALL update the `value` of that Field in the Stack_Store by calling the Slice_Executor with a single `set_value` Action that has the typed text as `value`.
3. WHILE the Mode is Interact_Mode, THE Web_App SHALL render a Field whose `readOnly` is true with the `--dither-50` background and SHALL reject typing in that Field.
4. THE Web_App SHALL render a Field with `multiline` equal to true as a multi-line text control, and a Field with `multiline` equal to false as a single-line text control.
5. THE Web_App SHALL render a List as an ordered list when `ordered` is true and as an unordered list when `ordered` is false, with one entry for each item in `items` in array order, and SHALL render an empty List as an empty region.
6. WHEN the Slice_Executor returns a `navigateTo` value, THE Stack_Store SHALL set the current Card to that Card.
7. WHEN the user activates a Link in Interact_Mode, THE Stack_Store SHALL set the current Card to the `targetCardId` of the Link.
8. WHEN the current Card changes, THE Stack_Store SHALL set the Selection to none and the Status_Bar SHALL show the new card position in the form "Card 2 of 3".
9. WHEN the Slice_Executor returns a Stack that differs from the running Stack, THE Web_App SHALL draw the returned Stack within one animation frame without a page reload.
10. WHERE a List holds more items than fit in its height, THE Web_App SHALL let the List scroll within its bounds and SHALL make the List reachable by keyboard.

### Requirement 15: Status messages

**User Story:** As a user, I want feedback from a button in the status bar, so that I see what happened without a dialog.

#### Acceptance Criteria

1. WHEN the Slice_Executor returns a non-empty `messages` array after a user action, THE Web_App SHALL replace the text of the Hint_Line with the entries of `messages` in order, separated by one space.
2. WHEN a Status_Message has been shown for 4 seconds, THE Web_App SHALL restore the Hint_Line to the hint of the current Mode.
3. WHEN the user performs another action before 4 seconds have passed, where an action is a Button activation, a Link activation, a Card change, or a Mode change, THE Web_App SHALL replace the Status_Message with the result of that action and restart the 4-second period for any new Status_Message.
4. THE Web_App SHALL expose the Hint_Line as a polite live region, so that assistive technology announces each Status_Message.
5. THE Web_App SHALL show each Status_Message in the Hint_Line and in no modal dialog.
6. WHEN the Slice_Executor returns an empty `messages` array, THE Web_App SHALL leave the Hint_Line text unchanged.

### Requirement 16: Edit mode behavior

**User Story:** As a user, I want to select an object and read its properties, so that I can see how a stack is built.

#### Acceptance Criteria

1. WHILE the Mode is Edit_Mode, WHEN the user activates an Object by click, Enter, or Space, THE Stack_Store SHALL set the Selection to that Object and the Web_App SHALL run no Handler.
2. WHILE the Mode is Edit_Mode, THE Web_App SHALL ignore typing in Fields and Link activations, so that the running Stack and the current Card stay unchanged.
3. WHILE the Selection is an Object, THE Web_App SHALL draw a dashed `--ink` selection outline around the Object and 8 square resize handles at the corners and edge midpoints of the Object.
4. WHILE the Selection is an Object, THE Web_App SHALL render the 8 handles as non-interactive elements that start no drag and no resize.
5. WHILE the Selection is an Object, THE Web_App SHALL show the Property_Readout with the `id`, `type`, `name`, `x`, `y`, `width`, and `height` of the Object and every type-specific property of the Object, as read-only text.
6. WHILE the Selection is none in Edit_Mode, THE Web_App SHALL show the Property_Readout with a prompt to select an Object.
7. WHEN the user presses Escape in Edit_Mode, THE Stack_Store SHALL set the Selection to none.
8. WHILE the Mode is Edit_Mode, THE Web_App SHALL show a hover state on Objects.
9. WHILE the Mode is Interact_Mode, THE Web_App SHALL show no selection outline, no handles, and no Property_Readout.
10. THE Web_App SHALL render the Property_Readout in the Stack_Window as a labelled read-only region that holds no editable control.

### Requirement 17: Ghost window

**User Story:** As a user, I want to see where the AI will live, so that the app states honestly that AI is not here yet.

#### Acceptance Criteria

1. THE Web_App SHALL render the Ghost_Window docked at the bottom right of the desktop with a title bar that reads "Ghost".
2. THE Ghost_Window SHALL show a static sleeping Ghost sprite drawn in `--ink` and `--paper` and the text "AI arrives in a later release" in VT323.
3. THE Ghost_Window SHALL contain no interactive element, no animation, no `--ghost` color, and no text field.
4. THE Ghost_Window SHALL expose an accessible name that states that the Ghost is asleep and that AI arrives in a later release.
5. THE Web_App SHALL keep the Ghost_Window visible in both Modes and on every Card.

### Requirement 18: Persistence honesty

**User Story:** As a user, I want to know that nothing is saved, so that I am not surprised by a reload.

#### Acceptance Criteria

1. THE Web_App SHALL keep the running Stack, current Card, Mode, and Selection in memory only, with no write to IndexedDB, localStorage, sessionStorage, or cookies.
2. WHEN the page reloads, THE Web_App SHALL reload the Demo_Stack from its bundled file and show the start Card in Interact_Mode.
3. THE Web_App SHALL show a notice in the Stack_Window on every Card that states that changes are not saved and that a reload resets the stack.

### Requirement 19: Keyboard access, focus, and motion

**User Story:** As a keyboard user and a user who prefers reduced motion, I want the shell to work without a mouse and without animation.

#### Acceptance Criteria

1. THE Web_App SHALL make every interactive element reachable by Tab in this order: the Mode_Control, then the Objects and Links of the current Card, with Objects in the array order of `objects` followed by Links in the array order of `links`.
2. THE Web_App SHALL show a 2px dashed `--ink` focus outline, defined by tokens, on every focused interactive element.
3. THE Web_App SHALL give each Stack_Window, Menu_Bar, Mode_Control, Canvas, List, Property_Readout, and Ghost_Window an ARIA role or a semantic element and an accessible name.
4. THE Web_App SHALL give each Object an accessible name taken from its `name` when non-empty, and otherwise from its `label` or `placeholder`, and otherwise from its `id`.
5. WHERE the user agent reports `prefers-reduced-motion: reduce`, THE Web_App SHALL run no CSS animation and no CSS transition.
6. THE Web_App SHALL keep text at a contrast ratio of at least 4.5:1, using only `--ink` text on `--paper` or `--paper` text on `--ink`.
7. WHEN a Button is pressed, THE Web_App SHALL draw the pressed state as `--ink` fill with `--paper` text.

### Requirement 20: Dependencies and asset licenses

**User Story:** As the project owner, I want only the approved dependencies and a license record for every asset, so that the submission is clean.

#### Acceptance Criteria

1. THE Web_App package `apps/web/package.json` SHALL add the dependencies `zustand`, `@fontsource/pixelify-sans`, and `@fontsource/vt323`, and no other new third-party dependency.
2. THE Stack_CLI and the Slice_Executor SHALL add no third-party dependency to any package.
3. WHERE the Stack_CLI imports `@hypergeist/shared/format`, THE root `package.json` SHALL declare `@hypergeist/shared` as a `workspace:*` development dependency so that the import resolves, which adds no third-party package.
4. THE file `docs/assets-licenses.md` SHALL hold one row for Pixelify Sans and one row for VT323, each with the source URL, the license `SIL Open Font License 1.1`, the use in the Web_App, and the date added.
5. THE file `docs/assets-licenses.md` SHALL hold one row for the sleeping Ghost sprite that states the sprite is original project artwork.
6. THE Web_App SHALL use no third-party trademark, logo, icon, font, or sound.

### Requirement 21: Build, serving, and documentation

**User Story:** As a developer and a reviewer, I want the slice to build, serve, and run locally from documented steps, so that anyone can try it.

#### Acceptance Criteria

1. WHEN `pnpm build` completes, THE directory `apps/web/dist` SHALL hold the Web_App bundle including the font files, so that the Worker serves the built app and the fonts from the app origin.
2. THE Worker SHALL serve the built Web_App at `/`, fall back to the single-page app for an unknown non-API path, and answer `/api/health` with status 200 and `{ "ok": true }`, as before the Thin_Slice.
3. THE README SHALL state how to run the app locally: install dependencies, run `pnpm build`, start the Worker dev server, open `http://localhost:8787`, and optionally start the Vite dev server on port 5173.
4. THE README SHALL document `pnpm stack validate <file>`, including the output format, the exit codes 0, 1, and 2, and an example that validates the Demo_Stack.
5. THE README SHALL list the limits of the slice: no saving, no AI, no Object editing, no `onOpen` execution, and the supported Object and Action types.
6. WHEN the Thin_Slice is complete, THE repository SHALL pass `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm check:deps`, `pnpm format:check`, and `pnpm test:e2e` with exit code 0.
7. THE Thin_Slice SHALL add no import from `apps/web` to `apps/worker`, from `apps/worker` to `apps/web`, from `packages/shared` to an app, or from an app to a Shared_Package file outside `@hypergeist/shared`, `@hypergeist/shared/format`, and `@hypergeist/shared/engine`.

### Requirement 22: Property tests and end-to-end tests

**User Story:** As a developer, I want property and browser tests, so that the slice's invariants hold under many inputs.

#### Acceptance Criteria

1. THE test suite SHALL provide a fast-check generator of arbitrary valid Slice_Format Stacks that covers 1 through 5 Cards, Objects of each supported type, Links, and Handlers of each supported Action type, and SHALL provide a generator of Handlers over a given Stack that includes Actions that the Slice_Executor skips.
2. THE Property_Tests SHALL take their seed and run count from `packages/shared/test-support/seed.ts` and SHALL report the seed and the replay command on failure.
3. FOR ALL valid generated Stacks, THE Slice_Validator SHALL return `valid` equal to true (generator check).
4. FOR ALL valid Stacks and valid Handlers, THE Slice_Executor SHALL leave the input Stack and Handler deeply equal to a deep copy taken before the call (no-mutation property), including when the inputs are deeply frozen.
5. FOR ALL valid Stacks and valid Handlers, THE Stack in the Execution_Result SHALL pass the Slice_Validator (result-validity property).
6. FOR ALL valid Stacks and valid Handlers, THE Slice_Executor SHALL return deeply equal Execution_Results for two calls with the same inputs, and the `effects` array SHALL be empty (determinism property).
7. FOR ALL valid Stacks, THE Slice_Validator SHALL return `valid` equal to true for the text produced by `JSON.stringify` of the Stack, and a parse of that text SHALL be deeply equal to the Stack (JSON round-trip property, which stands in for the serializer round trip because the slice includes no Stack_Serializer).
8. FOR ALL candidates drawn from valid Stacks with one random mutation, THE Slice_Validator SHALL return deeply equal results for two calls with the same candidate (validator determinism property).
9. THE Playwright smoke test SHALL keep its existing three tests passing and SHALL add tests that run against the Worker with no live model and assert: the "HyperGeist" heading, the Mode_Control and the Mode text in the Status_Bar, the Ghost_Window text, and that every request goes to the app origin.
10. THE Playwright smoke test SHALL add a test that types an item in the Field, activates "Add", and asserts that the List shows the item, the Field is empty, and the Hint_Line shows the Status_Message.
11. THE Playwright smoke test SHALL add a test that follows the Link to the "About" Card, uses the Button to return to the "To-do" Card, and asserts the card position text "Card 1 of 3".
12. THE Playwright smoke test SHALL add a test that switches to Edit_Mode, selects the Button, and asserts the selection handles, the Property_Readout values, and that activating the Button adds no list item.
13. THE Playwright smoke test SHALL add a test that adds an item, reloads the page, and asserts that the List is empty and that the not-saved notice is visible.
14. THE Web_App unit tests SHALL cover the Hint_Line 4-second restore with fake timers, the startup error screen for an invalid stack text, the Alt+M shortcut, and the Edit_Mode rule that no Handler runs.

# Requirements Document

## Introduction

This document specifies the second of two subsystems of the Kiroween 2026 project (a HyperCard-inspired, AI-authored "stack" environment): the pure, testable Stack Engine that changes and interprets stacks. This is build priority 1 in the project brief ("Stack format and engine, with tests"), split into two specs. The first spec, `stack-format-and-validator`, defines what a valid stack is and how to check, write, and read one. This spec, `stack-engine`, defines the Operations that change a Stack, the Operation_Schemas that describe those Operations to the AI tool registry, the execution of Handlers, the Render_Model that a UI draws, the remix function, and the Stack_Factory that creates a new Stack. The retro UI shell, the AI orchestrator, and the share and remix services are separate specs.

**Dependency on `stack-format-and-validator`.** This spec depends on the `stack-format-and-validator` spec and does not redefine anything in it. The Stack, Card, Object, Link, Action, and Handler types, the Entity_ID pattern, the Stack_Validator, the Validation_Error structure and its closed set of codes, the Stack_Serializer, the Stack_Parser, Canonical_JSON, and the Stack_Schema are all defined there. Where a criterion in this spec refers to a requirement of that spec, the reference names the `stack-format-and-validator` spec explicitly. The Validation_Error codes `UNKNOWN_ENTITY` and `OUT_OF_RANGE` belong to the closed code set of that spec and are not returned by its Stack_Validator. This spec uses them for rejected Operations and for rejected Render_Model requests.

**Declarative actions and a pure engine.** The Stack_Format uses declarative actions: a closed set of typed action records executed in order, with no conditionals, loops, expressions, or user-written code. This keeps every Action validatable against a schema, which the AI repair loop (D7) needs, and it guarantees that execution always terminates and that shared stacks cannot run arbitrary code, which matters for shareable and remixable stacks (D10). The Stack_Engine stays pure. Actions that need the outside world (AI calls, news fetching, transcription, notifications) are not carried out by the Stack_Engine. The Action_Executor returns them as Effect_Requests, which are plain data, for other subsystems to carry out. The trade-off is that the format cannot express arbitrary logic (for example, computing a running total). Such cases are handled by ai-field objects, or by adding new action types in a later format version.

## Glossary

Format-level terms are defined in the `stack-format-and-validator` spec and are used here with the same meaning: Stack, Card, Object (Button, Field, Image, List, AI_Field), Link, Action, Handler, Entity_ID, Stack_Validator, Validation_Error, Stack_Serializer, Stack_Parser, Canonical_JSON, and Stack_Schema. This glossary defines only the terms that this spec introduces.

- **Stack_Engine**: The pure, deterministic component that applies Operations to a Stack, executes Handlers, builds Render_Models, and remixes Stacks.
- **Operation**: A named, parameterized change to a Stack. The Operations are `create_card`, `delete_card`, `add_object`, `update_object`, `remove_object`, `link_cards`, and `set_action`.
- **Operation_Result**: The value returned by an Operation: either `ok: true` with the new Stack and a `summary`, or `ok: false` with a list of Validation_Errors.
- **Operation_Schema**: A JSON Schema (draft 2020-12) describing the parameters of one Operation, with descriptions written for an AI reader.
- **Action_Executor**: The Stack_Engine component that runs a Handler against a Stack.
- **Effect_Request**: A plain-data description of work that needs the outside world, emitted by the Action_Executor and carried out by another subsystem. The Effect_Request kinds are `run_ai_field`, `fetch_news`, `transcribe_audio`, and `schedule_notification`.
- **Render_Model**: A plain-data description of one Card, derived from a Stack, that a UI can draw without further lookups.
- **Render_Model_Builder**: The Stack_Engine component that derives a Render_Model.
- **Remix_Function**: The Stack_Engine function that copies a Stack under a new `id` and records the `id` of the Stack it was copied from.
- **Stack_Factory**: The Stack_Engine function `create_stack` that creates a new valid Stack from a caller-supplied Stack `id` and `name` and optional card size and first Card values. The Stack_Factory is not an Operation, because it creates a Stack instead of changing an existing one.

## Requirements

### Requirement 1: Operation contract

**User Story:** As the AI orchestrator, I want every engine operation to be atomic, pure, and self-describing, so that a bad tool call cannot corrupt a stack.

#### Acceptance Criteria

1. WHEN an Operation is applied to a valid Stack with valid parameters, THE Stack_Engine SHALL return an Operation_Result with `ok` equal to true and a new Stack that passes the Stack_Validator.
2. IF an Operation is applied with parameters that are invalid or that would produce an invalid Stack, THEN THE Stack_Engine SHALL return an Operation_Result with `ok` equal to false, an array of Validation_Errors containing at least one Validation_Error, and no Stack, and SHALL apply none of the Operation's changes, including when the Operation affects more than one Entity.
3. THE Stack_Engine SHALL leave the input Stack deeply equal, including all nested values, to its state before the Operation was applied, whether the Operation succeeds or fails.
4. THE Stack_Engine SHALL return a deeply equal Operation_Result for every call with the same Stack, Operation name, and parameters, using no clock, random source, or external state.
5. IF the Stack_Engine rejects an Operation, THEN THE Stack_Engine SHALL make no change to any Stack held in persistent storage, so that reading that Stack after the rejection returns a Stack deeply equal to the input Stack.
6. WHEN a creating Operation is applied without the `id` parameter, THE Stack_Engine SHALL assign the Entity_ID `<kind>-<n>`, where `<kind>` is `card`, `obj`, or `link` and `<n>` is the smallest positive integer that produces an Entity_ID unused in the Stack.
7. WHEN an `add_object` Operation is applied without an optional property of the Object type, THE Stack_Engine SHALL store the default value defined for that property: `name` as an empty string, `value` as an empty string, `placeholder` as an empty string, `multiline` as false, `readOnly` as false, `ordered` as false, `items` as an empty array, `inputObjectIds` as an empty array, `alt` as an empty string, and `onClick` as an empty Handler.
8. WHEN an Operation succeeds, THE Stack_Engine SHALL include in the Operation_Result a `summary` containing three arrays, one each for the Entity_IDs created, updated, and removed by the Operation, where each array is empty if the Operation produced no Entity_IDs of that kind and lists each Entity_ID at most once.
9. IF an Operation names a Card, Object, or Link that does not exist in the Stack, THEN THE Stack_Engine SHALL return an Operation_Result with `ok` equal to false, no Stack, and a Validation_Error with the code `UNKNOWN_ENTITY`.
10. THE Stack_Engine SHALL return Validation_Errors for rejected Operations in the same structure defined in Requirement 7 of the `stack-format-and-validator` spec.
11. IF a creating Operation is applied with an `id` parameter equal to an Entity_ID already used in the Stack, THEN THE Stack_Engine SHALL reject the Operation with a Validation_Error with the code `DUPLICATE_ID` that identifies the duplicate Entity_ID, and SHALL NOT overwrite the existing Entity.
12. IF an Operation is requested with a name that is not a defined Operation, THEN THE Stack_Engine SHALL return an Operation_Result with `ok` equal to false, no Stack, and a Validation_Error with the code `INVALID_VALUE` that identifies the unknown Operation name.

### Requirement 2: Card operations

**User Story:** As an AI model building a multi-card app, I want to create and delete cards, so that I can shape the structure of a stack.

#### Acceptance Criteria

1. WHEN a `create_card` Operation supplies a `name` and an optional `id` and `index`, THE Stack_Engine SHALL insert a Card with no Objects, no Links, and an empty `onOpen` Handler at the zero-based position `index` in `cards`, shifting the Cards previously at `index` and after it one position later, or at the end of `cards` when `index` is omitted, and SHALL leave `startCardId` unchanged.
2. IF a `create_card` Operation is applied to a Stack that already contains 200 Cards, THEN THE Stack_Engine SHALL reject the Operation with the code `LIMIT_EXCEEDED`.
3. WHEN a `delete_card` Operation names an existing Card, THE Stack_Engine SHALL remove the Card together with the Objects and Links that the Card owns.
4. WHEN a `delete_card` Operation removes a Card, THE Stack_Engine SHALL remove every Link in the remaining Cards that has the deleted Card as `targetCardId`, and every Action with a `cardId` equal to the deleted Card's Entity_ID from every `onClick` Handler and every `onOpen` Handler in the remaining Cards.
5. WHEN a `delete_card` Operation removes a Card, THE Stack_Engine SHALL remove every Action in the remaining Cards whose `targetObjectId`, `fromObjectId`, or `atFromObjectId` names an Object owned by the deleted Card, and every `inputObjectIds` entry that names such an Object.
6. WHEN a `delete_card` Operation removes the Card named by `startCardId`, THE Stack_Engine SHALL set `startCardId` to the Entity_ID of the Card at position 0 of `cards` after the removal.
7. IF a `delete_card` Operation is applied to a Stack that contains exactly 1 Card, THEN THE Stack_Engine SHALL reject the Operation with the code `LIMIT_EXCEEDED`.
8. WHEN a `delete_card` Operation succeeds, THE Stack_Engine SHALL list in the `summary` the removed Entity_IDs and the number of removed Actions (0 when no Action is removed). The Entity_IDs SHALL be ordered as follows: the deleted Card, then its Objects in array order, then its Links in array order, then the removed Links of the remaining Cards in document order.
9. IF a `create_card` Operation supplies an `index` that is not an integer from 0 through the current number of Cards, THEN THE Stack_Engine SHALL reject the Operation with the code `OUT_OF_RANGE`.
10. IF a `create_card` Operation supplies an `id` that does not match the Entity_ID pattern, THEN THE Stack_Engine SHALL reject the Operation with the code `INVALID_VALUE`. IF the supplied `id` equals an existing Entity_ID in the Stack, THEN THE Stack_Engine SHALL reject the Operation with the code `DUPLICATE_ID`.
11. IF a `create_card` Operation omits `name`, THEN THE Stack_Engine SHALL reject the Operation with the code `MISSING_PROPERTY`. IF `name` is an empty string, THEN THE Stack_Engine SHALL reject the Operation with the code `INVALID_VALUE`. IF `name` is longer than 100 characters, THEN THE Stack_Engine SHALL reject the Operation with the code `LIMIT_EXCEEDED`.

### Requirement 3: Object operations

**User Story:** As an AI model editing a card, I want to add, change, and remove objects, so that I can build and reshape cards through conversation.

#### Acceptance Criteria

1. WHEN an `add_object` Operation supplies a `cardId` that names an existing Card, an Object `type`, and the properties required for that type, THE Stack_Engine SHALL insert the Object into the named Card at the zero-based position `index`, or after the last Object in `objects` when `index` is omitted, and return `ok` equal to true.
2. IF an `add_object` Operation supplies a `type` outside `button`, `field`, `image`, `list`, and `ai-field`, THEN THE Stack_Engine SHALL reject the Operation with the code `INVALID_VALUE`.
3. IF a Card already contains 100 Objects and an `add_object` Operation names that Card, THEN THE Stack_Engine SHALL reject the Operation with the code `LIMIT_EXCEEDED`.
4. WHEN an `update_object` Operation supplies an `objectId` that names an existing Object and a non-empty `changes` object, THE Stack_Engine SHALL replace each named property of the Object with the supplied value, leave all other properties unchanged, and return `ok` equal to true.
5. IF an `update_object` Operation supplies a change to `id` or `type`, THEN THE Stack_Engine SHALL reject the Operation with the code `INVALID_VALUE`.
6. IF an `update_object` Operation supplies a property that the Object type does not define, THEN THE Stack_Engine SHALL reject the Operation with the code `UNKNOWN_PROPERTY`.
7. WHEN an `update_object` Operation supplies an `objectId` that names an existing Object and a `changes` object with zero properties, THE Stack_Engine SHALL return the input Stack unchanged with `ok` equal to true and a `summary` whose three arrays are empty.
8. WHEN a `remove_object` Operation names an existing Object, THE Stack_Engine SHALL remove the Object, remove every Action whose `targetObjectId`, `fromObjectId`, or `atFromObjectId` equals the Object's `id`, remove the Object's `id` from the `inputObjectIds` of every remaining AI_Field, and return `ok` equal to true.
9. WHEN a `remove_object` Operation removes entities other than the named Object, THE Stack_Engine SHALL list the removed Entity_IDs and the number of removed Actions in the `summary`.
10. IF an `add_object` Operation names a `cardId`, or an `update_object` or `remove_object` Operation names an `objectId`, that does not exist in the input Stack, THEN THE Stack_Engine SHALL reject the Operation with the code `UNKNOWN_ENTITY`.
11. IF an `add_object` Operation supplies an `index` that is not an integer from 0 to the current number of Objects in the Card inclusive, THEN THE Stack_Engine SHALL reject the Operation with the code `OUT_OF_RANGE`.
12. IF an `add_object` Operation omits a property required for the `type`, THEN THE Stack_Engine SHALL reject the Operation with the code `MISSING_PROPERTY`. IF an `add_object` Operation supplies a property value that is invalid for that property, or an `update_object` Operation supplies a value that is invalid for the named property, THEN THE Stack_Engine SHALL reject the Operation with the code `INVALID_VALUE`.
13. IF the Stack_Engine rejects an `add_object`, `update_object`, or `remove_object` Operation, THEN THE Stack_Engine SHALL return `ok` equal to false with the error code and leave the input Stack unchanged.

### Requirement 4: Link and action operations

**User Story:** As an AI model wiring up an app, I want to connect cards and attach behaviors to buttons and cards, so that stacks navigate and respond to the user.

#### Acceptance Criteria

1. WHEN a `link_cards` Operation supplies a `fromCardId`, a `toCardId`, a `label` of 1 through 100 characters, and an optional `id`, THE Stack_Engine SHALL append a Link with the supplied values as the last element of the `links` array of the Card named by `fromCardId`, store `toCardId` as the Link's `targetCardId`, and list the new Link's Entity_ID as created in the `summary`, including when `toCardId` equals `fromCardId`.
2. IF a `link_cards` Operation names a `toCardId` that already has a Link in the Card named by `fromCardId`, THEN THE Stack_Engine SHALL reject the Operation with the code `DUPLICATE_LINK`.
3. IF a `link_cards` Operation would make a Card contain more than 50 Links, THEN THE Stack_Engine SHALL reject the Operation with the code `LIMIT_EXCEEDED`.
4. WHEN a `set_action` Operation supplies an `ownerId` and a `handler`, and `ownerId` names a Button, THE Stack_Engine SHALL replace the entire `onClick` Handler of the Button with the supplied Handler, leave all other properties of the Button unchanged, and list the `ownerId` as updated in the `summary`.
5. WHEN a `set_action` Operation supplies an `ownerId` and a `handler`, and `ownerId` names a Card, THE Stack_Engine SHALL replace the entire `onOpen` Handler of the Card with the supplied Handler, leave all other properties of the Card unchanged, and list the `ownerId` as updated in the `summary`.
6. IF a `set_action` Operation names an `ownerId` that exists in the Stack and is neither a Button nor a Card, THEN THE Stack_Engine SHALL reject the Operation with the code `WRONG_REFERENCE_TYPE`.
7. IF a `set_action` Operation supplies a Handler containing an Action that violates Requirement 6 of the `stack-format-and-validator` spec, THEN THE Stack_Engine SHALL reject the Operation with one Validation_Error for each violating Action, each with the `code` and `path` defined in Requirement 7 of the `stack-format-and-validator` spec, and leave the existing Handler of the owner unchanged.
8. FOR ALL Stacks and Handlers, WHEN the same `set_action` Operation is applied twice in succession and the first application returns `ok` equal to true, THE Stack_Engine SHALL return `ok` equal to true for the second application and a Stack equal to the Stack returned by the first application (idempotence).
9. IF a `link_cards` Operation names a `fromCardId` or a `toCardId` that does not exist in the Stack, THEN THE Stack_Engine SHALL reject the Operation with the code `UNKNOWN_ENTITY`.
10. IF a `link_cards` Operation supplies a `label` that is shorter than 1 character or longer than 100 characters, THEN THE Stack_Engine SHALL reject the Operation with the code `INVALID_VALUE`.
11. IF a `link_cards` Operation supplies an `id` equal to any existing Entity_ID in the Stack, THEN THE Stack_Engine SHALL reject the Operation with the code `DUPLICATE_ID`.

### Requirement 5: Action execution

**User Story:** As a UI developer, I want a pure way to run a button's or card's actions, so that interaction logic can be tested without a browser or network.

#### Acceptance Criteria

1. WHEN a Handler is executed against a valid Stack, THE Action_Executor SHALL run the Actions in array order, each Action operating on the Stack as modified by the preceding Actions, and SHALL return the resulting Stack, an array of Effect_Requests in execution order, an optional `navigateTo` Card Entity_ID, and an array of `messages` in execution order. A Handler with zero Actions returns a Stack equal to the input Stack, an empty Effect_Request array, an empty `messages` array, and no `navigateTo`.
2. WHEN a `set_value` Action executes with a `value`, THE Action_Executor SHALL set the `value` property of the target Object to the supplied string.
3. WHEN a `set_value` Action executes with a `fromObjectId`, THE Action_Executor SHALL set the `value` property of the target Object to the current text of the source Object. The current text of a List is its `items` joined by newline characters, and the current text of any other Object is its `value` property, or an empty string if it has none.
4. WHEN an `append_item` Action executes and the target List holds fewer than 500 items, THE Action_Executor SHALL append one item to the end of the `items` of the target List. The item text is the `item` if supplied, otherwise the current text of the Object named by `fromObjectId`.
5. IF an `append_item` Action executes against a List that holds 500 items, THEN THE Action_Executor SHALL leave the List unchanged and append one entry to `messages` stating that the List is full.
6. WHEN a `remove_item` Action executes and `index` is an integer from 0 up to, but not including, the number of items in the target List, THE Action_Executor SHALL remove the item at `index`. The items after it shift down by one position, and their order is preserved.
7. IF a `remove_item` Action executes with an `index` that is negative, not an integer, or greater than or equal to the number of items in the target List, THEN THE Action_Executor SHALL leave the List unchanged and add no entry to `messages`.
8. WHEN a `show_message` Action executes, THE Action_Executor SHALL append the `text` to the end of the returned `messages`.
9. WHEN a `go_to_card` Action executes, THE Action_Executor SHALL set `navigateTo` to the `cardId` and skip the remaining Actions in the Handler. The Stack changes, `messages`, and Effect_Requests produced by the preceding Actions are retained in the result.
10. WHEN a `run_ai_field`, `fetch_news`, `transcribe_audio`, or `schedule_notification` Action executes, THE Action_Executor SHALL append one Effect_Request of the same kind to the end of the Effect_Request array. The Effect_Request contains the Action's parameters and the current text of any referenced source Object, and the Action leaves the Stack unchanged.
11. WHEN a `run_ai_field` Action executes, THE Action_Executor SHALL include in the Effect_Request the `prompt` of the target AI_Field and the current text of each Object named in `inputObjectIds`, in the order listed in `inputObjectIds`.
12. THE Action_Executor SHALL produce a result Stack that passes the Stack_Validator for every valid input Stack and Handler.
13. THE Action_Executor SHALL evaluate each Action in a Handler at most once per Handler execution, and SHALL terminate after evaluating at most as many Actions as the Handler contains.
14. THE Action_Executor SHALL perform no network, storage, timer, or user-interface access.
15. THE Action_Executor SHALL leave the input Stack unmodified.
16. IF a Handler is executed against a Stack that fails the Stack_Validator, THEN THE Action_Executor SHALL run no Actions and SHALL return the input Stack unchanged, an empty Effect_Request array, no `navigateTo`, and a `messages` array containing one entry indicating that the Stack is invalid.
17. IF an Action names an Object ID that does not exist in the Stack, targets an Object whose type the Action does not support, or would produce a result Stack that fails the Stack_Validator, THEN THE Action_Executor SHALL skip that Action, leave the Stack unchanged by it, append one entry to `messages` indicating that the Action was skipped, and continue with the next Action in the Handler.

### Requirement 6: Render model

**User Story:** As a UI developer, I want a plain description of a card ready to draw, so that any valid stack renders without special cases.

#### Acceptance Criteria

1. WHEN a Card Entity_ID of a valid Stack is supplied, THE Render_Model_Builder SHALL return a Render_Model containing the Stack `cardWidth` and `cardHeight`, the Card `id` and `name`, every Object of the Card with every property of the Object in the array order of the Card's `objects` (first Object at the back, last Object at the front), and every Link of the Card in the array order of the Card's `links` with every property of the Link plus the `name` of the target Card named by `targetCardId`.
2. THE Render_Model_Builder SHALL return a Render_Model for every Card of every valid Stack without raising an error, including a Card with 0 Objects or 0 Links (returned as empty arrays) and a Card with the maximum of 100 Objects and 50 Links.
3. THE Render_Model_Builder SHALL include in the Render_Model for each AI_Field a list of Object `id` and `name` pairs, one pair for each entry of the AI_Field's `inputObjectIds`, in the same order as `inputObjectIds`, and an empty list when `inputObjectIds` is empty.
4. IF the supplied Entity_ID does not equal the Entity_ID of a Card in the Stack, including an Entity_ID that belongs to an Object or Link, THEN THE Render_Model_Builder SHALL return a Validation_Error with the code `UNKNOWN_ENTITY` and no Render_Model.
5. THE Render_Model_Builder SHALL return a Render_Model composed only of objects, arrays, strings, numbers, and booleans, so that serializing it to JSON and parsing the result yields a value deeply equal to the Render_Model, with no functions, `undefined` values, circular references, or references to the input Stack.
6. FOR ALL valid Stacks, THE Render_Model_Builder SHALL return Render_Models in which every Object lies within the card bounds defined in Requirement 3, criterion 5 of the `stack-format-and-validator` spec, with each Object's position and size equal to the values stored in the Stack and not clipped or adjusted.
7. THE Render_Model_Builder SHALL leave the input Stack deeply equal to its state before the call, and changing the returned Render_Model SHALL NOT change the input Stack.

### Requirement 7: Remix

**User Story:** As the share and remix features, I want a pure function that copies a stack under a new identity, so that a shared stack can be remixed without any change to the stack format.

#### Acceptance Criteria

1. WHEN a valid Stack and a new Stack `id` that matches the Entity_ID pattern of Requirement 2, criterion 1 of the `stack-format-and-validator` spec are supplied to the Remix_Function, THE Stack_Engine SHALL return a new Stack in which `id` is the new `id`, `remixedFrom` is the `id` of the input Stack, and every other field is deeply equal to the corresponding field of the input Stack, including any `remixedFrom` value already present on the input Stack, which the Remix_Function replaces.
2. WHEN the Remix_Function returns a Stack, THE Stack_Engine SHALL keep the Entity_ID of every Card, Object, and Link in that Stack identical to its Entity_ID in the input Stack, because Entity_IDs are unique only within one Stack.
3. IF the new Stack `id` supplied to the Remix_Function does not match the Entity_ID pattern of Requirement 2, criterion 1 of the `stack-format-and-validator` spec, THEN THE Stack_Engine SHALL return a Validation_Error with the code `INVALID_VALUE` and no Stack, and SHALL leave the input Stack unmodified.
4. IF the Stack supplied to the Remix_Function is not a valid Stack, THEN THE Stack_Engine SHALL return the Validation_Errors produced by validating that Stack and no remixed Stack, and SHALL leave the input Stack unmodified.

### Requirement 8: New stack creation

**User Story:** As the UI and persistence features, I want a pure function that creates a new valid stack from a few caller-supplied values, so that every new stack starts valid and no feature has to build a stack by hand.

#### Acceptance Criteria

1. WHEN the Stack_Factory is called with a valid Stack `id` and a valid Stack `name`, THE Stack_Factory SHALL return a result with `ok` equal to true and a new Stack that has `formatVersion` equal to 1, the supplied `id` and `name`, exactly one Card, and a `startCardId` equal to the `id` of that Card, and that has no `remixedFrom` property.
2. THE Stack_Factory SHALL give the first Card an empty `objects` array, an empty `links` array, and an empty `onOpen` Handler.
3. WHEN the Stack_Factory is called with `cardWidth` and `cardHeight` values that are integers from 64 through 4096, THE Stack_Factory SHALL store the supplied values as the Stack `cardWidth` and `cardHeight`.
4. WHEN the `cardWidth` parameter is omitted, THE Stack_Factory SHALL set the Stack `cardWidth` to 512.
5. WHEN the `cardHeight` parameter is omitted, THE Stack_Factory SHALL set the Stack `cardHeight` to 342.
6. WHEN the `firstCardId` parameter is supplied and valid, THE Stack_Factory SHALL use it as the `id` of the first Card. WHEN the `firstCardId` parameter is omitted, THE Stack_Factory SHALL set the `id` of the first Card to `card-1`.
7. WHEN the `firstCardName` parameter is supplied and valid, THE Stack_Factory SHALL use it as the `name` of the first Card. WHEN the `firstCardName` parameter is omitted, THE Stack_Factory SHALL set the `name` of the first Card to `Card 1`.
8. THE Stack_Factory SHALL return a Stack for which the Stack_Validator returns `valid` equal to true, as defined in the `stack-format-and-validator` spec.
9. IF the Stack `id` or the Stack `name` is omitted, THEN THE Stack_Factory SHALL return a Validation_Error with the code `MISSING_PROPERTY` for each omitted parameter.
10. IF the Stack `id` or the `firstCardId` does not match the Entity_ID pattern of Requirement 2, criterion 1 of the `stack-format-and-validator` spec, THEN THE Stack_Factory SHALL return a Validation_Error with the code `INVALID_VALUE` for each such parameter.
11. IF the Stack `name` or the `firstCardName` is an empty string, THEN THE Stack_Factory SHALL return a Validation_Error with the code `INVALID_VALUE` for each such parameter.
12. IF the Stack `name` or the `firstCardName` is longer than 100 characters, THEN THE Stack_Factory SHALL return a Validation_Error with the code `LIMIT_EXCEEDED` for each such parameter.
13. IF the `cardWidth` or the `cardHeight` is not an integer from 64 through 4096, THEN THE Stack_Factory SHALL return a Validation_Error with the code `OUT_OF_RANGE` for each such parameter.
14. IF the Stack_Factory finds one or more invalid parameters, THEN THE Stack_Factory SHALL return a result with `ok` equal to false, no Stack, and one Validation_Error for each invalid parameter, in the order `id`, `name`, `cardWidth`, `cardHeight`, `firstCardId`, `firstCardName`, where each Validation_Error has the structure defined in Requirement 7 of the `stack-format-and-validator` spec and a `path` that is the JSON Pointer to the offending parameter (for example `/cardWidth`).
15. THE Stack_Factory SHALL return deeply equal results for every call with the same parameters, using the caller-supplied Stack `id` and no clock, random source, or external state.

### Requirement 9: Operation schemas for the tool registry

**User Story:** As the AI orchestrator author, I want a JSON Schema for each operation, so that the tool registry can describe and validate tool calls without redefining the operations.

#### Acceptance Criteria

1. THE Stack_Engine SHALL expose exactly one Operation_Schema, valid against the draft 2020-12 meta-schema, for each of `create_card`, `delete_card`, `add_object`, `update_object`, `remove_object`, `link_cards`, and `set_action`, and SHALL expose no Operation_Schema for any other name.
2. THE Stack_Engine SHALL include in each Operation_Schema a non-empty top-level `description` string of at most 1,000 characters that states the purpose of the Operation, and a non-empty `description` string of at most 500 characters for each parameter that states the meaning of the parameter, its type, and its constraints (allowed values, bounds, or required status).
3. WHEN an Operation is applied, THE Stack_Engine SHALL validate the parameters against the Operation_Schema before making any change to the Stack, and SHALL apply the Operation only if validation reports zero schema violations.
4. THE Stack_Engine SHALL expose a list containing exactly seven entries, one per Operation, where each entry pairs a unique Operation name with its Operation_Schema, so that a registry can enumerate them.
5. FOR ALL valid Stacks and for every parameter object that conforms to an Operation_Schema, THE Stack_Engine SHALL return an Operation_Result with either `ok` equal to true or at least one Validation_Error, and SHALL NOT raise an exception.
6. IF the parameters of an Operation violate its Operation_Schema, THEN THE Stack_Engine SHALL return an Operation_Result with `ok` equal to false and one Validation_Error for each violation, identifying the offending parameter and the violated rule, and SHALL leave the Stack unchanged.
7. IF an Operation is requested with a name that is not one of the seven Operation names, THEN THE Stack_Engine SHALL return an Operation_Result with `ok` equal to false and one Validation_Error with the code `INVALID_VALUE` indicating an unknown Operation, and SHALL leave the Stack unchanged.

### Requirement 10: Purity and environment independence

**User Story:** As a developer of the UI, the services, and the tests, I want every engine function to be pure and to run in any environment, so that the engine behaves identically in a browser, on a server, and in the test runner.

#### Acceptance Criteria

1. THE Stack_Engine SHALL run every exported function in a browser, in a server runtime, and in the test runner. Each function SHALL need only the module import and SHALL NOT need environment-specific setup such as global variables, polyfills, file access, or network access.
2. THE Stack_Engine SHALL implement every exported function, including the Remix_Function and the Stack_Factory, as a pure function. For the same input values it SHALL return deeply equal output values, it SHALL NOT modify its input values, and it SHALL NOT perform I/O or read or write state outside its arguments.

### Requirement 11: Correctness properties and test support

**User Story:** As a developer building on the engine, I want property-based tests that cover the core invariants, so that later subsystems can trust the engine.

#### Acceptance Criteria

1. THE test suite SHALL reuse the generator of arbitrary valid Stacks defined in Requirement 12, criterion 1 of the `stack-format-and-validator` spec as the source of Stacks for every property-based test in this spec.
2. THE test suite SHALL provide a generator of arbitrary Operation sequences with a length of 0 to 50 Operations, drawn from every Operation defined in this spec, in which each Operation has either valid or invalid parameters, and in which both outcomes occur across generated sequences.
3. THE test suite SHALL run every property-based test in this spec under the case count and seed rules of Requirement 12, criterion 2 of the `stack-format-and-validator` spec.
4. IF a property-based test in this spec fails, THEN THE test suite SHALL mark that test as failed and SHALL report the seed and the shrunk counterexample, as required by Requirement 12, criterion 3 of the `stack-format-and-validator` spec.
5. FOR ALL valid Stacks, THE Render_Model_Builder SHALL return a Render_Model for every Card in the Stack, without throwing an exception and without returning an error (render property).
6. FOR ALL valid Stacks and for all sequences of Operations, whether each Operation is accepted or rejected, the Stack held after each Operation in the sequence SHALL pass the Stack_Validator, meaning the Stack_Validator returns `valid` equal to true (operation-closure property).
7. FOR ALL valid Stacks and for all Operations, a rejected Operation SHALL leave the Stack deeply equal to the input Stack. Deeply equal means every property and array element has an equal value, array order is the same, and the input Stack was not modified.
8. FOR ALL valid Stacks, for every Action type, and for all Handlers that conform to Requirement 6 of the `stack-format-and-validator` spec, the Stack returned by the Action_Executor SHALL pass the Stack_Validator.
9. THE test suite SHALL include at least one accepted example and one rejected example for each Operation defined in this spec.
10. THE test suite SHALL include at least one example-based test for each Action type defined in Requirement 6 of the `stack-format-and-validator` spec that executes a Handler containing an Action of that type with the Action_Executor and asserts the resulting Stack, `messages`, `navigateTo`, and Effect_Requests.
11. THE test suite SHALL include at least one example-based test that asserts the code `UNKNOWN_ENTITY` and the `path` returned by a rejected Operation, and at least one example-based test that asserts the code `UNKNOWN_ENTITY` and the `path` returned by the Render_Model_Builder for a supplied Entity_ID that is not a Card.
12. THE test suite SHALL include at least one example-based test that asserts the code `OUT_OF_RANGE` and the `path` returned by a rejected `create_card` Operation, and at least one example-based test that asserts the code `OUT_OF_RANGE` and the `path` returned by a rejected `add_object` Operation.
13. THE test suite SHALL provide a generator of arbitrary valid Stack_Factory parameters that produces the minimum, the maximum, and in-between values of the `cardWidth` and `cardHeight` bounds, the minimum and maximum lengths of the Stack `name` and `firstCardName`, and parameter sets with each optional parameter present and omitted.
14. FOR ALL valid Stack_Factory parameters, the Stack returned by the Stack_Factory SHALL pass the Stack_Validator, meaning the Stack_Validator returns `valid` equal to true (stack-creation property).
15. THE test suite SHALL include at least one example-based test for each Stack_Factory rejection case of Requirement 8, criteria 9 through 13, that asserts `ok` equal to false, no Stack, and the code and `path` of the returned Validation_Error: an omitted `id`, an omitted `name`, a Stack `id` that does not match the Entity_ID pattern, an empty `name`, a `name` longer than 100 characters, a `cardWidth` outside the format bounds, and a `cardHeight` outside the format bounds.
16. THE test suite SHALL include at least one example-based test that calls the Stack_Factory with only a Stack `id` and a `name` and asserts the default card size of 512 by 342, the first Card `id` `card-1`, and the first Card `name` `Card 1`.

# Requirements Document

## Introduction

This document specifies the first of two subsystems of the Kiroween 2026 project (a HyperCard-inspired, AI-authored "stack" environment): the strict JSON stack format, the validator for that format, the serializer and parser that convert stacks to and from text, and the machine-readable JSON Schema that describes the structure of the format. This is build priority 1 in the project brief ("Stack format and engine, with tests"), split into two specs. This spec, `stack-format-and-validator`, defines what a valid stack is and how to check, write, and read one. The second spec, `stack-engine`, defines the pure operations, action execution, render model, and remix that work on valid stacks. The retro UI shell, the AI orchestrator, and the share and remix services are separate specs.

**Boundary with the `stack-engine` spec.** The `stack-engine` spec depends on the public surface defined here: the Stack, Handler, Action, and Object types; the Stack_Validator and the Validation_Error structure, including the closed set of Validation_Error codes; the Stack_Parser and Stack_Serializer; and the Stack_Schema. This spec contains no operations that change a Stack, no execution of Handlers, and no rendering. The Validation_Error codes `UNKNOWN_ENTITY` and `OUT_OF_RANGE` belong to the closed code set so that the `stack-engine` spec can reuse them for rejected operations. The Stack_Validator itself does not return those two codes.

A stack is a document made of cards. A card holds objects (button, field, image, list, ai-field) and links to other cards. Buttons and cards carry actions. Every other subsystem (AI tool calls, UI rendering, sharing, tests) depends on this format, so the format is deliberately small and strict.

**Resolved open question: declarative actions versus sandboxed scripts.** The Stack_Format uses declarative actions: a closed set of typed action records executed in order, with no conditionals, loops, expressions, or user-written code. Reasons: (1) every action can be validated against a schema, which the AI repair loop (D7) needs; (2) execution always terminates, and shared stacks cannot run arbitrary code, which matters for shareable and remixable stacks (D10). This spec defines only the format of actions. Actions that need the outside world (AI calls, news fetching, transcription, notifications) are carried out by other subsystems, as described in the `stack-engine` spec. The trade-off is that the format cannot express arbitrary logic (for example, computing a running total). Such cases are handled by ai-field objects, or by adding new action types in a later format version.

**Scope of the Stack_Schema.** The Stack_Schema describes structure only: required properties, property types, enumerated values, and numeric and string length bounds. Cross-entity rules (unique Entity_IDs, resolving references, object bounds relative to the card size, unique links per card, and the serialized size limit) are enforced by the Stack_Validator under Requirement 8.

**Scope decisions.**

- The Stack_Format has exactly five Object types: button, field, image, list, and ai-field. It has no timer, stopwatch, or reminder Object type. Reminders use the `schedule_notification` Action, and how a due notification looks is a UI concern that is not stored in the Stack.
- The Stack_Format has no icon property. The UI derives any desktop icon for a Stack from the Stack `id`, so a Stack stays valid and lossless without one.
- The Stack_Format accepts any card size within the stated bounds. The `stack-engine` spec sets the default card size for new stacks (512 by 342).

## Glossary

- **Stack_Format**: The strict JSON document format that describes a Stack, defined by this spec.
- **Stack**: The top-level document: a name, card dimensions, a start card, and an ordered list of Cards.
- **Card**: An ordered container of Objects and Links within a Stack. A Card carries an on-open Handler.
- **Object**: An element on a Card. The Object types are button, field, image, list, and ai-field.
- **Button**: An Object with a label and an on-click Handler.
- **Field**: An Object holding a single text value.
- **Image**: An Object that displays a picture from an image source.
- **List**: An Object holding an ordered sequence of text items.
- **AI_Field**: An Object (type `ai-field`) with a prompt, references to input Objects, and a text value that stores the most recent AI output.
- **Link**: A Card-owned record of navigation from that Card to a target Card.
- **Action**: A typed, declarative record describing one step to perform. The Action types are `go_to_card`, `set_value`, `append_item`, `remove_item`, `show_message`, `run_ai_field`, `fetch_news`, `transcribe_audio`, and `schedule_notification`. This spec defines only the format of each Action type. The Action types `run_ai_field`, `fetch_news`, `transcribe_audio`, and `schedule_notification` are intended to be carried out as Effect_Requests, which the `stack-engine` spec defines.
- **Handler**: An ordered list of Actions attached to a trigger (Button click or Card open).
- **Entity_ID**: A string identifier of a Card, Object, or Link, unique across all three within one Stack.
- **Stack_Validator**: The component that checks a candidate value against the Stack_Format and returns Validation_Errors.
- **Validation_Error**: A machine-readable record with the properties `code`, `path`, `message`, `expected`, `actual`, and `hint`.
- **Stack_Serializer**: The component that converts a Stack into canonical JSON text.
- **Stack_Parser**: The component that converts JSON text into a validated Stack.
- **Canonical_JSON**: The single JSON text representation of a Stack: UTF-8, object keys in the order fixed by the Stack_Format, two-space indentation, and a trailing newline.
- **Stack_Schema**: The JSON Schema (draft 2020-12) that describes the structural rules of the Stack_Format.
- **Format_Version**: The integer in the `formatVersion` property of a Stack; the value for this spec is 1.

## Requirements

### Requirement 1: Stack document structure

**User Story:** As a developer of any subsystem, I want one small, strict stack structure, so that AI, UI, sharing, and tests all agree on what a stack is.

#### Acceptance Criteria

1. THE Stack_Format SHALL define a Stack with the required properties `formatVersion`, `id`, `name`, `cardWidth`, `cardHeight`, `startCardId`, and `cards`, and the optional property `remixedFrom`, where `id` and `remixedFrom` are strings that match the pattern in Requirement 2.1.
2. THE Stack_Format SHALL require `formatVersion` to equal the integer 1.
3. THE Stack_Format SHALL restrict `name` to a string of 1 through 100 characters, `cardWidth` to an integer from 64 through 4096, and `cardHeight` to an integer from 64 through 4096.
4. THE Stack_Format SHALL require `cards` to contain 1 through 200 Cards, with array order defining Card order.
5. THE Stack_Format SHALL require `startCardId` to equal the `id` of exactly one Card in the Stack.
6. THE Stack_Format SHALL define a Card with the required properties `id`, `name`, `objects`, `links`, and `onOpen`, where `id` is an Entity_ID that is unique among all Cards in the Stack.
7. THE Stack_Format SHALL restrict Card `name` to a string of 1 through 100 characters, `objects` to 0 through 100 Objects, `links` to 0 through 50 Links, and `onOpen` to exactly one Handler.
8. THE Stack_Format SHALL use the array order of a Card's `objects` as the back-to-front drawing order, where the first Object in the array is drawn first (rearmost) and the last Object is drawn last (frontmost).
9. IF a Stack document contains a property that is not defined for the Stack, Card, Object, Link, or Action that holds it, THEN THE Stack_Format SHALL reject the Stack document as invalid.
10. THE Stack_Format SHALL describe every value as plain JSON (object, array, string, integer, boolean), with no functions, no references to runtime state, no non-integer numbers, and no property for credentials or API keys.
11. IF a Stack document violates any constraint in criteria 1 through 10, THEN THE Stack_Format SHALL reject the entire Stack document, report for each violation the location of the offending value and the constraint it violates, and leave any previously loaded Stack unchanged.

### Requirement 2: Identifiers and references

**User Story:** As an AI model producing tool calls, I want stable, simple identifiers, so that I can refer to cards and objects without ambiguity.

#### Acceptance Criteria

1. THE Stack_Format SHALL require every Entity_ID to be a case-sensitive string of 1 to 64 characters that matches the pattern `^[a-z0-9][a-z0-9_-]{0,63}$`, so that an empty string, a string longer than 64 characters, and a string containing an uppercase letter or any character outside `a-z`, `0-9`, `_` and `-` are all invalid.
2. THE Stack_Format SHALL require every Entity_ID of a Card, Object, or Link to be unique among the Entity_IDs of all Cards, Objects, and Links in the Stack, regardless of entity type.
3. THE Stack_Format SHALL require every reference to a Card (`startCardId`, Link `targetCardId`, and Action `cardId`) to equal the Entity_ID of a Card in the same Stack. A reference that equals the Entity_ID of an Object or Link is invalid.
4. THE Stack_Format SHALL require every reference to an Object (Action `targetObjectId`, Action `fromObjectId`, Action `atFromObjectId`, and each element of AI_Field `inputObjectIds`) to equal the Entity_ID of an Object in the same Stack. A reference that equals the Entity_ID of a Card or Link is invalid.
5. THE Stack_Format SHALL determine the validity of a Stack from the content of that Stack alone. A Stack SHALL contain no reference to another Stack, an external resource, or any entity outside the Stack, so that validation of the Stack gives the same result before and after it moves between storage locations.
6. IF a Stack contains an Entity_ID that violates the pattern in criterion 1 or duplicates another Entity_ID in the Stack, THEN THE Stack_Format SHALL reject the Stack, return an error that identifies the offending Entity_ID and the violated rule (invalid pattern or duplicate), and leave the previously stored Stack content unchanged.
7. IF a Card reference or Object reference does not resolve to an Entity_ID of the required entity type in the same Stack, THEN THE Stack_Format SHALL reject the Stack, return an error that identifies the referencing field and the unresolved value, and leave the previously stored Stack content unchanged.

### Requirement 3: Object common properties and geometry

**User Story:** As a UI developer, I want every object to carry the same position and size properties, so that I can lay out any card uniformly.

#### Acceptance Criteria

1. THE Stack_Format SHALL define every Object with the required properties `id` (an Entity_ID), `type`, `name`, `x`, `y`, `width`, and `height`.
2. THE Stack_Format SHALL restrict `type` to exactly one of the case-sensitive strings `button`, `field`, `image`, `list`, or `ai-field`.
3. THE Stack_Format SHALL restrict Object `name` to a string of 0 through 100 characters.
4. THE Stack_Format SHALL require `x` and `y` to be JSON integers from 0 through 4096 inclusive, and `width` and `height` to be JSON integers from 8 through 4096 inclusive, with non-integer numbers (such as 10.5) and non-numeric values not accepted.
5. THE Stack_Format SHALL require the sum of `x` and `width` to be less than or equal to the Stack `cardWidth`, and the sum of `y` and `height` to be less than or equal to the Stack `cardHeight`, so that an Object whose edge lies exactly on the card boundary is valid.
6. IF an Object omits a required common property, or has a common property that breaks criteria 1 through 5, THEN THE Stack_Validator SHALL return at least one Validation_Error whose `path` identifies the offending Object and property, and THE Stack_Validator SHALL leave the validated value unmodified.

### Requirement 4: Object type-specific properties

**User Story:** As a stack author, I want each object type to hold the content its role needs, so that cards can contain working buttons, fields, lists, images, and AI-powered fields.

#### Acceptance Criteria

1. THE Stack_Format SHALL define a Button with the additional required properties `label` (a string of 1 through 100 characters) and `onClick` (a Handler).
2. THE Stack_Format SHALL define a Field with the additional required properties `value` (a string of 0 through 10,000 characters), `placeholder` (a string of 0 through 200 characters), `multiline` (boolean), and `readOnly` (boolean).
3. THE Stack_Format SHALL define an Image with the additional required properties `src` (a string as specified in criterion 4) and `alt` (a string of 0 through 200 characters).
4. THE Stack_Format SHALL require an Image `src` to be either an `https:` URL of 1 through 2,000 characters, or a base64-encoded `data:image/png`, `data:image/jpeg`, `data:image/gif`, or `data:image/webp` URI of at most 1,000,000 characters.
5. THE Stack_Format SHALL define a List with the additional required properties `items` (an array of 0 through 500 strings, each 0 through 500 characters) and `ordered` (boolean).
6. THE Stack_Format SHALL define an AI_Field with the additional required properties `prompt` (a string of 1 through 2,000 characters), `inputObjectIds` (an array of 0 through 10 unique Entity_IDs), and `value` (a string of 0 through 10,000 characters).
7. THE Stack_Format SHALL require every `inputObjectIds` entry to reference a Field, List, or AI_Field that is on the same Card as the AI_Field and whose `id` differs from the AI_Field's own `id`.
8. IF an Object omits a required type-specific property, supplies a value of the wrong type, violates a length, count, or uniqueness limit in criteria 1 through 7, or has an `inputObjectIds` entry that does not reference an existing Object, THEN THE Stack_Format SHALL treat the Stack as invalid, identify the Object's Entity_ID and the offending property name in the Validation_Error, and leave any previously stored Stack unchanged.
9. IF an Image `src` is not an `https:` URL or a base64 `data:` URI of one of the four permitted image types (for example `http:`, `javascript:`, `data:image/svg+xml`, or a malformed base64 payload), THEN THE Stack_Format SHALL treat the Stack as invalid and identify the Image's Entity_ID and the `src` property in the Validation_Error.

### Requirement 5: Card links

**User Story:** As a stack author, I want cards to link to each other, so that a stack can be navigated as a set of connected cards.

#### Acceptance Criteria

1. THE Stack_Format SHALL define a Link with the required properties `id`, `label`, and `targetCardId`, where `label` is a string of 1 through 100 characters.
2. THE Stack_Format SHALL store each Link in the `links` array of the Card from which the navigation starts, and SHALL permit a `links` array containing zero Links.
3. THE Stack_Format SHALL permit a Link whose `targetCardId` equals the `id` of the Card that owns the Link.
4. THE Stack_Format SHALL require that no two Links in the same Card have the same `targetCardId`, regardless of their `label` values, and SHALL permit Links in different Cards to have the same `targetCardId`.
5. IF a Link has a missing `id`, `label`, or `targetCardId`, or a `label` shorter than 1 or longer than 100 characters, or a Card contains two Links with the same `targetCardId`, THEN THE Stack_Format SHALL treat the Stack as invalid.
6. IF the `targetCardId` of a Link does not equal the `id` of any Card in the same Stack, THEN THE Stack_Format SHALL treat the Stack as invalid.

### Requirement 6: Declarative action model

**User Story:** As a non-programmer's AI assistant, I want a closed set of typed actions, so that every behavior I generate can be validated and cannot run arbitrary code.

#### Acceptance Criteria

1. THE Stack_Format SHALL define a Handler as an array of 0 through 20 Actions, executed one at a time in array order, with each Action finishing before the next Action starts.
2. THE Stack_Format SHALL define each Action as an object whose `type` is exactly one of `go_to_card`, `set_value`, `append_item`, `remove_item`, `show_message`, `run_ai_field`, `fetch_news`, `transcribe_audio`, or `schedule_notification`, and that contains no properties other than those defined for its `type`.
3. THE Stack_Format SHALL define `go_to_card` with the required property `cardId`, which references a Card in the same Stack.
4. THE Stack_Format SHALL define `set_value` with the required property `targetObjectId` (a Field or AI_Field) and exactly one of `value` (a string of 0 through 10,000 characters) or `fromObjectId` (a Field, AI_Field, or List).
5. THE Stack_Format SHALL define `append_item` with the required property `targetObjectId` (a List) and exactly one of `item` (a string of 0 through 500 characters) or `fromObjectId` (a Field or AI_Field).
6. THE Stack_Format SHALL define `remove_item` with the required properties `targetObjectId` (a List) and `index` (an integer greater than or equal to 0).
7. THE Stack_Format SHALL define `show_message` with the required property `text` (1 through 500 characters).
8. THE Stack_Format SHALL define `run_ai_field` with the required property `targetObjectId` (an AI_Field).
9. THE Stack_Format SHALL define `fetch_news` with the required properties `topics` (an array of 1 through 10 strings, each 1 through 100 characters) and `targetObjectId` (a List).
10. THE Stack_Format SHALL define `transcribe_audio` with the required property `targetObjectId` (a Field).
11. THE Stack_Format SHALL define `schedule_notification` with the required property `message` (1 through 500 characters) and exactly one of `at` (a UTC timestamp string in ISO 8601 format) or `atFromObjectId` (a Field).
12. THE Stack_Format SHALL define the Action set without conditionals, loops, variables, expressions, or embedded code.
13. IF a Handler has more than 20 Actions, or contains an Action with an unrecognized `type`, a missing required property, a property not defined for its `type`, a property value outside its stated bounds, or an object or card reference that does not resolve to an object or card of the required kind in the same Stack, THEN THE Stack_Format SHALL classify the Stack as invalid and SHALL require validation to report a Validation_Error whose `path` identifies the Handler, the index of the offending Action, and the violated rule.

### Requirement 7: Structured validation errors

**User Story:** As the AI orchestrator, I want validation failures returned as structured data, so that a repair loop can tell the model exactly what to fix.

#### Acceptance Criteria

1. WHEN a candidate value is submitted, THE Stack_Validator SHALL return a result containing a boolean `valid`, an array `errors` of Validation_Errors, and a boolean `truncated`.
2. WHEN a candidate value conforms to the Stack_Format and satisfies Requirement 8, THE Stack_Validator SHALL return `valid` equal to true, an empty `errors` array, and `truncated` equal to false.
3. THE Stack_Validator SHALL give each Validation_Error a `code` from this closed set: `INVALID_JSON`, `MISSING_PROPERTY`, `UNKNOWN_PROPERTY`, `WRONG_TYPE`, `INVALID_VALUE`, `OUT_OF_RANGE`, `DUPLICATE_ID`, `DANGLING_REFERENCE`, `WRONG_REFERENCE_TYPE`, `OUT_OF_BOUNDS`, `LIMIT_EXCEEDED`, `UNSUPPORTED_VERSION`, `DUPLICATE_LINK`, and `UNKNOWN_ENTITY`.
4. THE Stack_Validator SHALL give each Validation_Error a `path` that is a JSON Pointer (RFC 6901) to the offending location, or to the nearest existing ancestor when the offending property is missing. The path of the root value is `""`.
5. THE Stack_Validator SHALL give each Validation_Error a non-empty `message` string, a non-empty `expected` description, a non-empty `hint` stating one concrete correction, and the `actual` offending value, serialized as JSON and truncated to its first 200 characters. WHERE the offending property is missing, `actual` SHALL be null.
6. WHEN a candidate value contains between 2 and 100 violations inclusive, THE Stack_Validator SHALL report every violation as a separate Validation_Error and set `truncated` to false.
7. IF a candidate value contains more than 100 violations, THEN THE Stack_Validator SHALL return exactly the first 100 Validation_Errors in the order defined by criterion 8 and set `truncated` to true.
8. THE Stack_Validator SHALL order Validation_Errors by the document order of their `path` (depth-first traversal, with properties visited in the order they appear in the candidate value), breaking ties between errors with the same `path` by `code` in ascending code-point order, so that the same candidate value always produces an identical `errors` array.
9. IF the candidate value, once parsed, is not a JSON object (including an array, string, number, boolean, or null), THEN THE Stack_Validator SHALL return `valid` equal to false and a single Validation_Error with the code `WRONG_TYPE` and the path `""`.
10. IF the `formatVersion` of a candidate value is an integer other than 1, THEN THE Stack_Validator SHALL return `valid` equal to false and a single Validation_Error with the code `UNSUPPORTED_VERSION`, the path `/formatVersion`, and a `hint` naming the supported version 1.
11. THE Stack_Validator SHALL be a pure function that does not modify the candidate value, performs no I/O, and returns an identical result each time it is called with the same candidate value.
12. IF the candidate is text that cannot be parsed as JSON, THEN THE Stack_Validator SHALL return `valid` equal to false and a single Validation_Error with the code `INVALID_JSON` and the path `""`.
13. IF a candidate value contains at least one violation, THEN THE Stack_Validator SHALL return `valid` equal to false and a non-empty `errors` array.

### Requirement 8: Semantic validation

**User Story:** As a stack consumer, I want the validator to check cross-entity rules and limits, so that a valid stack never breaks the UI or storage.

#### Acceptance Criteria

1. IF an Entity_ID in a Stack equals an Entity_ID that appears earlier in document order, THEN THE Stack_Validator SHALL return one Validation_Error with the code `DUPLICATE_ID` and a `path` pointing to the `id` property of that later occurrence. Document order means Cards in `cards` array order. Within each Card, the Card's own `id` comes first, then each Object `id` in `objects` order, then each Link `id` in `links` order. The check compares Entity_IDs across Cards, Objects, and Links, so an Entity_ID that appears n times produces n-1 errors.
2. IF a reference property (`startCardId`, Link `targetCardId`, Action `cardId`, Action `targetObjectId`, Action `fromObjectId`, Action `atFromObjectId`, or an entry of AI_Field `inputObjectIds`) holds a string that is not the Entity_ID of any Card, Object, or Link in the Stack, THEN THE Stack_Validator SHALL return one Validation_Error with the code `DANGLING_REFERENCE` and a `path` pointing to that reference property, or to the array entry for `inputObjectIds`.
3. IF a reference property holds the Entity_ID of an existing entity that is not permitted for that property, THEN THE Stack_Validator SHALL return one Validation_Error with the code `WRONG_REFERENCE_TYPE` and a `path` pointing to that reference property, or to the array entry for `inputObjectIds`. An entity is not permitted in any of these cases:
   - The entity is not a Card, for a Card reference (Requirement 2.3).
   - The entity is not an Object, for an Object reference (Requirement 2.4).
   - The Object type is not allowed for that Action property (Requirement 6).
   - The entry of an AI_Field `inputObjectIds` is an Object of type `button` or `image`, is on a different Card than the AI_Field, or equals the AI_Field's own `id` (Requirement 4.7).
4. IF the sum of an Object's `x` and `width` is greater than the Stack `cardWidth`, or the sum of its `y` and `height` is greater than the Stack `cardHeight` (Requirement 3.5), THEN THE Stack_Validator SHALL return one Validation_Error with the code `OUT_OF_BOUNDS` and a `path` pointing to that Object. The Validation_Error is returned once per Object, even when both bounds are exceeded. An Object whose sums equal `cardWidth` or `cardHeight` is within bounds.
5. IF an array has more elements than, or a string has more Unicode code points than, a maximum stated in Requirements 1, 4, 5, or 6, THEN THE Stack_Validator SHALL return one Validation_Error with the code `LIMIT_EXCEEDED` and a `path` pointing to that array or string. The maximums include 200 Cards per Stack, 100 Objects per Card, 50 Links per Card, 500 List items, 20 Actions per Handler, and 10,000 characters per Field or AI_Field `value`. An array or string whose size equals the maximum is within the limit.
6. IF a Link has the same `targetCardId` as an earlier Link in the same Card's `links` array, THEN THE Stack_Validator SHALL return one Validation_Error with the code `DUPLICATE_LINK` and a `path` pointing to the `targetCardId` property of the later Link. Links in different Cards may share a `targetCardId`.
7. IF the Canonical_JSON of a Stack, including its trailing newline, is longer than 2,097,152 bytes in UTF-8, THEN THE Stack_Validator SHALL return one Validation_Error with the code `LIMIT_EXCEEDED` and the path `""`. A Canonical_JSON of exactly 2,097,152 bytes is within the limit.
8. IF the Stack_Validator returns at least one Validation_Error for a violation in criteria 1 through 7, THEN THE Stack_Validator SHALL return `valid` equal to false.

### Requirement 9: Serialization, parsing, and round trip

**User Story:** As a user and as the share and persistence services, I want to export and import stacks without losing anything, so that stacks survive storage, sharing, and remixing intact.

#### Acceptance Criteria

1. WHEN a valid Stack is supplied, THE Stack_Serializer SHALL produce Canonical_JSON text: UTF-8 encoded, two-space indentation, and a single trailing newline.
2. WHEN JSON text of at most 2,097,152 bytes (measured as UTF-8 encoded length) is supplied, THE Stack_Parser SHALL parse the text, run the Stack_Validator, and return the Stack if the Stack_Validator reports zero Validation_Errors.
3. IF the supplied text is not well-formed JSON, THEN THE Stack_Parser SHALL return exactly one Validation_Error with the code `INVALID_JSON`, a `path` of `""`, and a `message` containing the 1-based line number and 1-based column number of the first syntax error, and SHALL NOT return a Stack.
4. IF the supplied text is longer than 2,097,152 bytes (measured as UTF-8 encoded length), THEN THE Stack_Parser SHALL return exactly one Validation_Error with the code `LIMIT_EXCEEDED` and a `path` of `""` without parsing the text, and SHALL NOT return a Stack.
5. THE Stack_Serializer SHALL order object keys in Canonical_JSON according to the property order defined in the Stack_Format, and SHALL keep array order unchanged.
6. THE Stack_Serializer SHALL produce byte-for-byte identical text for any two Stacks that are deeply equal.
7. FOR ALL valid Stacks, parsing the Canonical_JSON produced by the Stack_Serializer SHALL produce a Stack deeply equal to the original (round-trip property: serialize, parse).
8. FOR ALL Canonical_JSON texts accepted by the Stack_Parser, serializing the parsed Stack SHALL produce text byte-for-byte identical to the input (round-trip property: parse, serialize).
9. THE Stack_Serializer SHALL preserve every Unicode character in strings, including characters outside the Basic Multilingual Plane and the characters `"`, `\`, and newline, such that parsing the produced text yields strings with the same sequence of Unicode code points as the original.
10. IF the Stack_Validator reports one or more Validation_Errors for text that is well-formed JSON and within 2,097,152 bytes, THEN THE Stack_Parser SHALL return all reported Validation_Errors and SHALL NOT return a Stack.
11. IF an invalid Stack is supplied, THEN THE Stack_Serializer SHALL return the Validation_Errors reported by the Stack_Validator and SHALL NOT produce Canonical_JSON text.

### Requirement 10: Storage compatibility and environment independence

**User Story:** As the share and local-first persistence features, I want the stack format to be storable as one self-contained value and its tools to run anywhere, so that those later specs need no format changes and no environment-specific code.

#### Acceptance Criteria

1. WHEN a Stack is serialized to JSON text and the text is parsed back, THE Stack_Format SHALL yield a value deeply equal to the original Stack. The serialized text SHALL be a single JSON value, storable under the key `Stack.id`, and SHALL contain every Card, Object, Link, and other piece of data the Stack needs, with no data held outside it.
2. THE Stack_Validator, THE Stack_Parser, and THE Stack_Serializer SHALL run in a browser, in a server runtime, and in the test runner. Each exported function of these components SHALL need only the module import and SHALL NOT need environment-specific setup such as global variables, polyfills, file access, or network access.
3. THE Stack_Validator, THE Stack_Parser, and THE Stack_Serializer SHALL implement every exported function as a pure function. For the same input values each function SHALL return deeply equal output values, SHALL NOT modify its input values, and SHALL NOT perform I/O or read or write state outside its arguments.

### Requirement 11: Machine-readable JSON Schema for the stack format

**User Story:** As the AI orchestrator author, I want a JSON Schema for the stack, so that the tool registry and other tooling can describe and check the structure of a stack without redefining the format.

#### Acceptance Criteria

1. THE Stack_Format SHALL be described by an exposed Stack_Schema that is a JSON Schema (draft 2020-12), is itself valid against the draft 2020-12 meta-schema, and describes the structural rules of the Stack_Format (required properties, property types, enumerated values, and numeric and string length bounds), such that every valid Stack conforms to the Stack_Schema and every document with a missing required property or a wrong-typed property fails validation against it.

### Requirement 12: Correctness properties and test support

**User Story:** As a developer building on a strict format, I want property-based tests that cover the core invariants, so that later subsystems can trust the format, validator, serializer, and parser.

#### Acceptance Criteria

1. THE test suite SHALL provide a generator of arbitrary valid Stacks that covers every Object type, every Action type, and Links, and that produces values at the minimum and maximum of each limit in Requirements 1, 4, 5, and 6 as well as values between them.
2. THE test suite SHALL run every property-based test for at least 100 generated cases per run, using a seed that the caller can supply, and SHALL generate identical cases when the same seed is supplied.
3. IF a property-based test fails, THEN THE test suite SHALL mark that test as failed and SHALL report the seed and the shrunk counterexample.
4. FOR ALL valid Stacks, serializing and then parsing SHALL produce a Stack deeply equal to the original, where deeply equal means every property and array element has an equal value, array order is the same, and the input Stack was not modified (export-import lossless property).
5. FOR ALL candidate values produced by applying one random mutation to a valid Stack, THE Stack_Validator SHALL either return `valid` equal to true, or return Validation_Errors whose every `path` is a JSON Pointer that resolves to a location in the mutated value or to its nearest existing ancestor. A random mutation is one of the following: deleting a property, replacing a value with a value of a different type, replacing a number or string with a value outside its limit, or adding an unknown property.
6. FOR ALL candidate values, THE Stack_Validator SHALL return the same result when called twice with the same value. The same result means an equal `valid` flag and equal Validation_Errors in the same order (determinism property).
7. FOR ALL valid Stacks, THE Stack_Schema SHALL accept the Stack (schema-acceptance property).
8. THE test suite SHALL include at least one example-based test for each Validation_Error code in Requirement 7.3 that the Stack_Validator can return, asserting the returned code and `path`. The codes `UNKNOWN_ENTITY` and `OUT_OF_RANGE` are excluded from this criterion because the Stack_Validator does not return them.

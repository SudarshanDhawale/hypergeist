# Requirements Document

## Introduction

This document specifies local persistence for HyperGeist: stacks survive a page reload, the first run is seeded with the showcase stacks, stacks can be exported to and imported from JSON files, deleted stacks go to a trash with restore, and a "restore demo stacks" action resets the bundled stacks. Everything is stored in the browser's IndexedDB and is private to that browser.

**Status: open questions answered (2026-11-15). Design and tasks are written.**

**Dependencies.** This spec uses `stack-format-and-validator` (`parseStack`, `serializeStack`, `validateStack`) and `stack-engine` (`remixStack`, `createStack`) without redefining them. Steering rules apply: IndexedDB through `idb`, default-deny parsing at every trust boundary (including IndexedDB reads), no secrets in a stack or an export, and honest limits stated in the app.

**Out of scope.** Share links and the share store (spec `share-and-remix`). Saving the user's API key and base URL (spec `ai-orchestrator`; they never go into the stacks store or an export). Syncing between browsers or devices. Live sync between two open tabs. Undo history. Choosing which stack to open (spec `retro-ui-shell`); this spec supplies the data and the store API.

## Glossary

- **Stack_Store**: The module in `apps/web` that reads and writes stacks in IndexedDB. Its functions return result values (`{ ok: true, value } | { ok: false, errors }`) and never throw for expected failures.
- **Stack_Record**: One stored stack: the Stack, a `savedAt` timestamp supplied by the caller, and `origin` (`seed` or `user`).
- **Trash_Record**: A Stack_Record that was deleted by the user and can be restored, with a `deletedAt` timestamp.
- **Seed_Set**: The bundled showcase stacks, one JSON file each in a folder of the web app. Adding a file to the folder adds a stack to the Seed_Set with no code change.
- **Quarantine**: A separate store where a record that fails validation on read is kept unchanged, so no data is lost and no invalid stack reaches the UI.
- **Memory_Mode**: The fallback in which stacks live only in memory because IndexedDB is unavailable or blocked.
- **Export_File**: A UTF-8 text file with the canonical JSON of exactly one stack, produced by `serializeStack`.

## Requirements

### Requirement 1: Store stacks in IndexedDB

**User Story:** As a user, I want my stacks to still be there after I reload the page, so that I can keep using them.

#### Acceptance Criteria

1. THE Stack_Store SHALL keep Stack_Records in an IndexedDB database through the `idb` library, keyed by Stack `id`.
2. WHEN the Stack_Store saves a Stack, THE Stack_Store SHALL first check the Stack with `validateStack` and SHALL write nothing and return the Validation_Errors if the Stack is invalid.
3. WHEN the Stack_Store loads a Stack_Record, THE Stack_Store SHALL parse the stored Stack with `parseStack` before returning it.
4. IF a stored record fails `parseStack`, THEN THE Stack_Store SHALL move the unchanged record to the Quarantine, omit it from the list of stacks, and report it as a problem the UI can show.
5. THE Stack_Store SHALL take every timestamp from its caller and SHALL NOT read a clock itself.
6. THE Stack_Store SHALL list stacks with their `id`, `name`, `savedAt`, and `origin`, without parsing every card of every stack more than once per list call.
7. THE Stack_Store SHALL carry a database version number and an upgrade path, so that a later release can change the record shape without losing stacks.

### Requirement 2: Autosave

**User Story:** As a user, I want my changes saved without pressing a button, so that I do not lose work.

#### Acceptance Criteria

1. WHEN the open Stack changes, THE app SHALL save it within 1 second of the last change, and SHALL combine several changes made within that time into one write.
2. WHEN the page is hidden or closed, THE app SHALL start a write of any pending save at once, and SHALL say in its Limits text that a browser may end the page before that write finishes.
3. THE app SHALL show a save state of "Saved", "Saving", or "Not saved" in the stack window.
4. IF a save fails, THEN THE app SHALL keep the Stack in memory, show "Not saved" with the reason in plain words, and retry on the next change.
5. IF the browser reports that storage is full, THEN THE app SHALL say so and SHALL offer to export the open stack as an Export_File.

### Requirement 3: First-run seeding

**User Story:** As a reviewer opening the app for the first time, I want example stacks to be ready, so that I can try the app in one click.

#### Acceptance Criteria

1. WHEN the app opens and the database holds no stacks and has no seeding marker, THE Stack_Store SHALL write every stack of the Seed_Set with `origin` `seed` and then write the seeding marker.
2. THE Stack_Store SHALL seed only once per database, so that a stack the user deleted does not come back on the next reload.
3. THE Stack_Store SHALL validate every Seed_Set stack with `parseStack` before writing it, and a test SHALL fail if any bundled stack is invalid.
4. IF seeding fails part way, THEN THE Stack_Store SHALL write nothing and no marker, so the next start tries again.
5. THE database SHALL contain no data from the developer's browser: it starts empty in every new browser profile.

### Requirement 4: Restore demo stacks

**User Story:** As a reviewer who changed or deleted the examples, I want to put them back, so that I can see the original demo again.

#### Acceptance Criteria

1. WHEN the user chooses "Restore demo stacks", THE app SHALL ask for confirmation and say that the bundled stacks are replaced by their original versions.
2. WHEN the user confirms, THE Stack_Store SHALL replace each Seed_Set stack with the same `id` by the bundled version and add any missing one, in one transaction.
3. THE Stack_Store SHALL NOT change or delete any stack whose `id` is not in the Seed_Set.
4. WHEN a Seed_Set stack is replaced, THE Stack_Store SHALL move the replaced version to the trash, so the user can restore their edits.

### Requirement 5: Trash and restore

**User Story:** As a user, I want a deleted stack to be recoverable, so that a mis-click does not destroy my work.

#### Acceptance Criteria

1. WHEN the user deletes a stack, THE Stack_Store SHALL move it to the trash in one transaction, so that it is never in both places or in neither.
2. THE Stack_Store SHALL list Trash_Records with `id`, `name`, and `deletedAt`.
3. WHEN the user restores a Trash_Record whose `id` is not in use, THE Stack_Store SHALL move it back to the stacks.
4. IF the `id` of a restored Trash_Record is in use, THEN THE Stack_Store SHALL restore it under a new `id` made with `remixStack`, supplied by the caller, and keep `remixedFrom` as `remixStack` sets it.
5. WHEN the user empties the trash or deletes one Trash_Record permanently, THE app SHALL ask for confirmation first, and the Stack_Store SHALL then delete it.
6. THE Stack_Store SHALL keep at most 50 Trash_Records, and when a new one would exceed that, SHALL delete the oldest and tell the caller which one.

### Requirement 6: Export a stack

**User Story:** As a user, I want to download a stack as a file, so that I have a backup and can move it to another browser.

#### Acceptance Criteria

1. WHEN the user exports a stack, THE app SHALL produce an Export_File with `serializeStack`, named from the stack `name` and `id` with only the characters `a-z`, `0-9`, `-`, and `_`, and the extension `.hypergeist.json`.
2. THE Export_File SHALL contain the stack only: no API key, base URL, setting, timestamp of saving, or record metadata.
3. IF the stack is invalid, THEN THE app SHALL NOT produce a file and SHALL show the first Validation_Error in plain words.

### Requirement 7: Import a stack

**User Story:** As a user, I want to open a stack file I received, so that I can use it.

#### Acceptance Criteria

1. THE app SHALL treat an imported file as untrusted data and SHALL parse it with `parseStack` before it is stored or shown.
2. THE app SHALL reject a file larger than 5 MB, before reading its content into a parser, and say so.
3. IF the file is not valid JSON or not a valid Stack, THEN THE app SHALL store nothing and SHALL show up to 5 Validation_Errors with their `path`, `message`, and `hint`, and SHALL say if more were left out.
4. IF the imported `id` is already in use, THEN THE app SHALL ask whether to import it as a copy (new `id` from `remixStack`, supplied by the caller) or cancel, and SHALL NOT overwrite an existing stack.
5. WHEN an import succeeds, THE Stack_Store SHALL save it with `origin` `user` and the app SHALL open it.
6. THE app SHALL never run code from an imported file; a stack is data and its actions only run when the user presses a button.
7. FOR ALL valid stacks, export followed by import SHALL give a stack deeply equal to the original (property test with a fixed or reported seed).

### Requirement 8: Storage unavailable

**User Story:** As a user in a private window or a browser that blocks storage, I want the app to still work and tell me the truth, so that I do not lose work by surprise.

#### Acceptance Criteria

1. IF IndexedDB cannot be opened, THEN THE app SHALL switch to Memory_Mode, load the Seed_Set into memory, and show a message in the stack window that changes are lost when the page closes.
2. WHILE in Memory_Mode, THE app SHALL still offer export and import, and SHALL remind the user to export before closing.
3. IF a database upgrade is blocked by another open tab, THEN THE app SHALL tell the user to close the other tab and try again.
4. THE app SHALL state in its Limits text that stacks live only in this browser, that clearing the browser's site data deletes them, and that two tabs editing the same stack overwrite each other (the last save wins).

### Requirement 9: Verification

**User Story:** As the Developer, I want persistence proven by tests that can run without a real browser database, so that I can trust it before I check it by hand.

#### Acceptance Criteria

1. THE Stack_Store SHALL have unit tests against an in-memory IndexedDB test double, and the double SHALL be `fake-indexeddb`, the single new development dependency, approved by the Developer on 2026-11-15.
2. THE tests SHALL cover each acceptance criterion in Requirements 1 to 8, including an invalid stored record going to the Quarantine, a seeding failure part way, a failed save leaving the earlier record intact, and trash overflow.
3. A Playwright test against the recorded-response provider SHALL cover: first run shows the seeded stacks, an edit survives a reload, delete then restore, restore demo stacks, export then import of the same file, and an invalid import showing errors.
4. THE Developer SHALL verify the manual cases listed in the design (private window, storage cleared, two tabs, a corrupted record) in a real browser before submission.

## Decisions made by the Developer (2026-11-15)

1. **Test double.** Add `fake-indexeddb` as a dev dependency of `apps/web`. The Developer runs the install.
2. **Limits.** Import file 5 MB, trash of 50 stacks, autosave 1 second after the last change.
3. **Two tabs.** Last save wins. The app states this in its Limits text. No live sync.
4. **Seed set.** A folder of bundled JSON files. Adding a file adds a demo stack with no code change.
5. **Blocked storage.** Memory_Mode with a clear banner. The app still opens, and export and import still work.

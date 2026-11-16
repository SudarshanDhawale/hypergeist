# Design Document

## Overview

This design adds local persistence to `apps/web`. A small repository module stores stacks in IndexedDB through `idb`, with an in-memory twin that has the same interface for the case where IndexedDB is blocked. A boot step opens the repository, seeds the demo stacks on first run, and hands the open stack to the existing UI. An autosave scheduler watches the open stack and writes it. A minimal "Stacks" window lets the user open, export, delete, import, restore the demo stacks and use the trash. The full retro desktop (icons, drag, trash icon) belongs to the later `retro-ui-shell` spec, which will restyle this window and reuse the same repository.

Nothing in `packages/shared` changes. The repository uses `parseStack`, `serializeStack`, `validateStack` and `remixStack` from the shared package. Steering applies: `idb` is already in the locked tech stack, every read from IndexedDB is parsed with the shared schema, and the design-language file applies to the new UI.

**New dependencies (the Developer runs the install, never the agent shell):**
- `idb` in `apps/web` dependencies (locked in `tech-stack`, not installed yet).
- `fake-indexeddb` in `apps/web` devDependencies (approved 2026-11-15).

## Architecture

```
apps/web/src/persistence/
  types.ts              Result, PersistenceError, StackRecord, TrashRecord, StackSummary, Repository
  idb-repository.ts     Repository over IndexedDB (idb), one transaction per operation
  memory-repository.ts  Repository over Maps (Memory_Mode and tests)
  open-repository.ts    Tries IndexedDB, falls back to memory, reports why
  seed-set.ts           Reads the bundled JSON files, parses each one
  autosave.ts           Debounced, serialized writes; save state
  export-stack.ts       File name and text of an Export_File (pure)
  import-stack.ts       Size check, parse, id-conflict plan (pure)
  free-id.ts            Picks an unused Entity_ID (pure)
  boot.ts               open + seed + list + pick the stack to open
apps/web/src/state/
  save-state-store.ts   Zustand store: 'saved' | 'saving' | 'not-saved' + reason
apps/web/src/components/
  AppRoot.tsx           Runs boot, shows "Opening your stacks...", then the app
  StacksWindow.tsx      Open, export, delete, import, restore demo, trash
  SaveIndicator.tsx     The save state in the stack window
  MemoryModeBanner.tsx  The Memory_Mode message
```

Dependency rules: the persistence folder imports only `@hypergeist/shared/format`, `@hypergeist/shared/engine` and `idb`. It imports no React. Timers and `Date.now()` live only in `boot.ts`, `autosave.ts` and the components; the repositories take `now` from the caller (Requirement 1.5).

The existing `App` keeps its `stackText` prop so its tests stay as they are. `main.tsx` renders the new `AppRoot`, which boots persistence and renders the same Desktop with the opened stack. The stack store is created once. Opening, importing or restoring a stack calls `replaceStack` on it (card, mode and selection reset), so the Stacks window and its notices stay mounted. The autosave is recreated for each opened stack, and the load itself is not saved as an edit.

## Data model

Database `hypergeist`, version 1. Object stores:

| Store | Key | Value |
|---|---|---|
| `stacks` | `stack.id` (key path) | `StackRecord`: `{ stack, savedAt, origin }` |
| `trash` | auto-increment number | `TrashRecord`: `{ stack, savedAt, origin, deletedAt }` |
| `quarantine` | auto-increment number | `{ record: unknown, errors, quarantinedAt }` |
| `meta` | string | `seeded` (boolean), `lastOpenedId` (string) |

`savedAt`, `deletedAt` and `quarantinedAt` are milliseconds since the epoch, supplied by the caller. `origin` is `'seed'` or `'user'`. The trash uses an auto-increment key and not the stack id, because the same id can be in the trash more than once (restore demo, then delete the same stack).

An upgrade function `upgrade(db, oldVersion)` creates the stores for version 1 and is the place for later migrations (Requirement 1.7). A test opens a version 0 database and upgrades it.

## Repository interface

Every method returns `Promise<Result<T>>` where `Result<T> = { ok: true; value: T } | { ok: false; errors: PersistenceError[] }`. Expected failures never throw. A `PersistenceError` has a `code` (`INVALID_STACK`, `ID_IN_USE`, `NOT_FOUND`, `QUOTA_EXCEEDED`, `STORAGE_FAILED`), a plain-language `message`, and, for `INVALID_STACK`, the `Validation_Error` list.

| Method | Behavior |
|---|---|
| `list(now)` | Reads every record, runs `parseStack` once per record. Valid ones become `StackSummary` (`id`, `name`, `savedAt`, `origin`). Invalid ones move unchanged to `quarantine` in the same transaction and are returned as `problems` (Req 1.3, 1.4, 1.6). |
| `load(id)` | One record, parsed with `parseStack`. Invalid: quarantined, error returned. |
| `save(stack, now)` | `validateStack` first (Req 1.2). Replaces the record with the same id and keeps its `origin`. A new id gets `origin: 'user'`. |
| `create(stack, now)` | Like `save` but `ID_IN_USE` if the id exists. Used by import. |
| `moveToTrash(id, now)` | One transaction: delete from `stacks`, add to `trash`, and delete the oldest trash records beyond 50. Returns the dropped ones (Req 5.1, 5.6). |
| `listTrash()` | `{ key, id, name, deletedAt }`, newest first. |
| `restoreFromTrash(key, now, newId?)` | One transaction. If the id is free, move it back. If it is in use and `newId` is given, store `remixStack(stack, newId)`. If in use and no `newId`, `ID_IN_USE` (Req 5.3, 5.4). |
| `deleteForever(key)`, `emptyTrash()` | Remove trash records. The UI asks for confirmation first. |
| `seedIfNeeded(seeds, now)` | One transaction over `stacks` and `meta`. If `seeded` is not set and `stacks` is empty: write all seeds with `origin: 'seed'`, then set `seeded`. Any failure aborts the transaction, so no marker is left (Req 3.1 to 3.4). |
| `restoreDemo(seeds, now)` | One transaction over `stacks` and `trash`. For each seed: if a record with that id exists, move it to the trash, then write the seed. Other ids are not touched (Req 4.2 to 4.4). |
| `getMeta(key)`, `setMeta(key, value)` | Small values such as `lastOpenedId`. |
| `close()` | Closes the database. |

Quota errors (`QuotaExceededError`) map to `QUOTA_EXCEEDED`; any other storage error maps to `STORAGE_FAILED` with a short message and no stack trace shown to the user.

`memory-repository.ts` implements the same interface over `Map`s, with `structuredClone` on every read and write so callers cannot mutate stored data. One shared contract test suite (`repository.contract.test.ts`) runs against both implementations, so the memory twin cannot drift from the real one.

## Opening the database and Memory_Mode

`openRepository(options)` returns `{ repository, mode: 'indexeddb' | 'memory', reason? }`.
1. If `indexedDB` is undefined, or `openDB` rejects, return the memory repository with `mode: 'memory'` and a short reason (Req 8.1).
2. `openDB` is given `blocked` and `blocking` callbacks. `blocking` closes this connection so another tab can upgrade. `blocked` reports "close the other tab and reload" through the boot result (Req 8.3).
3. A probe write is not used. If the first real write fails, the save state shows "Not saved" with the reason (Req 2.4), and the user can export.

In Memory_Mode the boot step loads the Seed_Set into the memory repository, so the UI code path is identical. `MemoryModeBanner` is shown in the stack window with the text "Changes are lost when you close this page. Export before leaving." Export and import stay available (Req 8.2).

## Seed set

`seed-set.ts` uses `import.meta.glob('../stacks/*.json', { query: '?raw', import: 'default', eager: true })`, so every JSON file in `apps/web/src/stacks/` is a demo stack. Adding a file adds a stack with no code change (Req 3, Developer decision 4). Each file is parsed with `parseStack`; the result is `{ stacks, problems }`. A unit test fails if `problems` is not empty (Req 3.3). The boot step seeds only the valid stacks and reports problems to the console in development.

Known limit, stated in the journal and the README: a user who already seeded keeps their copy when a later release changes a bundled stack. "Restore demo stacks" is the way to get the new version, and it moves the old copy to the trash.

## Autosave

`createAutosave({ write, debounceMs: 1000, onState })` returns `{ notify(stack), flush(), dispose() }`.
- `notify(stack)` remembers the newest stack and restarts a 1-second timer. Several changes inside that time give one write of the last value (Req 2.1).
- Writes run one at a time through a promise chain. A change that arrives during a write schedules the next write after it, so an older value can never overwrite a newer one.
- `flush()` writes immediately if a change is pending. `AppRoot` calls it on `visibilitychange` (hidden) and `pagehide` (Req 2.2). Honest limit: browsers may end the page before an IndexedDB write finishes, so the last second of work can be lost when a tab is closed. The UI states this in the Limits text, and the "Saved" label tells the user when it is safe.
- State: `saved` after a successful write with nothing pending, `saving` while a change is waiting or being written, `not-saved` with a reason after a failure. A failure keeps the stack in memory, does not retry by itself, and the next change tries again (Req 2.4). `QUOTA_EXCEEDED` sets the reason "The browser's storage is full" and makes the indicator offer Export (Req 2.5).
- The scheduler uses `setTimeout` and `clearTimeout` injected through options, so tests use Vitest fake timers.

The autosave subscribes to the Zustand store and calls `notify` when the `stack` reference changes. Mode, current card and selection are not saved: after a reload the stack opens on its start card in Interact mode. The Limits text says so.

## Export and import

**Export** (`export-stack.ts`, pure): `exportStack(stack)` runs `serializeStack`. On success it returns `{ filename, text }`; on failure the first `Validation_Error` as a plain sentence (Req 6.3). The file name is `<slug>-<id>.hypergeist.json`. The slug is the stack name lower-cased, every run of characters outside `a-z0-9` replaced by `-`, trimmed of `-`, cut to 40 characters; an empty slug leaves just `<id>`. The id already matches `^[a-z0-9][a-z0-9_-]{0,63}$`, so the name only contains `a-z`, `0-9`, `-` and `_` (Req 6.1). The text is the canonical JSON of the stack and nothing else, so no setting, key or record metadata can reach it (Req 6.2). The component downloads it with a `Blob` and a temporary anchor.

**Import** (`import-stack.ts`, pure parts) and the component:
1. The component checks `file.size <= 5 * 1024 * 1024` before it calls `file.text()` (Req 7.2).
2. `parseStack(text)`. On failure: store nothing, show up to 5 errors with `path`, `message` and `hint`, and "and N more" if `truncated` or more exist (Req 7.3).
3. `planImport(stack, existingIds)` returns `{ kind: 'new' }` or `{ kind: 'conflict', suggestedId }`. `suggestedId` comes from `free-id.ts`: the stack id plus `-copy`, then `-copy-2`, and so on, cut so the result still matches the id pattern and is not in `existingIds`.
4. On conflict a dialog offers "Import as a copy" or "Cancel". A copy is `remixStack(stack, suggestedId)` and then `create`. Nothing is ever overwritten (Req 7.4).
5. On success `create(stack, now)` with `origin: 'user'`, then the app opens it (Req 7.5).
6. Imported data is never executed. The only code path from an imported stack is the normal render and the button handlers the user presses (Req 7.6).

## Stacks window (minimal UI)

A modal window opened from a "Stacks" button next to the mode control in the menu bar, using the design-language dialog look: paper window, 2 px ink border, hard shadow, dithered scrim, double border on the default button, sentence-case title "Stacks". No new colors, no `--ghost` in any `.tsx` file.

- **Stacks list.** One row per stack: name, "Demo" or "Yours" label, saved time, and buttons Open, Export, Delete. The open stack is marked "Open".
- **Import** button (file input, `.json`), **Restore demo stacks** button (confirm dialog, Req 4.1), **Trash** section.
- **Trash list.** Name, deleted time, Restore, Delete permanently, and Empty trash, each with a confirm for permanent deletion (Req 5.5). Restore into a used id asks for a copy (same dialog as import).
- **Problems.** Quarantined records appear as a line "N stacks could not be read and were set aside" (Req 1.4).
- Keyboard: every control is a real `button` or `input`; Escape closes; focus returns to the Stacks button. Touch targets are at least 24 px (design-language section 11).
- Deleting the open stack opens another stack, or creates a new empty one with `createStack` if none is left, so the app always has a stack.

The window is plain on purpose. `retro-ui-shell` will turn the list into desktop icons and the trash into the trash icon, using the same repository calls.

## Changes to existing behavior and tests

The thin slice said "Changes are not saved. Reloading the page resets this stack." That is no longer true in IndexedDB mode. These places change:

| Place | Change |
|---|---|
| `StackWindow.tsx` (the `note` text) | Replaced by `SaveIndicator`. In Memory_Mode the banner text is shown. |
| `thin-slice-todo.json` Limits card text | Rewritten to the real limits (stored in this browser only, last save wins between two tabs, last second may be lost on close). |
| `demo-stack.test.ts`, `StackWindow.test.tsx`, `App.startup.test.tsx` | Expectations updated to the new text. |
| `e2e/thin-slice.spec.ts` "a reload resets the stack..." | Replaced by "a reload keeps the added item" and new persistence tests. Each Playwright test runs in a fresh browser context, so each starts with an empty database and the seeded stack. |
| `README.md` "Limits of the thin slice" | "No saving" is replaced by the actual storage limits. |

## Correctness properties

Property tests use fast-check with the shared seed helper (`assertProperty`) and `arbStack` from `packages/shared/test-support`. The tests run against `fake-indexeddb` and the memory repository.

- **P1. Export then import is lossless.** For every valid stack, `parseStack(exportStack(stack).text)` equals the stack. (Req 7.7)
- **P2. Save then load is lossless.** For every valid stack, `save` then `load` gives a deeply equal stack, in both repositories.
- **P3. A rejected save changes nothing.** For every invalid candidate (use `arbCandidate`), `save` returns errors and a stored earlier record is still equal to what it was. (Req 1.2)
- **P4. Model-based sequence.** For random sequences of `save`, `create`, `moveToTrash`, `restoreFromTrash`, `restoreDemo` and `deleteForever`, the IndexedDB and memory repositories give the same `list` and `listTrash` after every step, every listed stack passes `validateStack`, and the trash never holds more than 50 records.
- **P5. File names are safe.** For every stack name and id, the file name matches `^[a-z0-9_-]+\.hypergeist\.json$`, and the part before the extension has at most 105 characters.
- **P6. Free ids are free.** `suggestFreeId(base, taken)` returns a string that matches the id pattern and is not in `taken`.

Example tests (not optional): seeding once and not again after a delete, seeding failing part way (a poisoned record aborts the transaction and leaves no marker), an invalid stored record going to the quarantine, trash overflow dropping the oldest, restore into a used id, restore demo moving the edited copy to the trash, the autosave coalescing and serialization cases, a failed write keeping the stack in memory, the quota path, the upgrade from version 0, open failure falling back to Memory_Mode.

Playwright (recorded-response provider, never a live model): first run shows the seeded stack; an added item survives a reload; delete then restore; restore demo stacks; export then import the downloaded file; an invalid import shows errors and stores nothing.

## Manual verification list for the Developer (Req 9.4)

1. Fresh profile or private window: the demo stack opens in one click. Reload keeps an added item (normal window) or shows the Memory_Mode banner (if the browser blocks storage).
2. Delete the demo stack, reload: it does not come back. Trash shows it. Restore brings it back.
3. Edit the demo stack, choose Restore demo stacks: the original returns and your edited copy is in the trash.
4. Export, delete the stack permanently, import the file: identical stack, same content.
5. Import a file that is not JSON, a stack with a wrong property, and a file over 5 MB: each shows a clear message and stores nothing.
6. Import a stack whose id is in use: the copy dialog appears, cancel changes nothing.
7. Two tabs on the same stack: the last save wins, as the Limits text says.
8. DevTools: clear site data, reload: back to the seeded stack. Edit a stored record by hand to be invalid, reload: the "set aside" line appears and the app still opens.
9. DevTools "offline" does not matter: no network is used by persistence.
10. Close a tab right after typing: the "Saved" label is the guide; the last second may be missing.

## Out of scope reminders

Share links, API key storage, desktop icons and drag, undo, and live sync between tabs are other specs.

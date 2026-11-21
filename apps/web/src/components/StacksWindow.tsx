import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, JSX } from 'react';
import { createStack, remixStack } from '@hypergeist/shared/engine';
import type { Stack, ValidationError } from '@hypergeist/shared/format';
import { downloadText } from '../lib/download-text.ts';
import { formatTimestamp } from '../lib/format-time.ts';
import { exportStack } from '../persistence/export-stack.ts';
import { suggestFreeId } from '../persistence/free-id.ts';
import { checkImportSize, parseImport, planImport } from '../persistence/import-stack.ts';
import type {
  PersistenceError,
  Repository,
  StackSummary,
  TrashSummary,
} from '../persistence/types.ts';
import { useAi } from '../state/AiContext.tsx';
import { usePersistence } from '../state/PersistenceContext.tsx';
import type { PersistenceValue } from '../state/PersistenceContext.tsx';
import { ConfirmDialog } from './ConfirmDialog.tsx';
import { CopyDialog } from './CopyDialog.tsx';
import { MakeStackSection } from './MakeStackSection.tsx';
import { Modal } from './Modal.tsx';

export type StacksWindowProps = {
  readonly onClose: () => void;
};

type Listing = {
  readonly stacks: readonly StackSummary[];
  /** Records that could not be read and were set aside. */
  readonly problems: number;
  readonly trash: readonly TrashSummary[];
};

type Notice = { readonly tone: 'info' | 'error'; readonly text: string };

type ImportProblems = { readonly errors: readonly ValidationError[]; readonly more: number };

type Overlay =
  | { readonly kind: 'restore-demo' }
  | { readonly kind: 'delete-forever'; readonly item: TrashSummary }
  | { readonly kind: 'empty-trash'; readonly items: readonly TrashSummary[] }
  | { readonly kind: 'copy-import'; readonly stack: Stack; readonly suggestedId: string }
  | { readonly kind: 'copy-restore'; readonly item: TrashSummary; readonly suggestedId: string };

/** The part of a `File` the import reads. A plain object with these fields works in tests. */
type ImportFile = { readonly size: number; text(): Promise<string> };

const FALLBACK_MESSAGE = "Something went wrong while using this browser's storage.";
const FRESH_STACK_ID = 'my-stack';
const FRESH_STACK_NAME = 'My stack';
const MAX_NAMES_IN_CONFIRM = 5;

function messageOf(errors: readonly PersistenceError[]): string {
  return errors[0]?.message ?? FALLBACK_MESSAGE;
}

function quoted(name: string): string {
  return `"${name}"`;
}

/** `"A", "B" and 3 more`, for a confirm text that names what is lost. */
function nameList(items: readonly TrashSummary[]): string {
  const shown = items.slice(0, MAX_NAMES_IN_CONFIRM).map((item) => quoted(item.name));
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/** Runs the `beforeAction` hook, if any. A failing hook must not block the action. */
async function settle(hook: (() => Promise<void>) | undefined): Promise<void> {
  if (hook === undefined) return;
  try {
    await hook();
  } catch {
    // The hook reports its own failures (the save indicator). The action goes on.
  }
}

async function readListing(
  repository: Repository,
  now: () => number,
): Promise<{ ok: true; listing: Listing } | { ok: false; message: string }> {
  const listed = await repository.list(now());
  if (!listed.ok) return { ok: false, message: messageOf(listed.errors) };
  const trash = await repository.listTrash();
  if (!trash.ok) return { ok: false, message: messageOf(trash.errors) };
  return {
    ok: true,
    listing: {
      stacks: listed.value.stacks,
      problems: listed.value.problems.length,
      trash: trash.value,
    },
  };
}

/**
 * The Stacks window: a modal list of stored stacks with Open, Export and Delete, Import,
 * Restore demo stacks, the trash, and a line for records that were set aside. It renders
 * nothing without a `PersistenceProvider`.
 */
export function StacksWindow({ onClose }: StacksWindowProps): JSX.Element | null {
  const persistence = usePersistence();
  if (persistence === null) return null;
  return <StacksDialog persistence={persistence} onClose={onClose} />;
}

function StacksDialog({
  persistence,
  onClose,
}: {
  readonly persistence: PersistenceValue;
  readonly onClose: () => void;
}): JSX.Element {
  const { repository, seeds, openStackId, now, onOpenStack, onStacksChanged, beforeAction } =
    persistence;
  const ai = useAi();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const busyRef = useRef(false);

  const [listing, setListing] = useState<Listing | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [importProblems, setImportProblems] = useState<ImportProblems | null>(null);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Without a hook the read starts at once, as it did before the hook existed.
    const first =
      beforeAction === undefined
        ? readListing(repository, now)
        : settle(beforeAction).then(() => readListing(repository, now));
    void first.then((read) => {
      if (cancelled) return;
      if (read.ok) setListing(read.listing);
      else setNotice({ tone: 'error', text: read.message });
    });
    return () => {
      cancelled = true;
    };
    // Loaded once per repository. `now` is a clock and does not change what is listed.
  }, [repository]);

  /** Reads the lists again. Returns what was read, or `null` after showing the reason. */
  async function refresh(): Promise<Listing | null> {
    const read = await readListing(repository, now);
    if (!read.ok) {
      setNotice({ tone: 'error', text: read.message });
      return null;
    }
    setListing(read.listing);
    return read.listing;
  }

  function fail(errors: readonly PersistenceError[]): void {
    setNotice({ tone: 'error', text: messageOf(errors) });
  }

  function info(text: string): void {
    setNotice({ tone: 'info', text });
  }

  /** Runs one action at a time and clears the old messages first. */
  async function run(task: () => Promise<void>): Promise<void> {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setImportProblems(null);
    try {
      if (beforeAction !== undefined) await settle(beforeAction);
      await task();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function openAndClose(stack: Stack): void {
    onOpenStack(stack);
    onClose();
  }

  // ---- Stacks ----

  function openStack(item: StackSummary): Promise<void> {
    return run(async () => {
      const loaded = await repository.load(item.id);
      if (!loaded.ok) {
        fail(loaded.errors);
        await refresh();
        return;
      }
      openAndClose(loaded.value);
    });
  }

  function exportOne(item: StackSummary): Promise<void> {
    return run(async () => {
      const loaded = await repository.load(item.id);
      if (!loaded.ok) {
        fail(loaded.errors);
        await refresh();
        return;
      }
      const exported = exportStack(loaded.value);
      if (!exported.ok) {
        setNotice({ tone: 'error', text: exported.message });
        return;
      }
      downloadText(exported.filename, exported.text);
      info(`Exported ${exported.filename}.`);
    });
  }

  /** After the open stack was deleted: open another stored stack, or make a new empty one. */
  async function openReplacement(deletedId: string): Promise<boolean> {
    const listed = await repository.list(now());
    if (!listed.ok) {
      fail(listed.errors);
      return false;
    }
    const remaining = listed.value.stacks.filter((summary) => summary.id !== deletedId);
    for (const summary of remaining) {
      const loaded = await repository.load(summary.id);
      if (loaded.ok) {
        onOpenStack(loaded.value);
        return true;
      }
    }
    const ids = new Set(remaining.map((summary) => summary.id));
    const id = ids.has(FRESH_STACK_ID) ? suggestFreeId(FRESH_STACK_ID, ids) : FRESH_STACK_ID;
    const made = createStack({ id, name: FRESH_STACK_NAME });
    if (!made.ok) {
      setNotice({ tone: 'error', text: made.errors[0]?.message ?? FALLBACK_MESSAGE });
      return false;
    }
    const stored = await repository.create(made.stack, now());
    if (!stored.ok) {
      fail(stored.errors);
      return false;
    }
    onOpenStack(made.stack);
    return true;
  }

  function deleteStack(item: StackSummary): Promise<void> {
    return run(async () => {
      const moved = await repository.moveToTrash(item.id, now());
      if (!moved.ok) {
        fail(moved.errors);
        return;
      }
      if (item.id === openStackId && !(await openReplacement(item.id))) {
        await refresh();
        return;
      }
      onStacksChanged?.();
      info(`Moved ${quoted(item.name)} to the trash.`);
      await refresh();
    });
  }

  // ---- Import ----

  function chooseFile(): void {
    fileInputRef.current?.click();
  }

  function onFileChosen(event: ChangeEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const file: ImportFile | undefined = input.files?.[0];
    // Clear the input so the same file can be chosen again after a refusal.
    const clear = () => {
      input.value = '';
    };
    if (file === undefined) return;
    void run(async () => {
      // The size is checked before the content is read into memory.
      const size = checkImportSize(file.size);
      if (!size.ok) {
        setNotice({ tone: 'error', text: size.message });
        clear();
        return;
      }
      let text: string;
      try {
        text = await file.text();
      } catch {
        setNotice({ tone: 'error', text: 'The file could not be read.' });
        clear();
        return;
      }
      clear();
      const parsed = parseImport(text);
      if (!parsed.ok) {
        setImportProblems({ errors: parsed.errors, more: parsed.more });
        return;
      }
      const current = await refresh();
      if (current === null) return;
      const plan = planImport(
        parsed.stack,
        current.stacks.map((summary) => summary.id),
      );
      if (plan.kind === 'conflict') {
        setOverlay({ kind: 'copy-import', stack: parsed.stack, suggestedId: plan.suggestedId });
        return;
      }
      await storeImported(parsed.stack);
    });
  }

  async function storeImported(stack: Stack): Promise<void> {
    const stored = await repository.create(stack, now());
    if (!stored.ok) {
      fail(stored.errors);
      return;
    }
    onStacksChanged?.();
    await refresh();
    openAndClose(stack);
  }

  function importAsCopy(stack: Stack, suggestedId: string): Promise<void> {
    return run(async () => {
      const copy = remixStack(stack, suggestedId);
      if (!copy.ok) {
        setNotice({ tone: 'error', text: copy.errors[0]?.message ?? FALLBACK_MESSAGE });
        return;
      }
      await storeImported(copy.stack);
    });
  }

  // ---- Make a stack with the Ghost ----

  /**
   * Runs the new-stack Turn, stores the stack and opens it. The Turn does not hold the window's
   * busy flag, so the rest of the window stays usable while it runs. Resolves with a message when
   * nothing was opened, or `null` when the stack was opened.
   */
  async function makeWithGhost(text: string): Promise<string | null> {
    if (ai === null) return null;
    await settle(beforeAction);
    const listed = await repository.list(now());
    if (!listed.ok) return messageOf(listed.errors);
    const outcome = await ai.controller.makeStack(text, {
      takenIds: listed.value.stacks.map((summary) => summary.id),
    });
    const { stack } = outcome;
    if (stack === null) return outcome.message;
    const state: { opened: boolean; problem: string | null } = { opened: false, problem: null };
    await run(async () => {
      const stored = await repository.create(stack, now());
      if (!stored.ok) {
        state.problem = messageOf(stored.errors);
        return;
      }
      onStacksChanged?.();
      state.opened = true;
      openAndClose(stack);
    });
    if (state.opened) return null;
    return state.problem ?? 'Another action is running in this window. Nothing was stored.';
  }

  // ---- Restore demo stacks ----

  function restoreDemo(): Promise<void> {
    return run(async () => {
      const restored = await repository.restoreDemo(seeds, now());
      if (!restored.ok) {
        fail(restored.errors);
        return;
      }
      const { replacedIds, addedIds } = restored.value;
      if (replacedIds.includes(openStackId)) {
        // The open stack was replaced in storage. Reload it so the old edits cannot be saved over it.
        const loaded = await repository.load(openStackId);
        if (loaded.ok) onOpenStack(loaded.value);
        else fail(loaded.errors);
      }
      onStacksChanged?.();
      const count = replacedIds.length + addedIds.length;
      info(
        `Restored ${count} demo ${plural(count, 'stack', 'stacks')}.` +
          (replacedIds.length > 0 ? ' The versions you had are in the trash.' : ''),
      );
      await refresh();
    });
  }

  // ---- Trash ----

  function restoreFromTrash(item: TrashSummary): Promise<void> {
    return run(async () => {
      const restored = await repository.restoreFromTrash(item.key, now());
      if (restored.ok) {
        onStacksChanged?.();
        info(`Restored ${quoted(item.name)}.`);
        await refresh();
        return;
      }
      if (restored.errors[0]?.code === 'ID_IN_USE') {
        const current = await refresh();
        const ids = new Set((current?.stacks ?? []).map((summary) => summary.id));
        setOverlay({ kind: 'copy-restore', item, suggestedId: suggestFreeId(item.id, ids) });
        return;
      }
      fail(restored.errors);
    });
  }

  function restoreAsCopy(item: TrashSummary, newId: string): Promise<void> {
    return run(async () => {
      const restored = await repository.restoreFromTrash(item.key, now(), newId);
      if (!restored.ok) {
        fail(restored.errors);
        await refresh();
        return;
      }
      onStacksChanged?.();
      info(`Restored ${quoted(item.name)} as a copy with the id "${newId}".`);
      await refresh();
    });
  }

  function deleteForever(item: TrashSummary): Promise<void> {
    return run(async () => {
      const deleted = await repository.deleteForever(item.key);
      if (!deleted.ok) {
        fail(deleted.errors);
        return;
      }
      info(`Deleted ${quoted(item.name)} permanently.`);
      await refresh();
    });
  }

  function emptyTrash(): Promise<void> {
    return run(async () => {
      const emptied = await repository.emptyTrash();
      if (!emptied.ok) {
        fail(emptied.errors);
        return;
      }
      info('The trash is empty.');
      await refresh();
    });
  }

  // ---- Render ----

  const stacks = listing?.stacks ?? [];
  const trash = listing?.trash ?? [];
  const problems = listing?.problems ?? 0;

  return (
    <>
      <Modal title="Stacks" onClose={onClose} className="stacks-window">
        <div className="dialog-body">
          <p className="stacks-help">
            Stacks are stored in this browser only. Export a stack to keep a copy elsewhere.
          </p>

          <div className="stacks-notices" aria-live="polite">
            {notice === null ? null : (
              <p
                className={
                  notice.tone === 'error' ? 'stacks-note stacks-note-error' : 'stacks-note'
                }
              >
                {notice.text}
              </p>
            )}
          </div>

          {importProblems === null ? null : (
            <div className="stacks-note stacks-note-error">
              <p>This file was not imported, and nothing was stored.</p>
              <ul className="stacks-errors" aria-label="Import problems">
                {importProblems.errors.map((error, index) => (
                  <li key={`${error.path}-${index}`}>
                    <code>{error.path === '' ? 'the file' : error.path}</code> {error.message}{' '}
                    {error.hint}
                  </li>
                ))}
              </ul>
              {importProblems.more > 0 ? <p>and {importProblems.more} more</p> : null}
            </div>
          )}

          {problems > 0 ? (
            <p className="stacks-note">
              {problems} {plural(problems, 'stack', 'stacks')} could not be read and{' '}
              {plural(problems, 'was', 'were')} set aside.
            </p>
          ) : null}

          <MakeStackSection onMake={makeWithGhost} />

          <ul className="stacks-list" aria-label="Stacks">
            {listing === null ? (
              <li className="stacks-empty">Loading stacks.</li>
            ) : stacks.length === 0 ? (
              <li className="stacks-empty">There are no stacks.</li>
            ) : (
              stacks.map((item) => (
                <li key={item.id} className="stacks-row">
                  <span className="stacks-name">{item.name}</span>
                  <span className="stacks-badge">{item.origin === 'seed' ? 'Demo' : 'Yours'}</span>
                  <span className="stacks-meta">Saved {formatTimestamp(item.savedAt)}</span>
                  {item.id === openStackId ? (
                    <span className="stacks-badge stacks-badge-open">Open</span>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Open ${item.name}`}
                      disabled={busy}
                      onClick={() => void openStack(item)}
                    >
                      Open
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Export ${item.name}`}
                    disabled={busy}
                    onClick={() => void exportOne(item)}
                  >
                    Export
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${item.name}`}
                    disabled={busy}
                    onClick={() => void deleteStack(item)}
                  >
                    Delete
                  </button>
                </li>
              ))
            )}
          </ul>

          <div className="stacks-actions">
            <button type="button" disabled={busy} onClick={chooseFile}>
              Import a stack
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setOverlay({ kind: 'restore-demo' })}
            >
              Restore demo stacks
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              aria-label="Stack file to import"
              hidden
              onChange={onFileChosen}
            />
          </div>

          <div className="stacks-trash-head">
            <h3>Trash</h3>
            <button
              type="button"
              disabled={busy || trash.length === 0}
              onClick={() => setOverlay({ kind: 'empty-trash', items: trash })}
            >
              Empty trash
            </button>
          </div>
          <ul className="stacks-list" aria-label="Trash">
            {listing === null ? (
              <li className="stacks-empty">Loading trash.</li>
            ) : trash.length === 0 ? (
              <li className="stacks-empty">The trash is empty.</li>
            ) : (
              trash.map((item) => (
                <li key={item.key} className="stacks-row">
                  <span className="stacks-name">{item.name}</span>
                  <span className="stacks-meta">Deleted {formatTimestamp(item.deletedAt)}</span>
                  <button
                    type="button"
                    aria-label={`Restore ${item.name}`}
                    disabled={busy}
                    onClick={() => void restoreFromTrash(item)}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${item.name} permanently`}
                    disabled={busy}
                    onClick={() => setOverlay({ kind: 'delete-forever', item })}
                  >
                    Delete permanently
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
        <div className="dialog-actions">
          <button type="button" className="button-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </Modal>

      {overlay?.kind === 'restore-demo' ? (
        <ConfirmDialog
          title="Restore demo stacks"
          message="The bundled demo stacks are replaced by their original versions. If you changed one, your version goes to the trash. Stacks that are not demo stacks are not changed."
          confirmLabel="Restore demo stacks"
          onCancel={() => setOverlay(null)}
          onConfirm={() => {
            setOverlay(null);
            void restoreDemo();
          }}
        />
      ) : null}

      {overlay?.kind === 'delete-forever' ? (
        <ConfirmDialog
          title="Delete permanently"
          message={`${quoted(overlay.item.name)} will be deleted for good. It cannot be restored.`}
          confirmLabel="Delete permanently"
          onCancel={() => setOverlay(null)}
          onConfirm={() => {
            const { item } = overlay;
            setOverlay(null);
            void deleteForever(item);
          }}
        />
      ) : null}

      {overlay?.kind === 'empty-trash' ? (
        <ConfirmDialog
          title="Empty the trash"
          message={`${overlay.items.length} ${plural(overlay.items.length, 'stack', 'stacks')} will be deleted for good and cannot be restored: ${nameList(overlay.items)}.`}
          confirmLabel="Empty trash"
          onCancel={() => setOverlay(null)}
          onConfirm={() => {
            setOverlay(null);
            void emptyTrash();
          }}
        />
      ) : null}

      {overlay?.kind === 'copy-import' ? (
        <CopyDialog
          kind="import"
          name={overlay.stack.name}
          id={overlay.stack.id}
          suggestedId={overlay.suggestedId}
          onCancel={() => setOverlay(null)}
          onCopy={() => {
            const { stack, suggestedId } = overlay;
            setOverlay(null);
            void importAsCopy(stack, suggestedId);
          }}
        />
      ) : null}

      {overlay?.kind === 'copy-restore' ? (
        <CopyDialog
          kind="restore"
          name={overlay.item.name}
          id={overlay.item.id}
          suggestedId={overlay.suggestedId}
          onCancel={() => setOverlay(null)}
          onCopy={() => {
            const { item, suggestedId } = overlay;
            setOverlay(null);
            void restoreAsCopy(item, suggestedId);
          }}
        />
      ) : null}
    </>
  );
}

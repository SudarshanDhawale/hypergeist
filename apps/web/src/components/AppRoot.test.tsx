import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { createSettingsRepository } from '../ai/index.ts';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { bootPersistence, LAST_OPENED_KEY } from '../persistence/boot.ts';
import type { BootOptions, BootResult } from '../persistence/boot.ts';
import { createMemoryRepository } from '../persistence/memory-repository.ts';
import type { MemoryRepository } from '../persistence/memory-repository.ts';
import type { SeedSet } from '../persistence/seed-set.ts';
import type { Result, StackSummary } from '../persistence/types.ts';
import { AppRoot } from './AppRoot.tsx';

const download = vi.hoisted(() => vi.fn());
vi.mock('../lib/download-text.ts', () => ({ downloadText: download }));

const baseStack: Stack = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) throw new Error('The bundled demo stack is not valid.');
  return parsed.value;
})();

function makeStack(id: string, name: string): Stack {
  return { ...structuredClone(baseStack), id, name };
}

const DEMO = makeStack('demo', 'Demo stack');
const OTHER = makeStack('other', 'Other stack');
const SAVED_AT = Date.UTC(2026, 10, 15, 14, 30);

const seedSetOf = (...stacks: Stack[]): SeedSet => ({
  stacks: stacks.map((stack) => ({ stack })),
  problems: [],
});

/**
 * All timers are fake and only move when a test calls `advance` or `until`, so the 1000 ms
 * debounce never depends on how fast the machine is. Testing-library's `waitFor` and `findBy*`
 * cannot be used here (they poll with timers); `until` is the replacement.
 */
beforeEach(() => {
  vi.useFakeTimers();
  download.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

type Setup = {
  readonly repository?: MemoryRepository;
  readonly seedSet?: SeedSet;
  readonly mode?: 'indexeddb' | 'memory';
  readonly boot?: (options: BootOptions) => Promise<BootResult>;
};

/** A repository that already holds `DEMO` (a seed) and `OTHER` (the user's), with DEMO last opened. */
function populated(): MemoryRepository {
  return createMemoryRepository({
    initial: {
      stacks: [
        { stack: DEMO, savedAt: SAVED_AT, origin: 'seed' },
        { stack: OTHER, savedAt: SAVED_AT, origin: 'user' },
      ],
      meta: { seeded: true, [LAST_OPENED_KEY]: 'demo' },
    },
  });
}

function renderRoot(options: Setup = {}) {
  const repository = options.repository ?? createMemoryRepository();
  const seedSet = options.seedSet ?? seedSetOf(DEMO);
  const mode = options.mode ?? 'indexeddb';
  const boot =
    options.boot ??
    ((bootOptions: BootOptions) =>
      bootPersistence({
        ...bootOptions,
        openRepository: () =>
          Promise.resolve(
            mode === 'memory'
              ? {
                  repository,
                  mode,
                  reason: 'This browser does not allow stacks to be stored here.',
                }
              : { repository, mode },
          ),
      }));
  let clock = SAVED_AT;
  const now = () => (clock += 1000);
  const view = render(
    <AppRoot
      boot={boot}
      now={now}
      seedSet={seedSet}
      fetch={() => Promise.reject(new Error('offline'))}
      scenarios={[]}
      settingsRepository={createSettingsRepository(null)}
    />,
  );
  return { repository, view };
}

/** Moves the fake clock and lets the writes that start finish. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/** Lets pending promises settle, without moving the clock, until `check` stops throwing. */
async function until(check: () => void | Promise<void>): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    try {
      await check();
      return;
    } catch {
      await advance(0);
    }
  }
  await check();
}

async function renderReady(options: Setup = {}) {
  const rendered = renderRoot(options);
  await until(() => {
    screen.getByRole('heading', { level: 2, name: /stack$/ });
  });
  return rendered;
}

function typeInField(text: string): void {
  fireEvent.change(screen.getByRole('textbox', { name: 'New item' }), { target: { value: text } });
}

function indicator(): string {
  return document.querySelector('.save-indicator')?.textContent ?? '';
}

function windowTitle(): string {
  return screen.getByRole('heading', { level: 2, name: /stack$/ }).textContent ?? '';
}

function fieldValueOf(stack: Stack): string | undefined {
  const field = stack.cards[0]?.objects.find((object) => object.id === 'todo-input');
  return field?.type === 'field' ? field.value : undefined;
}

function valueOf<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`Expected ok, got ${JSON.stringify(result.errors)}`);
  return result.value;
}

async function storedStack(repository: MemoryRepository, id: string): Promise<Stack> {
  return valueOf(await repository.load(id));
}

async function storedIds(repository: MemoryRepository): Promise<string[]> {
  const listed = valueOf(await repository.list(0));
  return listed.stacks.map((summary: StackSummary) => summary.id);
}

/** The items of the to-do list in the stack window (the Stacks window has list items too). */
function todoItems(): string[] {
  return within(screen.getByRole('list', { name: 'To-do items' }))
    .queryAllByRole('listitem')
    .map((item) => item.textContent ?? '');
}

function stacksDialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Stacks' });
}

function isChecked(name: string): boolean {
  return screen.getByRole<HTMLInputElement>('radio', { name }).checked;
}

function setVisibility(state: 'hidden' | 'visible'): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
}

function openStacksWindow() {
  fireEvent.click(screen.getByRole('button', { name: 'Stacks' }));
}

async function stacksList() {
  await until(() => {
    const list = screen.getByRole('list', { name: 'Stacks' });
    expect(within(list).queryByText('Loading stacks.')).toBeNull();
  });
  return screen.getByRole('list', { name: 'Stacks' });
}

function confirmInTopDialog(name: string) {
  const dialogs = screen.getAllByRole('dialog');
  const top = dialogs[dialogs.length - 1];
  if (top === undefined) throw new Error('no dialog');
  fireEvent.click(within(top).getByRole('button', { name }));
}

describe('AppRoot: start-up', () => {
  it('shows "Opening your stacks..." while booting, then the stack, and removes the text', async () => {
    let finish: (booted: BootResult) => void = () => undefined;
    const pending = new Promise<BootResult>((resolve) => {
      finish = resolve;
    });
    renderRoot({ boot: () => pending });
    expect(screen.getByRole('status').textContent).toBe('Opening your stacks...');
    expect(screen.queryByRole('heading', { level: 2, name: /stack$/ })).toBeNull();

    const booted = await bootPersistence({
      now: SAVED_AT,
      seedSet: seedSetOf(DEMO),
      openRepository: () =>
        Promise.resolve({ repository: createMemoryRepository(), mode: 'indexeddb' }),
    });
    await act(async () => {
      finish(booted);
      await pending;
    });

    expect(screen.getByRole('heading', { level: 2, name: 'Demo stack' })).toBeTruthy();
    expect(screen.queryByText('Opening your stacks...')).toBeNull();
  });

  it('says so when the boot rejects', async () => {
    renderRoot({ boot: () => Promise.reject(new Error('boom')) });
    await until(() => {
      screen.getByRole('alert');
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('could not be opened');
    expect(screen.queryByText('Opening your stacks...')).toBeNull();
  });

  it('boots once and passes the injected clock and seed set', async () => {
    const boot = vi.fn((options: BootOptions) =>
      bootPersistence({
        ...options,
        openRepository: () =>
          Promise.resolve({ repository: createMemoryRepository(), mode: 'indexeddb' }),
      }),
    );
    const seedSet = seedSetOf(DEMO);
    render(<AppRoot boot={boot} now={() => 4242} seedSet={seedSet} />);
    await until(() => {
      screen.getByRole('heading', { level: 2, name: /stack$/ });
    });
    expect(boot).toHaveBeenCalledTimes(1);
    expect(boot.mock.calls[0]?.[0]).toMatchObject({ now: 4242, seedSet });
  });

  it('first run shows the seeded stack and the Saved state', async () => {
    const { repository } = await renderReady();
    expect(windowTitle()).toBe('Demo stack');
    expect(indicator()).toBe('Saved');
    expect(await storedIds(repository)).toEqual(['demo']);
  });

  it('shows the Memory_Mode banner in memory mode and not otherwise', async () => {
    await renderReady({ mode: 'memory' });
    expect(
      screen.getByText('Changes are lost when you close this page. Export before leaving.'),
    ).toBeTruthy();
    cleanup();
    await renderReady({ mode: 'indexeddb' });
    expect(screen.queryByText(/Changes are lost when you close this page/)).toBeNull();
  });
});

describe('AppRoot: autosave', () => {
  it('writes once, 1000 ms after the last of several edits, and the indicator goes Saving then Saved', async () => {
    const { repository } = await renderReady();
    const save = vi.spyOn(repository, 'save');

    typeInField('M');
    expect(indicator()).toBe('Saving');
    await advance(500);
    typeInField('Mi');
    await advance(500);
    typeInField('Milk');
    await advance(999);
    expect(save).not.toHaveBeenCalled();
    expect(indicator()).toBe('Saving');

    await advance(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(indicator()).toBe('Saved');
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('Milk');

    await advance(5000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('stamps the write with the injected clock', async () => {
    const { repository } = await renderReady();
    const save = vi.spyOn(repository, 'save');
    typeInField('x');
    await advance(1000);
    expect(save.mock.calls[0]?.[1]).toBeGreaterThan(SAVED_AT);
  });

  it('shows "Not saved: ..." after a failed save, stays usable, and the next edit saves', async () => {
    const { repository } = await renderReady();
    const save = vi.spyOn(repository, 'save');
    save.mockResolvedValueOnce({
      ok: false,
      errors: [
        { code: 'STORAGE_FAILED', message: 'Your stacks could not be stored in this browser.' },
      ],
    });

    typeInField('first');
    await advance(1000);
    expect(indicator()).toBe('Not saved: Your stacks could not be stored in this browser.');
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('');

    // Still usable: the field takes input, and the next change retries and succeeds.
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'New item' });
    typeInField('second');
    expect(input.value).toBe('second');
    await advance(1000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(indicator()).toBe('Saved');
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('second');
  });

  it('offers Export when the storage is full', async () => {
    const { repository } = await renderReady();
    vi.spyOn(repository, 'save').mockResolvedValueOnce({
      ok: false,
      errors: [{ code: 'QUOTA_EXCEEDED', message: 'full' }],
    });
    typeInField('big');
    await advance(1000);
    expect(indicator()).toBe("Not saved: The browser's storage is full.");
    fireEvent.click(screen.getByRole('button', { name: 'Export this stack' }));
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('does not write for mode changes, selection or card changes', async () => {
    const { repository } = await renderReady();
    const save = vi.spyOn(repository, 'save');

    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add item (button)' }));
    expect(
      screen.getByRole('button', { name: 'Add item (button)' }).getAttribute('aria-pressed'),
    ).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Interact' }));
    fireEvent.click(screen.getByRole('button', { name: 'About this stack' }));
    expect(screen.getByText(/^Card 2 of \d+$/)).toBeTruthy();
    await advance(5000);

    expect(save).not.toHaveBeenCalled();
    expect(indicator()).toBe('Saved');
  });

  it('flushes at once when the page becomes hidden, and not when it becomes visible', async () => {
    const { repository } = await renderReady();
    const save = vi.spyOn(repository, 'save');

    typeInField('hidden soon');
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(0);
    expect(save).not.toHaveBeenCalled();

    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(0);
    expect(save).toHaveBeenCalledTimes(1);
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('hidden soon');
    expect(indicator()).toBe('Saved');

    await advance(2000);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('flushes at once on pagehide', async () => {
    const { repository } = await renderReady();
    const save = vi.spyOn(repository, 'save');
    typeInField('leaving');
    window.dispatchEvent(new Event('pagehide'));
    await advance(0);
    expect(save).toHaveBeenCalledTimes(1);
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('leaving');
  });

  it('removes its listeners and writes nothing after unmount', async () => {
    const { repository, view } = await renderReady();
    const save = vi.spyOn(repository, 'save');
    typeInField('gone');
    view.unmount();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    await advance(3000);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('AppRoot: Stacks window', () => {
  it('opens another stack, switches the displayed stack and stores lastOpenedId', async () => {
    const { repository } = await renderReady({ repository: populated() });
    expect(windowTitle()).toBe('Demo stack');

    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Open Other stack' }));

    await until(() => expect(windowTitle()).toBe('Other stack'));
    expect(screen.queryByRole('dialog')).toBeNull();
    await until(async () =>
      expect(valueOf(await repository.getMeta(LAST_OPENED_KEY))).toBe('other'),
    );
    expect(indicator()).toBe('Saved');
  });

  it('saves edits of the newly opened stack to that stack, not the old one', async () => {
    const { repository } = await renderReady({ repository: populated() });
    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Open Other stack' }));
    await until(() => expect(windowTitle()).toBe('Other stack'));

    typeInField('for other');
    await advance(1000);
    expect(fieldValueOf(await storedStack(repository, 'other'))).toBe('for other');
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('');
  });

  it('flushes an edit before Open, so a switch never loses it', async () => {
    const { repository } = await renderReady({ repository: populated() });
    typeInField('kept');
    openStacksWindow();
    await stacksList();
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('kept');
  });

  it('Restore demo stacks replaces the open stack with the original content', async () => {
    const { repository } = await renderReady({ repository: populated() });
    typeInField('my edit');
    await advance(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(todoItems()).toEqual(['my edit']);

    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Restore demo stacks' }));
    confirmInTopDialog('Restore demo stacks');

    await until(() => expect(todoItems()).toEqual([]));
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('');
    const trash = valueOf(await repository.listTrash());
    expect(trash.map((item) => item.id)).toEqual(['demo']);
    // The new stack instance saves cleanly and does not write the old content back.
    await advance(5000);
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('');
    expect(indicator()).toBe('Saved');
  });

  it('flushes a pending edit before Restore demo stacks, so the trash holds the latest edit', async () => {
    const { repository } = await renderReady({ repository: populated() });
    typeInField('latest');
    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Restore demo stacks' }));
    confirmInTopDialog('Restore demo stacks');
    await until(async () => expect(valueOf(await repository.listTrash())).toHaveLength(1));

    const [trashed] = valueOf(await repository.listTrash());
    if (trashed === undefined) throw new Error('nothing in the trash');
    // The demo id is in use again, so restore the trashed copy under a new id to read it.
    const copy = valueOf(await repository.restoreFromTrash(trashed.key, SAVED_AT, 'demo-copy'));
    expect(fieldValueOf(await storedStack(repository, copy.id))).toBe('latest');
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('');
  });

  it('does not bring a deleted open stack back: the later debounced save is not written', async () => {
    const { repository } = await renderReady({ repository: populated() });
    typeInField('last words');

    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Demo stack' }));
    await until(() => expect(windowTitle()).toBe('Other stack'));
    await advance(5000);

    expect(await storedIds(repository)).toEqual(['other']);
    const trash = valueOf(await repository.listTrash());
    expect(trash.map((item) => item.id)).toEqual(['demo']);
    const trashed = trash[0];
    if (trashed === undefined) throw new Error('nothing in the trash');
    // Restore it under a free id to read what the trash holds: it has the latest edit.
    const restored = valueOf(await repository.restoreFromTrash(trashed.key, SAVED_AT));
    expect(fieldValueOf(await storedStack(repository, restored.id))).toBe('last words');
  });

  it('keeps the app working when the open stack is deleted and none is left', async () => {
    const { repository } = await renderReady();
    typeInField('bye');
    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Demo stack' }));
    await until(() => expect(windowTitle()).toBe('My stack'));
    await advance(3000);
    expect(await storedIds(repository)).toEqual(['my-stack']);
  });
});

describe('AppRoot: the Stacks window stays open when the open stack is replaced', () => {
  it('after deleting the open stack: the window stays open with its notice and the new stack shows', async () => {
    const { repository } = await renderReady({ repository: populated() });
    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Demo stack' }));

    await until(() => expect(windowTitle()).toBe('Other stack'));
    await until(() => {
      within(stacksDialog()).getByText('Moved "Demo stack" to the trash.');
    });
    const dialog = stacksDialog();
    // The list was read again: the deleted stack is gone and the new open stack is marked.
    const list = within(dialog).getByRole('list', { name: 'Stacks' });
    expect(within(list).queryByText('Demo stack')).toBeNull();
    expect(within(list).getByText('Open')).toBeTruthy();
    expect(within(list).queryByRole('button', { name: 'Open Other stack' })).toBeNull();
    expect(
      within(within(dialog).getByRole('list', { name: 'Trash' })).getByText('Demo stack'),
    ).toBeTruthy();
    expect(indicator()).toBe('Saved');
    expect(await storedIds(repository)).toEqual(['other']);

    // It closes only when the user closes it.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(windowTitle()).toBe('Other stack');
  });

  it('after deleting the only stack: the window stays open and the fresh stack shows', async () => {
    await renderReady();
    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Demo stack' }));

    await until(() => expect(windowTitle()).toBe('My stack'));
    await until(() => {
      within(stacksDialog()).getByText('Moved "Demo stack" to the trash.');
    });
    expect(
      within(within(stacksDialog()).getByRole('list', { name: 'Stacks' })).getByText('My stack'),
    ).toBeTruthy();
  });

  it('after Restore demo stacks replaces the open stack: the window stays open with its notice and the original shows', async () => {
    const { repository } = await renderReady({ repository: populated() });
    typeInField('my edit');
    await advance(1000);
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(todoItems()).toEqual(['my edit']);
    await advance(1000);

    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Restore demo stacks' }));
    confirmInTopDialog('Restore demo stacks');

    await until(() => {
      within(stacksDialog()).getByText(
        'Restored 1 demo stack. The versions you had are in the trash.',
      );
    });
    expect(screen.queryByRole('dialog', { name: 'Restore demo stacks' })).toBeNull();
    expect(todoItems()).toEqual([]);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'New item' }).value).toBe('');
    expect(windowTitle()).toBe('Demo stack');
    expect(
      within(within(stacksDialog()).getByRole('list', { name: 'Trash' })).getByText('Demo stack'),
    ).toBeTruthy();

    // An edit made afterwards is saved over the restored stack, and the old content is not.
    typeInField('after restore');
    await advance(1000);
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('after restore');
    expect(todoItems()).toEqual([]);
    fireEvent.click(within(stacksDialog()).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('after Open: the displayed stack changes, the window closes, and the load itself is not saved', async () => {
    const { repository } = await renderReady({ repository: populated() });
    const save = vi.spyOn(repository, 'save');
    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Open Other stack' }));
    await until(() => expect(windowTitle()).toBe('Other stack'));
    expect(screen.queryByRole('dialog')).toBeNull();

    await advance(5000);
    expect(save).not.toHaveBeenCalled();
    expect(indicator()).toBe('Saved');
  });

  it('after an open, edits go to the new stack and a second open goes back to the first', async () => {
    const { repository } = await renderReady({ repository: populated() });
    for (const [open, shown, typed] of [
      ['Other stack', 'Other stack', 'one'],
      ['Demo stack', 'Demo stack', 'two'],
    ] as const) {
      openStacksWindow();
      await stacksList();
      fireEvent.click(screen.getByRole('button', { name: `Open ${open}` }));
      await until(() => expect(windowTitle()).toBe(shown));
      typeInField(typed);
      await advance(1000);
    }
    expect(fieldValueOf(await storedStack(repository, 'other'))).toBe('one');
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('two');
    expect(indicator()).toBe('Saved');
  });

  it('resets the card, the mode and the selection when another stack is opened', async () => {
    await renderReady({ repository: populated() });
    fireEvent.click(screen.getByRole('button', { name: 'About this stack' }));
    expect(screen.getByText(/^Card 2 of \d+$/)).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    const object = screen.getByRole('button', { name: /\(button\)$/ });
    fireEvent.click(object);
    expect(object.getAttribute('aria-pressed')).toBe('true');
    expect(isChecked('Edit')).toBe(true);

    openStacksWindow();
    await stacksList();
    fireEvent.click(screen.getByRole('button', { name: 'Open Other stack' }));
    await until(() => expect(windowTitle()).toBe('Other stack'));

    expect(screen.getByText(/^Card 1 of \d+$/)).toBeTruthy();
    expect(isChecked('Interact')).toBe(true);
    expect(isChecked('Edit')).toBe(false);
    expect(document.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it('never writes the old stack after it was replaced: the pending debounced save is dropped', async () => {
    const { repository } = await renderReady({ repository: populated() });
    openStacksWindow();
    await stacksList();
    const save = vi.spyOn(repository, 'save');
    fireEvent.click(screen.getByRole('button', { name: 'Open Other stack' }));
    // The click flushed what was pending. This edit is made after that, while the other stack
    // loads, so only the old autosave's debounce timer holds it.
    typeInField('too late');
    await until(() => expect(windowTitle()).toBe('Other stack'));
    await advance(5000);

    expect(save).not.toHaveBeenCalled();
    expect(fieldValueOf(await storedStack(repository, 'demo'))).toBe('');
    expect(fieldValueOf(await storedStack(repository, 'other'))).toBe('');
    expect(indicator()).toBe('Saved');
  });
});

describe('AppRoot: export', () => {
  it('exports the current stack from the store, with unsaved edits', async () => {
    await renderReady({ mode: 'memory' });
    typeInField('not yet saved');
    fireEvent.click(screen.getByRole('button', { name: 'Export this stack' }));

    expect(download).toHaveBeenCalledTimes(1);
    const [filename, text] = download.mock.calls[0] as [string, string];
    expect(filename).toBe('demo-stack-demo.hypergeist.json');
    const parsed = parseStack(text);
    if (!parsed.ok) throw new Error('export is not a valid stack');
    expect(parsed.value.id).toBe('demo');
    expect(fieldValueOf(parsed.value)).toBe('not yet saved');
  });

  it('shows a message and downloads nothing when the download itself fails', async () => {
    await renderReady({ mode: 'memory' });
    download.mockImplementationOnce(() => {
      throw new Error('blocked');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Export this stack' }));
    expect(screen.getByText('The file could not be downloaded.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('The file could not be downloaded.')).toBeNull();
  });
});

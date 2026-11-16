import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStack } from '@hypergeist/shared/engine';
import type { Stack } from '@hypergeist/shared/format';
import { createMemoryRepository } from '../persistence/memory-repository.ts';
import type { MemoryRepository } from '../persistence/memory-repository.ts';
import { MAX_IMPORT_BYTES } from '../persistence/import-stack.ts';
import type { SeedStack } from '../persistence/types.ts';
import { PersistenceProvider } from '../state/PersistenceContext.tsx';
import { StacksWindow } from './StacksWindow.tsx';

const download = vi.hoisted(() => vi.fn());
vi.mock('../lib/download-text.ts', () => ({ downloadText: download }));

beforeEach(() => {
  download.mockClear();
});

afterEach(cleanup);

const SAVED_AT = Date.UTC(2026, 10, 15, 14, 30);

function makeStack(id: string, name: string): Stack {
  const made = createStack({ id, name });
  if (!made.ok) throw new Error('test stack must be valid');
  return made.stack;
}

const DEMO = makeStack('demo', 'Demo stack');
const MINE = makeStack('mine', 'My notes');
const SEEDS: readonly SeedStack[] = [{ stack: DEMO }];

type Options = {
  readonly openStackId?: string;
  readonly userStacks?: readonly Stack[];
  readonly demoPresent?: boolean;
  readonly failOnPut?: (id: string) => boolean;
  readonly beforeAction?: () => Promise<void>;
};

function setup(options: Options = {}) {
  const { openStackId = 'demo', userStacks = [MINE], demoPresent = true } = options;
  const repository: MemoryRepository = createMemoryRepository({
    initial: {
      stacks: [
        ...(demoPresent ? [{ stack: DEMO, savedAt: SAVED_AT, origin: 'seed' as const }] : []),
        ...userStacks.map((stack) => ({ stack, savedAt: SAVED_AT, origin: 'user' as const })),
      ],
    },
    failOnPut: options.failOnPut,
  });
  let clock = 10_000;
  const now = () => (clock += 1000);
  const onOpenStack = vi.fn();
  const onStacksChanged = vi.fn();
  const onClose = vi.fn();
  render(
    <PersistenceProvider
      repository={repository}
      seeds={SEEDS}
      openStackId={openStackId}
      now={now}
      onOpenStack={onOpenStack}
      onStacksChanged={onStacksChanged}
      beforeAction={options.beforeAction}
    >
      <StacksWindow onClose={onClose} />
    </PersistenceProvider>,
  );
  return { repository, onOpenStack, onStacksChanged, onClose };
}

async function stacksList() {
  const list = await screen.findByRole('list', { name: 'Stacks' });
  await waitFor(() => expect(within(list).queryByText('Loading stacks.')).toBeNull());
  return list;
}

function trashList() {
  return screen.getByRole('list', { name: 'Trash' });
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

/** The confirm or copy dialog on top of the Stacks window. */
function topDialog() {
  const dialogs = screen.getAllByRole('dialog');
  const top = dialogs[dialogs.length - 1];
  if (top === undefined) throw new Error('no dialog');
  return top;
}

function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error('no file input');
  return input;
}

function chooseFile(file: { size: number; text: () => Promise<string> }) {
  fireEvent.change(fileInput(), { target: { files: [file] } });
}

function fileOf(text: string) {
  return { size: text.length, text: () => Promise.resolve(text) };
}

function stackText(stack: Stack, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...stack, ...extra });
}

describe('StacksWindow: structure', () => {
  it('is a modal dialog named by its title, with named Stacks and Trash lists', async () => {
    setup();
    await stacksList();
    const dialog = screen.getByRole('dialog', { name: 'Stacks' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-labelledby')).not.toBeNull();
    expect(screen.getByRole('list', { name: 'Stacks' })).toBeTruthy();
    expect(trashList()).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Trash' })).toBeTruthy();
  });

  it('has no role="status" inside it', async () => {
    setup();
    await stacksList();
    expect(screen.queryByRole('status')).toBeNull();
    expect(document.querySelector('[role="status"]')).toBeNull();
  });

  it('puts initial focus on the window and the file input is hidden', async () => {
    setup();
    await stacksList();
    expect(document.activeElement).toBe(screen.getByRole('dialog', { name: 'Stacks' }));
    expect(fileInput().hidden).toBe(true);
  });

  it('renders nothing without a provider', () => {
    const { container } = render(<StacksWindow onClose={() => undefined} />);
    expect(container.innerHTML).toBe('');
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('StacksWindow: the list', () => {
  it('shows name, origin label, saved time and marks the open stack', async () => {
    setup();
    const list = await stacksList();
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);

    const demo = rows.find((row) => within(row).queryByText('Demo stack') !== null);
    const mine = rows.find((row) => within(row).queryByText('My notes') !== null);
    if (demo === undefined || mine === undefined) throw new Error('rows missing');

    expect(within(demo).getByText('Demo')).toBeTruthy();
    expect(within(demo).getByText('Saved 2026-11-15 14:30 UTC')).toBeTruthy();
    // The open stack carries the "Open" mark instead of an Open button.
    expect(within(demo).getByText('Open')).toBeTruthy();
    expect(within(demo).queryByRole('button', { name: 'Open Demo stack' })).toBeNull();
    expect(within(demo).getByRole('button', { name: 'Export Demo stack' })).toBeTruthy();
    expect(within(demo).getByRole('button', { name: 'Delete Demo stack' })).toBeTruthy();

    expect(within(mine).getByText('Yours')).toBeTruthy();
    expect(within(mine).getByRole('button', { name: 'Open My notes' })).toBeTruthy();
    expect(within(mine).getByRole('button', { name: 'Export My notes' })).toBeTruthy();
    expect(within(mine).getByRole('button', { name: 'Delete My notes' })).toBeTruthy();
  });

  it('says so when the trash is empty', async () => {
    setup();
    await stacksList();
    expect(within(trashList()).getByText('The trash is empty.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Empty trash' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('shows the quarantine line for records that could not be read', async () => {
    const { repository } = setup();
    repository.testing.putRawStack(
      { stack: { nonsense: true }, savedAt: 1, origin: 'user' },
      'bad-1',
    );
    repository.testing.putRawStack({ stack: 7, savedAt: 1, origin: 'user' }, 'bad-2');
    // A new window reads the lists again.
    cleanup();
    render(
      <PersistenceProvider
        repository={repository}
        seeds={SEEDS}
        openStackId="demo"
        now={() => 99}
        onOpenStack={() => undefined}
      >
        <StacksWindow onClose={() => undefined} />
      </PersistenceProvider>,
    );
    expect(await screen.findByText('2 stacks could not be read and were set aside.')).toBeTruthy();
    const list = await stacksList();
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('uses the singular for one set-aside record', async () => {
    const repository = createMemoryRepository();
    repository.testing.putRawStack({ stack: 7, savedAt: 1, origin: 'user' }, 'bad-1');
    render(
      <PersistenceProvider
        repository={repository}
        seeds={SEEDS}
        openStackId="demo"
        now={() => 99}
        onOpenStack={() => undefined}
      >
        <StacksWindow onClose={() => undefined} />
      </PersistenceProvider>,
    );
    expect(await screen.findByText('1 stack could not be read and was set aside.')).toBeTruthy();
  });

  it('shows a persistence failure as its plain message', async () => {
    const repository = createMemoryRepository();
    const failing = {
      ...repository,
      list: () =>
        Promise.resolve({
          ok: false as const,
          errors: [{ code: 'STORAGE_FAILED' as const, message: 'Storage is not available.' }],
        }),
    };
    render(
      <PersistenceProvider
        repository={failing}
        seeds={SEEDS}
        openStackId="demo"
        now={() => 99}
        onOpenStack={() => undefined}
      >
        <StacksWindow onClose={() => undefined} />
      </PersistenceProvider>,
    );
    expect(await screen.findByText('Storage is not available.')).toBeTruthy();
  });
});

describe('StacksWindow: open, export, delete', () => {
  it('Open loads the stack, calls onOpenStack and closes the window', async () => {
    const { onOpenStack, onClose } = setup();
    await stacksList();
    click('Open My notes');
    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    expect(onOpenStack).toHaveBeenCalledWith(MINE);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Export builds a download with the file name and the canonical text', async () => {
    setup();
    await stacksList();
    click('Export My notes');
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [filename, text] = download.mock.calls[0] as [string, string];
    expect(filename).toBe('my-notes-mine.hypergeist.json');
    expect(JSON.parse(text)).toEqual(MINE);
    expect(await screen.findByText('Exported my-notes-mine.hypergeist.json.')).toBeTruthy();
  });

  it('Export shows the message when the stack cannot be exported', async () => {
    const { repository } = setup();
    // The stored record is valid for load, but the export check is the real one: force a failure.
    const original = repository.load.bind(repository);
    vi.spyOn(repository, 'load').mockImplementation(async (id) => {
      const loaded = await original(id);
      if (!loaded.ok) return loaded;
      return { ok: true, value: { ...loaded.value, formatVersion: 99 } as unknown as Stack };
    });
    await stacksList();
    click('Export My notes');
    expect(await screen.findByText(/This stack cannot be exported/)).toBeTruthy();
    expect(download).not.toHaveBeenCalled();
  });

  it('Delete moves a stack to the trash and shows it there', async () => {
    const { repository, onStacksChanged, onOpenStack } = setup();
    await stacksList();
    click('Delete My notes');
    await waitFor(() => expect(within(trashList()).getByText('My notes')).toBeTruthy());
    expect(within(screen.getByRole('list', { name: 'Stacks' })).queryByText('My notes')).toBeNull();
    expect(onStacksChanged).toHaveBeenCalled();
    expect(onOpenStack).not.toHaveBeenCalled();
    const trash = await repository.listTrash();
    expect(trash.ok && trash.value.map((item) => item.id)).toEqual(['mine']);
    expect(within(trashList()).getByText('Deleted 1970-01-01 00:00 UTC')).toBeTruthy();
  });

  it('deleting the open stack opens another stored stack', async () => {
    const { onOpenStack } = setup({ openStackId: 'demo' });
    await stacksList();
    click('Delete Demo stack');
    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    expect(onOpenStack).toHaveBeenCalledWith(MINE);
  });

  it('deleting the last stack creates a fresh one, stores it and opens it', async () => {
    const { repository, onOpenStack } = setup({
      openStackId: 'mine',
      userStacks: [MINE],
      demoPresent: false,
    });
    await stacksList();
    click('Delete My notes');
    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    const opened = onOpenStack.mock.calls[0]?.[0] as Stack;
    expect(opened.name).toBe('My stack');
    expect(opened.id).toBe('my-stack');
    const stored = await repository.load(opened.id);
    expect(stored.ok && stored.value).toEqual(opened);
    const listed = await repository.list(1);
    expect(listed.ok && listed.value.stacks.map((s) => s.id)).toEqual(['my-stack']);
  });

  it('picks a free id when my-stack is taken', async () => {
    const taken = makeStack('my-stack', 'Already here');
    const { onOpenStack, repository } = setup({
      openStackId: 'mine',
      userStacks: [MINE, taken],
      demoPresent: false,
    });
    await stacksList();
    // Another stack exists, so it opens that one and creates nothing.
    click('Delete My notes');
    await waitFor(() => expect(onOpenStack).toHaveBeenCalledWith(taken));
    const listed = await repository.list(1);
    expect(listed.ok && listed.value.stacks.map((s) => s.id)).toEqual(['my-stack']);
  });

  it('shows the plain message when the fresh stack cannot be stored', async () => {
    const { onOpenStack } = setup({
      openStackId: 'mine',
      demoPresent: false,
      failOnPut: (id) => id === 'my-stack',
    });
    await stacksList();
    click('Delete My notes');
    expect(
      await screen.findByText('Your stacks could not be stored in this browser.'),
    ).toBeTruthy();
    expect(onOpenStack).not.toHaveBeenCalled();
  });
});

describe('StacksWindow: trash', () => {
  async function withOneInTrash(options: Options = {}) {
    const result = setup(options);
    await stacksList();
    click('Delete My notes');
    await waitFor(() => expect(within(trashList()).getByText('My notes')).toBeTruthy());
    return result;
  }

  it('Restore moves a stack back to the list', async () => {
    const { repository } = await withOneInTrash();
    click('Restore My notes');
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Stacks' })).getByText('My notes'),
      ).toBeTruthy(),
    );
    expect(within(trashList()).getByText('The trash is empty.')).toBeTruthy();
    const trash = await repository.listTrash();
    expect(trash.ok && trash.value).toEqual([]);
  });

  it('Restore with the id in use goes through the copy dialog and stores a remix', async () => {
    const { repository } = await withOneInTrash();
    // Take the id while the old copy is in the trash.
    expect((await repository.create(makeStack('mine', 'Newer notes'), 5)).ok).toBe(true);

    click('Restore My notes');
    const dialog = await screen.findByRole('dialog', { name: 'Cannot restore under the same id' });
    expect(dialog.textContent).toContain('"mine-copy"');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore as a copy' }));

    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Stacks' })).getByText('My notes'),
      ).toBeTruthy(),
    );
    const copy = await repository.load('mine-copy');
    expect(copy.ok && copy.value.remixedFrom).toBe('mine');
    const original = await repository.load('mine');
    expect(original.ok && original.value.name).toBe('Newer notes');
    expect(within(trashList()).getByText('The trash is empty.')).toBeTruthy();
  });

  it('Cancel in the copy dialog changes nothing', async () => {
    const { repository } = await withOneInTrash();
    expect((await repository.create(makeStack('mine', 'Newer notes'), 5)).ok).toBe(true);
    click('Restore My notes');
    const dialog = await screen.findByRole('dialog', { name: 'Cannot restore under the same id' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    const trash = await repository.listTrash();
    expect(trash.ok && trash.value.map((item) => item.id)).toEqual(['mine']);
    const listed = await repository.list(1);
    expect(listed.ok && listed.value.stacks.map((s) => s.id).sort()).toEqual(['demo', 'mine']);
  });

  it('Delete permanently asks first, names the stack, and Cancel changes nothing', async () => {
    const { repository } = await withOneInTrash();
    click('Delete My notes permanently');
    const dialog = topDialog();
    expect(within(dialog).getByText(/"My notes" will be deleted for good/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    const trash = await repository.listTrash();
    expect(trash.ok && trash.value).toHaveLength(1);
    expect(within(trashList()).getByText('My notes')).toBeTruthy();
  });

  it('Delete permanently removes the record after the confirm', async () => {
    const { repository } = await withOneInTrash();
    click('Delete My notes permanently');
    fireEvent.click(within(topDialog()).getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(within(trashList()).getByText('The trash is empty.')).toBeTruthy());
    const trash = await repository.listTrash();
    expect(trash.ok && trash.value).toEqual([]);
  });

  it('Empty trash asks first, names what is lost, and Cancel changes nothing', async () => {
    const { repository } = await withOneInTrash();
    click('Empty trash');
    const dialog = topDialog();
    expect(dialog.textContent).toContain('1 stack will be deleted for good');
    expect(dialog.textContent).toContain('"My notes"');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    const trash = await repository.listTrash();
    expect(trash.ok && trash.value).toHaveLength(1);
  });

  it('Empty trash empties it after the confirm', async () => {
    const { repository } = await withOneInTrash();
    click('Empty trash');
    fireEvent.click(within(topDialog()).getByRole('button', { name: 'Empty trash' }));
    await waitFor(() => expect(within(trashList()).getByText('The trash is empty.')).toBeTruthy());
    const trash = await repository.listTrash();
    expect(trash.ok && trash.value).toEqual([]);
  });

  it('puts focus on the Cancel button of a confirm dialog', async () => {
    await withOneInTrash();
    click('Empty trash');
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(topDialog()).getByRole('button', { name: 'Cancel' }),
      ),
    );
  });
});

describe('StacksWindow: restore demo stacks', () => {
  it('asks first and says the bundled stacks are replaced; Cancel changes nothing', async () => {
    const { repository } = setup();
    // The user edits the demo stack.
    expect((await repository.save({ ...DEMO, name: 'Edited demo' }, 5)).ok).toBe(true);
    cleanup();
    setupAgain(repository);
    await stacksList();
    click('Restore demo stacks');
    const dialog = topDialog();
    expect(dialog.textContent).toContain('replaced by their original versions');
    expect(dialog.textContent).toContain('goes to the trash');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    const loaded = await repository.load('demo');
    expect(loaded.ok && loaded.value.name).toBe('Edited demo');
    const trash = await repository.listTrash();
    expect(trash.ok && trash.value).toEqual([]);
  });

  function setupAgain(repository: MemoryRepository) {
    const onOpenStack = vi.fn();
    const onStacksChanged = vi.fn();
    render(
      <PersistenceProvider
        repository={repository}
        seeds={SEEDS}
        openStackId="demo"
        now={() => 77_000}
        onOpenStack={onOpenStack}
        onStacksChanged={onStacksChanged}
      >
        <StacksWindow onClose={() => undefined} />
      </PersistenceProvider>,
    );
    return { onOpenStack, onStacksChanged };
  }

  it('replaces the demo stack, moves the edited copy to the trash and reloads the open stack', async () => {
    const { repository } = setup();
    expect((await repository.save({ ...DEMO, name: 'Edited demo' }, 5)).ok).toBe(true);
    cleanup();
    const { onOpenStack, onStacksChanged } = setupAgain(repository);
    await stacksList();
    click('Restore demo stacks');
    fireEvent.click(within(topDialog()).getByRole('button', { name: 'Restore demo stacks' }));

    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    expect(onOpenStack).toHaveBeenCalledWith(DEMO);
    expect(onStacksChanged).toHaveBeenCalled();
    const loaded = await repository.load('demo');
    expect(loaded.ok && loaded.value.name).toBe('Demo stack');
    await waitFor(() => expect(within(trashList()).getByText('Edited demo')).toBeTruthy());
    // The user's own stack is untouched.
    const mine = await repository.load('mine');
    expect(mine.ok && mine.value).toEqual(MINE);
    expect(await screen.findByText(/Restored 1 demo stack\./)).toBeTruthy();
  });
});

describe('StacksWindow: import', () => {
  it('stores a valid file, opens it and closes the window', async () => {
    const { repository, onOpenStack, onClose, onStacksChanged } = setup();
    await stacksList();
    const imported = makeStack('brand-new', 'Brand new');
    chooseFile(fileOf(stackText(imported)));
    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    expect(onOpenStack).toHaveBeenCalledWith(imported);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onStacksChanged).toHaveBeenCalled();
    const listed = await repository.list(1);
    const entry = listed.ok ? listed.value.stacks.find((s) => s.id === 'brand-new') : undefined;
    expect(entry?.origin).toBe('user');
  });

  it('shows the error and stores nothing for a file that is not JSON', async () => {
    const { repository, onOpenStack } = setup();
    await stacksList();
    chooseFile(fileOf('this is { not json'));
    const errors = await screen.findByRole('list', { name: 'Import problems' });
    expect(within(errors).getAllByRole('listitem').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('This file was not imported, and nothing was stored.')).toBeTruthy();
    expect(onOpenStack).not.toHaveBeenCalled();
    const listed = await repository.list(1);
    expect(listed.ok && listed.value.stacks).toHaveLength(2);
  });

  it('shows path, message and hint for a wrong property', async () => {
    const { repository, onOpenStack } = setup();
    await stacksList();
    chooseFile(fileOf(stackText(makeStack('wrong', 'Wrong'), { bogus: 1 })));
    const errors = await screen.findByRole('list', { name: 'Import problems' });
    const items = within(errors).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(items[0]?.querySelector('code')?.textContent).toBe('/bogus');
    expect(items[0]?.textContent ?? '').toMatch(/bogus/);
    expect(onOpenStack).not.toHaveBeenCalled();
    const listed = await repository.list(1);
    expect(listed.ok && listed.value.stacks.map((s) => s.id)).not.toContain('wrong');
  });

  it('shows at most 5 errors and says how many more', async () => {
    setup();
    await stacksList();
    const extra: Record<string, unknown> = {};
    for (let i = 1; i <= 8; i += 1) extra[`bogus${i}`] = i;
    chooseFile(fileOf(stackText(makeStack('many', 'Many'), extra)));
    const errors = await screen.findByRole('list', { name: 'Import problems' });
    expect(within(errors).getAllByRole('listitem')).toHaveLength(5);
    expect(screen.getByText('and 3 more')).toBeTruthy();
  });

  it('refuses a file over 5 MB without reading it', async () => {
    const { repository, onOpenStack } = setup();
    await stacksList();
    const text = vi.fn(() => Promise.resolve('{}'));
    chooseFile({ size: MAX_IMPORT_BYTES + 1, text });
    expect(await screen.findByText(/larger than 5 MB/)).toBeTruthy();
    expect(text).not.toHaveBeenCalled();
    expect(onOpenStack).not.toHaveBeenCalled();
    const listed = await repository.list(1);
    expect(listed.ok && listed.value.stacks).toHaveLength(2);
  });

  it('shows a message when the file cannot be read', async () => {
    setup();
    await stacksList();
    chooseFile({ size: 10, text: () => Promise.reject(new Error('boom')) });
    expect(await screen.findByText('The file could not be read.')).toBeTruthy();
  });

  it('on an id conflict offers a copy: stores a remix and never overwrites', async () => {
    const { repository, onOpenStack } = setup();
    await stacksList();
    const clash = { ...makeStack('mine', 'Imported notes') };
    chooseFile(fileOf(stackText(clash)));
    const dialog = await screen.findByRole('dialog', { name: 'This stack id is in use' });
    expect(dialog.textContent).toContain('"mine-copy"');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import as a copy' }));

    await waitFor(() => expect(onOpenStack).toHaveBeenCalledTimes(1));
    const opened = onOpenStack.mock.calls[0]?.[0] as Stack;
    expect(opened.id).toBe('mine-copy');
    expect(opened.remixedFrom).toBe('mine');
    const original = await repository.load('mine');
    expect(original.ok && original.value.name).toBe('My notes');
    const copy = await repository.load('mine-copy');
    expect(copy.ok && copy.value.name).toBe('Imported notes');
  });

  it('on an id conflict, Cancel changes nothing', async () => {
    const { repository, onOpenStack, onStacksChanged } = setup();
    await stacksList();
    chooseFile(fileOf(stackText(makeStack('mine', 'Imported notes'))));
    const dialog = await screen.findByRole('dialog', { name: 'This stack id is in use' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    expect(onOpenStack).not.toHaveBeenCalled();
    expect(onStacksChanged).not.toHaveBeenCalled();
    const listed = await repository.list(1);
    expect(listed.ok && listed.value.stacks.map((s) => s.id).sort()).toEqual(['demo', 'mine']);
    const original = await repository.load('mine');
    expect(original.ok && original.value.name).toBe('My notes');
  });

  it('the Import button opens the file picker', async () => {
    setup();
    await stacksList();
    const click = vi.spyOn(fileInput(), 'click').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Import a stack' }));
    expect(click).toHaveBeenCalledTimes(1);
  });

  it('shows the storage message when the stack cannot be stored', async () => {
    const { onOpenStack } = setup({ failOnPut: (id) => id === 'brand-new' });
    await stacksList();
    chooseFile(fileOf(stackText(makeStack('brand-new', 'Brand new'))));
    expect(
      await screen.findByText('Your stacks could not be stored in this browser.'),
    ).toBeTruthy();
    expect(onOpenStack).not.toHaveBeenCalled();
  });
});

describe('StacksWindow: keyboard', () => {
  it('Escape closes the window', async () => {
    const { onClose } = setup();
    await stacksList();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Stacks' }), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape in a confirm dialog closes only the confirm', async () => {
    const { onClose } = setup();
    await stacksList();
    click('Restore demo stacks');
    fireEvent.keyDown(topDialog(), { key: 'Escape' });
    await waitFor(() => expect(screen.getAllByRole('dialog')).toHaveLength(1));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('returns focus to the control that opened a confirm dialog', async () => {
    setup();
    await stacksList();
    const opener = screen.getByRole('button', { name: 'Restore demo stacks' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(topDialog(), { key: 'Escape' });
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('keeps Tab inside the window', async () => {
    setup();
    await stacksList();
    const dialog = screen.getByRole('dialog', { name: 'Stacks' });
    const close = within(dialog).getByRole('button', { name: 'Close' });
    close.focus();
    fireEvent.keyDown(close, { key: 'Tab' });
    const first = dialog.querySelector<HTMLElement>('button:not(:disabled)');
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first as HTMLElement, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);
  });

  it('keeps focus in the window when the control that had it is removed', async () => {
    setup();
    await stacksList();
    const button = screen.getByRole('button', { name: 'Delete My notes' });
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Delete My notes' })).toBeNull(),
    );
    await waitFor(() =>
      expect(screen.getByRole('dialog', { name: 'Stacks' }).contains(document.activeElement)).toBe(
        true,
      ),
    );
  });

  it('Close calls onClose', async () => {
    const { onClose } = setup();
    await stacksList();
    click('Close');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('every control is a real button or input', async () => {
    setup();
    await stacksList();
    const dialog = screen.getByRole('dialog', { name: 'Stacks' });
    expect(dialog.querySelectorAll('[role="button"], a, [onclick]')).toHaveLength(0);
  });
});

describe('StacksWindow: beforeAction', () => {
  it('is awaited before the first listing and before an action', async () => {
    let release: () => void = () => undefined;
    let gate = Promise.resolve();
    const closeGate = () => {
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    closeGate();
    const beforeAction = vi.fn(() => gate);
    const { repository } = setup({ beforeAction });

    // The listing waits for the hook.
    await Promise.resolve();
    expect(beforeAction).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Loading stacks.')).toBeTruthy();
    release();
    const list = await stacksList();
    expect(within(list).getByText('My notes')).toBeTruthy();

    // An action waits for the hook too: nothing is moved until it is released.
    closeGate();
    click('Delete My notes');
    await Promise.resolve();
    expect(beforeAction).toHaveBeenCalledTimes(2);
    const before = await repository.listTrash();
    expect(before.ok && before.value.length).toBe(0);
    release();
    await waitFor(async () => {
      const after = await repository.listTrash();
      expect(after.ok && after.value.map((item) => item.id)).toEqual(['mine']);
    });
  });

  it('does not block the action when the hook rejects', async () => {
    const beforeAction = vi.fn(() => Promise.reject(new Error('flush failed')));
    const { repository } = setup({ beforeAction });
    await stacksList();
    click('Delete My notes');
    await waitFor(async () => {
      const trash = await repository.listTrash();
      expect(trash.ok && trash.value.map((item) => item.id)).toEqual(['mine']);
    });
    expect(beforeAction).toHaveBeenCalledTimes(2);
  });
});

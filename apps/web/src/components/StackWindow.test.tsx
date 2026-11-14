import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as engine from '@hypergeist/shared/engine';
import type { Stack } from '@hypergeist/shared/format';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { StackStoreProvider, useStackStoreApi } from '../state/StackStoreContext.tsx';
import { StackWindow } from './StackWindow.tsx';

// Wrap the real executor in a spy so the tests can see when a Handler runs.
vi.mock('@hypergeist/shared/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hypergeist/shared/engine')>();
  return { ...actual, executeHandler: vi.fn(actual.executeHandler) };
});

const executeSpy = vi.mocked(engine.executeHandler);

beforeEach(() => {
  executeSpy.mockClear();
});

afterEach(cleanup);

function demoStack(): Stack {
  const loaded = loadStack(demoText);
  if (!loaded.ok) throw new Error('Demo_Stack must be valid');
  return loaded.stack;
}

/** The Demo_Stack with the to-do List replaced by the given List properties. */
function stackWithList(items: readonly string[], ordered: boolean): Stack {
  const stack = demoStack();
  return {
    ...stack,
    cards: stack.cards.map((card) => ({
      ...card,
      objects: card.objects.map((object) =>
        object.id === 'todo-list' && object.type === 'list'
          ? { ...object, items: [...items], ordered }
          : object,
      ),
    })),
  };
}

function renderWindow(stack: Stack = demoStack()) {
  let api: ReturnType<typeof useStackStoreApi> | undefined;
  function Capture() {
    api = useStackStoreApi();
    return null;
  }
  const view = render(
    <StackStoreProvider stack={stack}>
      <StackWindow />
      <Capture />
    </StackStoreProvider>,
  );
  if (api === undefined) throw new Error('store missing');
  return { ...view, store: api };
}

type Rendered = ReturnType<typeof renderWindow>;

function goEdit(rendered: Rendered) {
  act(() => rendered.store.getState().setMode('edit'));
}

/** The Edit mode wrapper of an Object, found by its accessible name. */
function editWrapper(name: string): HTMLElement {
  return screen.getByRole('button', { name });
}

function statusText(): string {
  return screen.getByRole('status').textContent ?? '';
}

function cardPosition(): string {
  return screen.getByText(/^Card \d+ of \d+$/).textContent ?? '';
}

const HANDLE_ORDER = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

describe('StackWindow in Interact mode', () => {
  it('names the controls of the to-do Card', () => {
    renderWindow();
    expect(screen.getByRole('textbox', { name: 'New item' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add item' })).toBeTruthy();
    expect(screen.getByRole('list', { name: 'To-do items' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'About this stack' })).toBeTruthy();
  });

  it('lets the user type in an editable Field', () => {
    const rendered = renderWindow();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'New item' });
    fireEvent.change(input, { target: { value: 'Buy milk' } });
    expect(input.value).toBe('Buy milk');
    const field = rendered.store.getState().stack.cards[0]?.objects[0];
    expect(field?.type === 'field' && field.value).toBe('Buy milk');
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it('runs the Add handler: appends the text, clears the Field, shows "Item added."', () => {
    renderWindow();
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'New item' });
    fireEvent.change(input, { target: { value: 'Buy milk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));

    const items = within(screen.getByRole('list', { name: 'To-do items' })).getAllByRole(
      'listitem',
    );
    expect(items.map((item) => item.textContent)).toEqual(['Buy milk']);
    expect(input.value).toBe('');
    expect(statusText()).toBe('Item added.');
  });

  it('runs a Button by keyboard activation', () => {
    renderWindow();
    fireEvent.change(screen.getByRole('textbox', { name: 'New item' }), {
      target: { value: 'Call Sam' },
    });
    // A native button turns Enter and Space into a click; the click is what the user agent sends.
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Call Sam']);
  });

  it('keeps items in the order they were added', () => {
    renderWindow();
    const input = screen.getByRole('textbox', { name: 'New item' });
    for (const text of ['one', 'two', 'three']) {
      fireEvent.change(input, { target: { value: text } });
      fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    }
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'one',
      'two',
      'three',
    ]);
  });

  it('rejects typing in a read-only Field and renders multiline Fields as textareas', () => {
    const rendered = renderWindow();
    fireEvent.click(screen.getByRole('button', { name: 'About this stack' }));
    const about = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'About' });
    expect(about.tagName).toBe('TEXTAREA');
    expect(about.readOnly).toBe(true);
    const before = about.value;
    const stackBefore = rendered.store.getState().stack;
    executeSpy.mockClear();
    fireEvent.change(about, { target: { value: 'changed' } });
    expect(about.value).toBe(before);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(rendered.store.getState().stack).toBe(stackBefore);
  });

  it('renders a single-line Field as an input', () => {
    renderWindow();
    expect(screen.getByRole('textbox', { name: 'New item' }).tagName).toBe('INPUT');
  });

  it('renders an unordered List and an empty List with no entries', () => {
    const { container } = renderWindow();
    expect(container.querySelector('ul')).not.toBeNull();
    expect(container.querySelector('ol')).toBeNull();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    const list = screen.getByRole('list', { name: 'To-do items' });
    expect(list.getAttribute('tabindex')).toBe('0');
  });

  it('renders an ordered List with its items in array order', () => {
    const { container } = renderWindow(stackWithList(['b', 'a', 'c'], true));
    const ordered = container.querySelector('ol');
    expect(ordered).not.toBeNull();
    expect(container.querySelector('ul')).toBeNull();
    expect(Array.from(ordered?.querySelectorAll('li') ?? []).map((li) => li.textContent)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('renders an unordered List with its items in array order', () => {
    const { container } = renderWindow(stackWithList(['x', 'y'], false));
    const unordered = container.querySelector('ul');
    expect(Array.from(unordered?.querySelectorAll('li') ?? []).map((li) => li.textContent)).toEqual(
      ['x', 'y'],
    );
  });

  it('follows Links forward and Back buttons return', () => {
    renderWindow();
    expect(cardPosition()).toBe('Card 1 of 3');

    fireEvent.click(screen.getByRole('button', { name: 'About this stack' }));
    expect(cardPosition()).toBe('Card 2 of 3');
    expect(screen.getByRole('textbox', { name: 'About' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Limits' }));
    expect(cardPosition()).toBe('Card 3 of 3');
    expect(screen.queryByRole('button', { name: 'Limits' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Back to about' }));
    expect(cardPosition()).toBe('Card 2 of 3');

    fireEvent.click(screen.getByRole('button', { name: 'Back to to-do' }));
    expect(cardPosition()).toBe('Card 1 of 3');
    expect(screen.getByRole('textbox', { name: 'New item' })).toBeTruthy();
  });

  it('shows no selection outline, handles, or Property_Readout', () => {
    const { container } = renderWindow();
    expect(container.querySelector('.selection-overlay')).toBeNull();
    expect(container.querySelector('.selection-handle')).toBeNull();
    expect(screen.queryByLabelText('Properties')).toBeNull();
  });

  it('shows the not-saved notice', () => {
    renderWindow();
    expect(screen.getByRole('note').textContent).toBe(
      'Changes are not saved. Reloading the page resets this stack.',
    );
  });
});

describe('StackWindow in Edit mode', () => {
  it('replaces the controls with selectable wrappers named with their type', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    expect(editWrapper('Add item (button)').getAttribute('aria-pressed')).toBe('false');
    expect(editWrapper('New item (field)')).toBeTruthy();
    expect(editWrapper('To-do items (list)')).toBeTruthy();
    // The inert previews are hidden from assistive technology.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('selects a Button on click and runs no Handler and adds no item', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    fireEvent.click(editWrapper('Add item (button)'));

    expect(rendered.store.getState().selectedObjectId).toBe('todo-add');
    expect(editWrapper('Add item (button)').getAttribute('aria-pressed')).toBe('true');
    expect(executeSpy).not.toHaveBeenCalled();
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(statusText()).not.toBe('Item added.');
  });

  it('selects on Enter and on Space, without running a Handler', () => {
    const rendered = renderWindow();
    goEdit(rendered);

    fireEvent.keyDown(editWrapper('New item (field)'), { key: 'Enter' });
    expect(rendered.store.getState().selectedObjectId).toBe('todo-input');

    fireEvent.keyDown(editWrapper('Add item (button)'), { key: ' ' });
    expect(rendered.store.getState().selectedObjectId).toBe('todo-add');

    fireEvent.keyDown(editWrapper('To-do items (list)'), { key: 'Enter' });
    expect(rendered.store.getState().selectedObjectId).toBe('todo-list');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('ignores other keys', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    fireEvent.keyDown(editWrapper('Add item (button)'), { key: 'a' });
    expect(rendered.store.getState().selectedObjectId).toBeNull();
  });

  it('ignores typing in a Field preview', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    const preview = rendered.container.querySelector<HTMLInputElement>('.object-preview input');
    expect(preview).not.toBeNull();
    expect(preview?.readOnly).toBe(true);
    if (preview !== null) fireEvent.change(preview, { target: { value: 'typed' } });
    expect(preview?.value).toBe('');
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it('draws 8 non-interactive handles in order around the selected Object only', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    expect(rendered.container.querySelector('.selection-overlay')).toBeNull();

    fireEvent.click(editWrapper('Add item (button)'));
    const overlays = rendered.container.querySelectorAll('.selection-overlay');
    expect(overlays).toHaveLength(1);
    const handles = Array.from(overlays[0]?.querySelectorAll('.selection-handle') ?? []);
    expect(handles.map((handle) => handle.getAttribute('data-handle'))).toEqual(HANDLE_ORDER);
    expect(overlays[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(overlays[0]?.querySelector('button, input, a, [tabindex], [role]')).toBeNull();
    for (const handle of handles) {
      expect(handle.getAttribute('draggable')).toBeNull();
      expect(handle.getAttribute('tabindex')).toBeNull();
    }
  });

  it('moves the handles when another Object is selected', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    fireEvent.click(editWrapper('Add item (button)'));
    fireEvent.click(editWrapper('To-do items (list)'));
    const overlay = rendered.container.querySelector<HTMLElement>('.selection-overlay');
    expect(rendered.container.querySelectorAll('.selection-overlay')).toHaveLength(1);
    expect(overlay?.style.getPropertyValue('--w')).toBe('480');
    expect(overlay?.style.getPropertyValue('--h')).toBe('240');
  });

  it('shows a prompt, then the Property_Readout rows of the selection', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    const region = screen.getByLabelText('Properties');
    expect(region.textContent).toBe('Select an object to see its properties.');

    fireEvent.click(editWrapper('Add item (button)'));
    const labels = Array.from(region.querySelectorAll('dt')).map((dt) => dt.textContent);
    expect(labels).toEqual(['id', 'type', 'name', 'x', 'y', 'width', 'height', 'label', 'onClick']);
    const values = Array.from(region.querySelectorAll('dd')).map((dd) => dd.textContent);
    expect(values.slice(0, 8)).toEqual([
      'todo-add',
      'button',
      'Add item',
      '408',
      '16',
      '88',
      '28',
      'Add',
    ]);
    expect(region.querySelector('input, textarea, button, select')).toBeNull();
  });

  it('shows the type-specific rows of a Field and a List', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    fireEvent.click(editWrapper('New item (field)'));
    const region = screen.getByLabelText('Properties');
    expect(Array.from(region.querySelectorAll('dt')).map((dt) => dt.textContent)).toEqual([
      'id',
      'type',
      'name',
      'x',
      'y',
      'width',
      'height',
      'value',
      'placeholder',
      'multiline',
      'readOnly',
    ]);
    expect(region.querySelectorAll('dd')[7]?.textContent).toBe('""');

    fireEvent.click(editWrapper('To-do items (list)'));
    expect(
      Array.from(region.querySelectorAll('dt'))
        .slice(7)
        .map((dt) => dt.textContent),
    ).toEqual(['items', 'ordered']);
  });

  it('clears the selection on Escape', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    fireEvent.click(editWrapper('Add item (button)'));
    fireEvent.keyDown(editWrapper('Add item (button)'), { key: 'Escape' });
    expect(rendered.store.getState().selectedObjectId).toBeNull();
    expect(rendered.container.querySelector('.selection-overlay')).toBeNull();
    expect(screen.getByLabelText('Properties').textContent).toBe(
      'Select an object to see its properties.',
    );
  });

  it('clears the selection on a click on the Canvas background', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    fireEvent.click(editWrapper('Add item (button)'));
    const canvas = rendered.container.querySelector('.canvas');
    expect(canvas).not.toBeNull();
    if (canvas !== null) fireEvent.click(canvas);
    expect(rendered.store.getState().selectedObjectId).toBeNull();
  });

  it('keeps the selection when the click lands on an Object', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    fireEvent.click(editWrapper('Add item (button)'));
    fireEvent.click(editWrapper('Add item (button)'));
    expect(rendered.store.getState().selectedObjectId).toBe('todo-add');
  });

  it('marks Links aria-disabled and does not navigate', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    const link = screen.getByRole('button', { name: 'About this stack' });
    expect(link.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(link);
    expect(cardPosition()).toBe('Card 1 of 3');
    expect(rendered.store.getState().currentCardId).toBe('todo');
  });

  it('removes aria-disabled from Links in Interact mode', () => {
    const rendered = renderWindow();
    goEdit(rendered);
    act(() => rendered.store.getState().setMode('interact'));
    const link = screen.getByRole('button', { name: 'About this stack' });
    expect(link.getAttribute('aria-disabled')).toBeNull();
  });

  it('shows the Mode in the status bar', () => {
    const rendered = renderWindow();
    expect(screen.getByText('Mode: Interact')).toBeTruthy();
    goEdit(rendered);
    expect(screen.getByText('Mode: Edit')).toBeTruthy();
  });
});

describe('StackWindow markup rules', () => {
  const ALLOWED_STYLE_PROPERTIES = new Set([
    '--x',
    '--y',
    '--w',
    '--h',
    '--card-w',
    '--card-h',
    '--scale',
  ]);

  /** Every inline style declaration name in the tree. */
  function inlineStyleProperties(root: Element): string[] {
    const names: string[] = [];
    for (const element of Array.from(root.querySelectorAll<HTMLElement>('[style]'))) {
      for (let index = 0; index < element.style.length; index += 1) {
        const name = element.style.item(index);
        names.push(name);
      }
    }
    return names;
  }

  it.each(['interact', 'edit'] as const)(
    'uses only geometry custom properties inline in %s mode',
    (mode) => {
      const rendered = renderWindow();
      if (mode === 'edit') {
        goEdit(rendered);
        fireEvent.click(editWrapper('Add item (button)'));
      }
      const names = inlineStyleProperties(rendered.container);
      expect(names.length).toBeGreaterThan(0);
      for (const name of names) expect(ALLOWED_STYLE_PROPERTIES.has(name)).toBe(true);
      for (const element of Array.from(rendered.container.querySelectorAll('[style]'))) {
        expect(element.getAttribute('style')).not.toMatch(/color|background|fill|#|rgb|hsl/i);
      }
    },
  );

  it.each(['interact', 'edit'] as const)('never mentions the ghost color in %s mode', (mode) => {
    const rendered = renderWindow();
    if (mode === 'edit') {
      goEdit(rendered);
      fireEvent.click(editWrapper('Add item (button)'));
    }
    expect(rendered.container.innerHTML).not.toContain('ghost');
  });

  it('names every control, and the window by its title bar', () => {
    const rendered = renderWindow();
    expect(screen.getByRole('region', { name: 'Thin slice to-do' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Card links' })).toBeTruthy();
    const controls = rendered.container.querySelectorAll('input, textarea, button, ol, ul');
    for (const control of Array.from(controls)) {
      const name =
        control.getAttribute('aria-label') ??
        (control.tagName === 'BUTTON' ? control.textContent : '');
      expect(name).not.toBe('');
      expect(name).not.toBeNull();
    }
  });

  it('puts the Objects before the Links in the Tab order', () => {
    const { container } = renderWindow();
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>('input, textarea, button, [tabindex="0"]'),
    );
    const names = focusable.map(
      (element) => element.getAttribute('aria-label') ?? element.textContent,
    );
    expect(names).toEqual(['New item', 'Add item', 'To-do items', 'About this stack']);
  });
});

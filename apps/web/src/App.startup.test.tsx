import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';
import { AI_EDIT_HINT, EDIT_HINT, INTERACT_HINT } from './state/hints.ts';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function pressAltM(): void {
  act(() => {
    fireEvent.keyDown(document, { code: 'KeyM', key: 'm', altKey: true });
  });
}

function chooseMode(label: 'Interact' | 'Edit' | 'AI edit'): void {
  fireEvent.click(screen.getByRole('radio', { name: label }));
}

function hintText(): string {
  return screen.getByRole('status').textContent ?? '';
}

function cardPosition(): string {
  return screen.getByText(/^Card \d+ of \d+$/).textContent ?? '';
}

/** Whether the Object wrapper with this accessible name is the selected one (Edit mode). */
function isSelected(name: string): boolean {
  return screen.getByRole('button', { name }).getAttribute('aria-pressed') === 'true';
}

/** The names of the elements a Tab key would visit, in document order. */
function tabStops(root: HTMLElement): string[] {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('input, textarea, button, select, a[href], [tabindex]'),
  );
  return candidates
    .filter((element) => {
      if (element.getAttribute('tabindex') === '-1') return false;
      if (element.closest('[inert]') !== null) return false;
      // A native radio group is one Tab stop: the checked radio.
      if (element instanceof HTMLInputElement && element.type === 'radio') return element.checked;
      return element.tabIndex >= 0;
    })
    .map(
      (element) =>
        element.getAttribute('aria-label') ??
        (element instanceof HTMLInputElement
          ? (element.closest('label')?.textContent ?? '')
          : (element.textContent ?? '')),
    );
}

describe('App startup with an invalid stack', () => {
  const invalidText = JSON.stringify({ formatVersion: 1 });

  it('shows code, path, and message of each error and renders no Stack_Window', () => {
    const { container } = render(<App stackText={invalidText} />);
    const alert = screen.getByRole('alert');
    expect(within(alert).getAllByText('MISSING_PROPERTY').length).toBeGreaterThan(0);
    expect(alert.textContent).toContain('(root)');
    // Every listed error carries a non-empty plain-language message.
    const items = alert.querySelectorAll('li');
    expect(items.length).toBeGreaterThan(0);
    for (const item of Array.from(items)) {
      const paragraphs = item.querySelectorAll('p');
      expect(paragraphs[1]?.textContent ?? '').not.toBe('');
    }
    expect(container.querySelector('.stack-window')).toBeNull();
    expect(container.querySelector('.canvas')).toBeNull();
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
  });

  it('keeps exactly one h1 "HyperGeist"', () => {
    const { container } = render(<App stackText="not json" />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'HyperGeist' })).toBeTruthy();
  });
});

describe('App startup with the Demo_Stack', () => {
  it('renders the Desktop with exactly one h1 "HyperGeist" in Interact mode on Card 1', () => {
    const { container } = render(<App />);
    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'HyperGeist' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Interact' })).toHaveProperty('checked', true);
    expect(cardPosition()).toBe('Card 1 of 3');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('gives the Menu_Bar, Mode_Control, windows, and landmarks accessible names', () => {
    render(<App />);
    const menuBar = screen.getByRole('banner', { name: 'Menu bar' });
    const group = within(menuBar).getByRole('radiogroup', { name: 'Mode' });
    expect(
      within(group)
        .getAllByRole('radio')
        .map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Interact', 'Edit', 'AI edit']);
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Thin slice to-do' })).toBeTruthy();
    expect(screen.getByRole('contentinfo', { name: 'Status' })).toBeTruthy();
  });

  it('cycles the Mode with Alt+M and sets it with the radio control', () => {
    render(<App />);
    pressAltM();
    expect(screen.getByRole('radio', { name: 'Edit' })).toHaveProperty('checked', true);
    expect(screen.getByText('Mode: Edit')).toBeTruthy();
    pressAltM();
    expect(screen.getByRole('radio', { name: 'AI edit' })).toHaveProperty('checked', true);
    expect(screen.getByText('Mode: AI edit')).toBeTruthy();
    pressAltM();
    expect(screen.getByRole('radio', { name: 'Interact' })).toHaveProperty('checked', true);
    expect(screen.getByText('Mode: Interact')).toBeTruthy();
    chooseMode('AI edit');
    expect(screen.getByText('Mode: AI edit')).toBeTruthy();
    chooseMode('Interact');
    expect(screen.getByText('Mode: Interact')).toBeTruthy();
    chooseMode('Edit');
    pressAltM();
    expect(screen.getByRole('radio', { name: 'AI edit' })).toHaveProperty('checked', true);
  });

  it('ignores M without Alt', () => {
    render(<App />);
    act(() => {
      fireEvent.keyDown(document, { code: 'KeyM', key: 'm' });
    });
    expect(screen.getByText('Mode: Interact')).toBeTruthy();
  });

  it('shows a different hint per Mode, and each names Alt+M', () => {
    render(<App />);
    const interactHint = hintText();
    expect(interactHint).toBe(INTERACT_HINT);
    expect(interactHint).toContain('Alt+M');
    pressAltM();
    const editHint = hintText();
    expect(editHint).toBe(EDIT_HINT);
    expect(editHint).toContain('Alt+M');
    expect(editHint).not.toBe(interactHint);
    pressAltM();
    const aiEditHint = hintText();
    expect(aiEditHint).toBe(AI_EDIT_HINT);
    expect(aiEditHint).toContain('Alt+M');
    expect(aiEditHint).not.toBe(editHint);
    expect(aiEditHint).not.toBe(interactHint);
  });

  it('selects an object in AI edit mode and Alt+M leaves it', () => {
    render(<App />);
    chooseMode('AI edit');
    fireEvent.click(screen.getByRole('button', { name: 'Add item (button)' }));
    expect(isSelected('Add item (button)')).toBe(true);
    expect(screen.getByLabelText('Properties').textContent).toContain('todo-add');
    expect(hintText()).toBe(AI_EDIT_HINT);
    // Alt+M leaves AI edit mode, which ends the Selection.
    pressAltM();
    expect(screen.getByText('Mode: Interact')).toBeTruthy();
    expect(screen.queryByLabelText('Properties')).toBeNull();
  });

  it('clears the Selection when the Mode toggles with Alt+M', () => {
    render(<App />);
    chooseMode('Edit');
    fireEvent.click(screen.getByRole('button', { name: 'Add item (button)' }));
    expect(isSelected('Add item (button)')).toBe(true);
    expect(screen.getByText('todo-add')).toBeTruthy();
    pressAltM();
    pressAltM();
    pressAltM();
    expect(screen.getByRole('radio', { name: 'Edit' })).toHaveProperty('checked', true);
    expect(isSelected('Add item (button)')).toBe(false);
    expect(screen.queryByText('todo-add')).toBeNull();
  });

  it('clears the Selection on Escape in Edit mode', () => {
    render(<App />);
    chooseMode('Edit');
    fireEvent.click(screen.getByRole('button', { name: 'Add item (button)' }));
    expect(isSelected('Add item (button)')).toBe(true);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    });
    expect(isSelected('Add item (button)')).toBe(false);
  });

  it('adds an item end to end: List shows it, Field empties, status says "Item added."', () => {
    render(<App />);
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: 'New item' });
    fireEvent.change(input, { target: { value: 'Buy milk' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    const list = screen.getByRole('list', { name: 'To-do items' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Buy milk']);
    expect(input.value).toBe('');
    expect(hintText()).toBe('Item added.');
  });

  it('puts the Ghost window in the rail with its accessible name and no interactive element', () => {
    const { container } = render(<App />);
    const ghost = screen.getByRole('complementary', {
      name: 'Ghost is asleep. AI arrives in a later release.',
    });
    expect(container.querySelector('.rail')?.contains(ghost)).toBe(true);
    expect(
      ghost.querySelector('button, a, input, textarea, select, [tabindex], [contenteditable]'),
    ).toBeNull();
    expect(within(ghost).getByText('AI arrives in a later release')).toBeTruthy();
  });

  it('shows no not-saved notice on the three Cards, and the Limits card states the real limits', () => {
    const { container } = render(<App />);
    const expectNoNotice = (): void => {
      expect(screen.queryByRole('note')).toBeNull();
      expect(container.textContent).not.toContain('Changes are not saved');
      expect(container.textContent).not.toContain('Reloading the page resets');
    };
    expectNoNotice();
    fireEvent.click(screen.getByRole('button', { name: 'About this stack' }));
    expect(cardPosition()).toBe('Card 2 of 3');
    expectNoNotice();
    fireEvent.click(screen.getByRole('button', { name: 'Limits' }));
    expect(cardPosition()).toBe('Card 3 of 3');
    expectNoNotice();
    const limits = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Limits' }).value;
    expect(limits).toContain('stored in this browser only');
    expect(limits).toContain("Clearing the browser's site data deletes them");
    expect(limits).toContain('overwrite each other');
    expect(limits).toContain('The last save wins');
    expect(limits).toContain('can lose the last second');
    expect(limits).toContain('The open card and the mode are not saved');
  });

  it('orders Tab stops as Mode_Control, Objects, then Links on each Card', () => {
    const { container } = render(<App />);
    expect(tabStops(container)).toEqual([
      'Interact',
      'New item',
      'Add item',
      'To-do items',
      'About this stack',
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'About this stack' }));
    expect(tabStops(container)).toEqual(['Interact', 'About', 'Back to to-do', 'Limits']);
  });

  it('keeps the Mode_Control a single Tab stop in Edit mode too', () => {
    const { container } = render(<App />);
    chooseMode('Edit');
    const stops = tabStops(container);
    expect(
      stops.filter((name) => name === 'Interact' || name === 'Edit' || name === 'AI edit'),
    ).toEqual(['Edit']);
    expect(stops.slice(0, 2)).toEqual(['Edit', 'New item (field)']);
    expect(stops[stops.length - 1]).toBe('About this stack');
  });

  it.each(['interact', 'edit'] as const)(
    'has no literal color, font, or background in inline styles in %s mode',
    (mode) => {
      const { container } = render(<App />);
      if (mode === 'edit') {
        chooseMode('Edit');
        fireEvent.click(screen.getByRole('button', { name: 'Add item (button)' }));
      }
      const styled = Array.from(container.querySelectorAll<HTMLElement>('[style]'));
      expect(styled.length).toBeGreaterThan(0);
      for (const element of styled) {
        for (let index = 0; index < element.style.length; index += 1) {
          const name = element.style.item(index);
          const value = element.style.getPropertyValue(name);
          // Geometry custom properties, or a color property that names a design token.
          const ok = name.startsWith('--') || /^var\(--(ink|paper)\)$/.test(value);
          expect(ok, `${name}: ${value}`).toBe(true);
        }
        expect(element.getAttribute('style')).not.toMatch(
          /#[0-9a-f]{3,8}\b|rgb|hsl|font|background/i,
        );
      }
      for (const element of Array.from(container.querySelectorAll('[fill], [stroke]'))) {
        for (const attribute of ['fill', 'stroke']) {
          const value = element.getAttribute(attribute);
          if (value !== null) expect(value).toMatch(/^(currentColor|none|var\(--(ink|paper)\))$/);
        }
      }
    },
  );
});

describe('App makes no storage writes', () => {
  beforeEach(() => {
    vi.stubGlobal('indexedDB', { open: vi.fn(), deleteDatabase: vi.fn(), databases: vi.fn() });
  });

  it('never writes to localStorage, sessionStorage, document.cookie, or indexedDB', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const clear = vi.spyOn(Storage.prototype, 'clear');
    const cookieSet = vi.spyOn(document, 'cookie', 'set');
    const idb = globalThis.indexedDB;
    const open = vi.spyOn(idb, 'open');
    const deleteDatabase = vi.spyOn(idb, 'deleteDatabase');

    render(<App />);
    fireEvent.change(screen.getByRole('textbox', { name: 'New item' }), {
      target: { value: 'Persist me' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
    fireEvent.click(screen.getByRole('button', { name: 'About this stack' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to to-do' }));
    chooseMode('Edit');
    fireEvent.click(screen.getByRole('button', { name: 'Add item (button)' }));
    pressAltM();

    for (const spy of [setItem, removeItem, clear, cookieSet, open, deleteDatabase]) {
      expect(spy).not.toHaveBeenCalled();
    }
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});

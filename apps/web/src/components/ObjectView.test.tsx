import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiFieldObject, ImageObject, Stack, StackObject } from '@hypergeist/shared/format';
import { EffectsProvider } from '../state/EffectsContext.tsx';
import { createEffectsStore } from '../state/effects-store.ts';
import type { EffectsStoreApi } from '../state/effects-store.ts';
import { StackStoreContext } from '../state/StackStoreContext.tsx';
import { createStackStore } from '../state/stack-store.ts';
import { ObjectView } from './ObjectView.tsx';

const SRC = 'https://example.com/never-loaded-picture.png';

const image: ImageObject = {
  id: 'pic',
  type: 'image',
  name: 'Cover',
  x: 8,
  y: 8,
  width: 120,
  height: 80,
  src: SRC,
  alt: 'A ghost at a desk',
};

const aiField: AiFieldObject = {
  id: 'summary',
  type: 'ai-field',
  name: 'Summary',
  x: 8,
  y: 100,
  width: 200,
  height: 60,
  prompt: 'Summarize the notes.',
  inputObjectIds: [],
  value: 'Three notes about lunch.',
};

function stackWith(objects: readonly StackObject[]): Stack {
  return {
    formatVersion: 1,
    id: 'object-view-test',
    name: 'Object view test',
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'main',
    cards: [{ id: 'main', name: 'Main', objects: [...objects], links: [], onOpen: [] }],
  };
}

function setup(object: StackObject) {
  const store = createStackStore(stackWith([object]));
  const view = render(
    <StackStoreContext.Provider value={store}>
      <ObjectView object={object} />
    </StackStoreContext.Provider>,
  );
  return { store, view };
}

function setupWithEffects(object: StackObject) {
  const stack = stackWith([object]);
  const store = createStackStore(stack);
  const effects: EffectsStoreApi = createEffectsStore();
  const view = render(
    <StackStoreContext.Provider value={store}>
      <EffectsProvider store={effects}>
        <ObjectView object={object} />
      </EffectsProvider>
    </StackStoreContext.Provider>,
  );
  const key = `${stack.id}/${object.id}`;
  return { store, effects, key, view };
}

const fetchStub = vi.fn();

beforeEach(() => {
  fetchStub.mockReset();
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ObjectView image', () => {
  it('renders a placeholder with the word Image and the alt text, and no <img>', () => {
    const { view } = setup(image);
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.querySelector('[src]')).toBeNull();
    expect(view.container.innerHTML).not.toContain(SRC);
    const placeholder = screen.getByRole('img', { name: 'A ghost at a desk' });
    expect(placeholder.textContent).toContain('Image');
    expect(placeholder.textContent).toContain('A ghost at a desk');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('labels the placeholder with the name when alt is empty, then the id', () => {
    setup({ ...image, alt: '' });
    expect(screen.getByRole('img', { name: 'Cover' })).toBeTruthy();
    cleanup();
    setup({ ...image, alt: '', name: '' });
    expect(screen.getByRole('img', { name: 'pic' })).toBeTruthy();
  });

  it('stays a placeholder with no <img> and no network call in Edit mode', () => {
    const { store, view } = setup(image);
    act(() => {
      store.getState().setMode('edit');
    });
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.innerHTML).not.toContain(SRC);
    expect(view.container.querySelector('.object-preview')?.hasAttribute('inert')).toBe(true);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('never creates an <img> for a very large data URI source', () => {
    const data = `data:image/png;base64,${'A'.repeat(200_000)}`;
    const { view } = setup({ ...image, src: data });
    expect(view.container.querySelector('img')).toBeNull();
    expect(view.container.innerHTML).not.toContain('AAAAAAAA');
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

describe('ObjectView ai-field', () => {
  it('renders a read-only textarea with the value and the placeholder', () => {
    setup(aiField);
    const box = screen.getByRole('textbox', { name: 'Summary' });
    expect(box.tagName).toBe('TEXTAREA');
    expect((box as HTMLTextAreaElement).value).toBe('Three notes about lunch.');
    expect((box as HTMLTextAreaElement).readOnly).toBe(true);
    expect(box.getAttribute('placeholder')).toBe('AI field. Press its button to fill it.');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('shows the placeholder when the value is empty', () => {
    setup({ ...aiField, value: '' });
    expect(screen.getByPlaceholderText('AI field. Press its button to fill it.')).toBeTruthy();
  });

  it('falls back to the id for the label when the name is empty', () => {
    setup({ ...aiField, name: '' });
    expect(screen.getByRole('textbox', { name: 'summary' })).toBeTruthy();
  });

  it('is an inert preview in Edit mode', () => {
    const { store, view } = setup(aiField);
    act(() => {
      store.getState().setMode('edit');
    });
    const preview = view.container.querySelector('.object-preview');
    expect(preview?.hasAttribute('inert')).toBe(true);
    const box = preview?.querySelector('textarea');
    expect(box?.readOnly).toBe(true);
    expect(box?.tabIndex).toBe(-1);
  });
});

describe('ObjectView ai-field effects', () => {
  it('shows visible Thinking... text, aria-busy and ai-active while the field runs', () => {
    const { effects, key, view } = setupWithEffects(aiField);
    expect(screen.queryByText('Thinking...')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Summary' }).getAttribute('aria-busy')).toBe(
      'false',
    );
    expect(view.container.querySelector('.ai-active')).toBeNull();

    act(() => {
      effects.getState().setRunning(key, true);
    });
    expect(screen.getByText('Thinking...')).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Summary' }).getAttribute('aria-busy')).toBe('true');
    expect(view.container.querySelector('.ai-field-box.ai-active')).not.toBeNull();

    act(() => {
      effects.getState().setRunning(key, false);
    });
    expect(screen.queryByText('Thinking...')).toBeNull();
    expect(view.container.querySelector('.ai-active')).toBeNull();
  });

  it('ignores a run of another object', () => {
    const { effects } = setupWithEffects(aiField);
    act(() => {
      effects.getState().setRunning('object-view-test/other', true);
    });
    expect(screen.queryByText('Thinking...')).toBeNull();
  });

  it('keeps the textarea read-only and shows the new placeholder', () => {
    setupWithEffects({ ...aiField, value: '' });
    const box = screen.getByRole('textbox', { name: 'Summary' }) as HTMLTextAreaElement;
    expect(box.readOnly).toBe(true);
    expect(box.placeholder).toBe('AI field. Press its button to fill it.');
  });

  it('has a polite live region without a role', () => {
    const { view } = setupWithEffects(aiField);
    const live = view.container.querySelector('[aria-live]');
    expect(live).not.toBeNull();
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.hasAttribute('role')).toBe(false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(live?.textContent).toBe('');
  });

  it('announces the update after a run changes the value', () => {
    const { store, effects, key, view } = setupWithEffects(aiField);
    const live = () => view.container.querySelector('[aria-live]')?.textContent;
    act(() => {
      effects.getState().setRunning(key, true);
    });
    // The Canvas passes the new value as a prop when the stack changes. Here it is passed by hand.
    view.rerender(
      <StackStoreContext.Provider value={store}>
        <EffectsProvider store={effects}>
          <ObjectView object={{ ...aiField, value: 'New text.' }} />
        </EffectsProvider>
      </StackStoreContext.Provider>,
    );
    act(() => {
      effects.getState().setRunning(key, false);
    });
    expect(live()).toBe('AI field Summary updated');
  });

  it('does not announce a value change that was not a run', () => {
    const { store, effects, view } = setupWithEffects(aiField);
    view.rerender(
      <StackStoreContext.Provider value={store}>
        <EffectsProvider store={effects}>
          <ObjectView object={{ ...aiField, value: 'Other.' }} />
        </EffectsProvider>
      </StackStoreContext.Provider>,
    );
    expect(view.container.querySelector('[aria-live]')?.textContent).toBe('');
  });

  it('does not announce when the run ends with the same value', () => {
    const { effects, key, view } = setupWithEffects(aiField);
    act(() => {
      effects.getState().setRunning(key, true);
    });
    act(() => {
      effects.getState().setRunning(key, false);
    });
    expect(view.container.querySelector('[aria-live]')?.textContent).toBe('');
  });

  it('keeps tabIndex -1 in the Edit mode preview, also while running', () => {
    const { store, effects, key, view } = setupWithEffects(aiField);
    act(() => {
      store.getState().setMode('edit');
    });
    act(() => {
      effects.getState().setRunning(key, true);
    });
    const box = view.container.querySelector('.object-preview textarea');
    expect(box?.getAttribute('tabindex')).toBe('-1');
    expect(view.container.querySelector('.object-preview [aria-live]')).toBeNull();
  });

  it('works without an EffectsProvider: no Thinking text, no live region', () => {
    const { view } = setup(aiField);
    const box = screen.getByRole('textbox', { name: 'Summary' });
    expect(box.getAttribute('aria-busy')).toBe('false');
    expect(screen.queryByText('Thinking...')).toBeNull();
    expect(view.container.querySelector('[aria-live]')).toBeNull();
    expect(view.container.querySelector('.ai-active')).toBeNull();
  });
});

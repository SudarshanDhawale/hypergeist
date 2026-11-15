import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiFieldObject, ImageObject, Stack, StackObject } from '@hypergeist/shared/format';
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
    expect(box.getAttribute('placeholder')).toBe('AI field. AI arrives in a later release.');
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('shows the placeholder when the value is empty', () => {
    setup({ ...aiField, value: '' });
    expect(screen.getByPlaceholderText('AI field. AI arrives in a later release.')).toBeTruthy();
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

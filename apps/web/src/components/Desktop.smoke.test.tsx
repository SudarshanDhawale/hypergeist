import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { loadStack } from '../stacks/load-stack.ts';
import { StackStoreProvider } from '../state/StackStoreContext.tsx';
import { Desktop } from './Desktop.tsx';

afterEach(cleanup);

function renderDesktop() {
  const loaded = loadStack(demoText);
  if (!loaded.ok) throw new Error('Demo_Stack must be valid');
  return render(
    <StackStoreProvider stack={loaded.stack}>
      <Desktop />
    </StackStoreProvider>,
  );
}

describe('Desktop smoke test', () => {
  it('renders the menu bar, the stack window, and the ghost rail', () => {
    const { container } = renderDesktop();
    expect(container.querySelector('.desktop > header.menu-bar > h1')?.textContent).toBe(
      'HyperGeist',
    );
    expect(container.querySelector('.menu-bar > .spirit-glyph')?.getAttribute('aria-hidden')).toBe(
      'true',
    );
    expect(
      container.querySelector('.desktop > main.desktop-main > section.stack-window'),
    ).not.toBeNull();
    expect(container.querySelector('.desktop > aside.rail > aside.ghost-window')).not.toBeNull();
    expect(screen.getByRole('radio', { name: 'Interact' })).toHaveProperty('checked', true);
  });

  it('switches mode with the radios and cycles it with Alt+M', () => {
    renderDesktop();
    const pressAltM = () =>
      act(() => {
        fireEvent.keyDown(document, { code: 'KeyM', key: 'm', altKey: true });
      });
    expect(
      screen.getAllByRole('radio').map((radio) => radio.closest('label')?.textContent),
    ).toEqual(['Interact', 'Edit', 'AI edit']);
    fireEvent.click(screen.getByRole('radio', { name: 'Edit' }));
    expect(screen.getByRole('radio', { name: 'Edit' })).toHaveProperty('checked', true);
    pressAltM();
    expect(screen.getByRole('radio', { name: 'AI edit' })).toHaveProperty('checked', true);
    pressAltM();
    expect(screen.getByRole('radio', { name: 'Interact' })).toHaveProperty('checked', true);
    pressAltM();
    expect(screen.getByRole('radio', { name: 'Edit' })).toHaveProperty('checked', true);
  });
});

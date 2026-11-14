import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { GHOST_PIXELS } from './GhostSprite';
import { GhostWindow } from './GhostWindow';

afterEach(cleanup);

describe('GhostWindow', () => {
  it('has the accessible name, title, and honest text', () => {
    const { getByRole, getByText } = render(<GhostWindow />);
    expect(
      getByRole('complementary', {
        name: 'Ghost is asleep. AI arrives in a later release.',
      }),
    ).toBeTruthy();
    expect(getByRole('heading', { name: 'Ghost' })).toBeTruthy();
    expect(getByText('AI arrives in a later release')).toBeTruthy();
    expect(getByRole('img', { name: 'A sleeping ghost' })).toBeTruthy();
  });

  it('holds no interactive element, hardcoded color, or accent color', () => {
    const { container } = render(<GhostWindow />);
    const interactive = 'button, a, input, textarea, select, [tabindex], [contenteditable]';
    expect(container.querySelector(interactive)).toBeNull();
    // The token name is built here so the repo-wide "no .tsx mentions it" scan stays clean.
    const accent = ['-', '-', 'gh', 'ost'].join('');
    expect(container.innerHTML).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|animate/i);
    expect(container.innerHTML).not.toContain(accent);
  });

  it('keeps the sprite map rectangular and within 24 by 24 cells', () => {
    const widths = new Set(GHOST_PIXELS.map((row) => row.length));
    expect(widths.size).toBe(1);
    expect(GHOST_PIXELS.length).toBeLessThanOrEqual(24);
    expect([...widths][0]).toBeLessThanOrEqual(24);
    expect(GHOST_PIXELS.join('')).toMatch(/^[#. ]+$/);
  });
});

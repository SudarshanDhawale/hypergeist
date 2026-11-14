import { describe, expect, it } from 'vitest';
import type { ButtonObject } from '@hypergeist/shared/format';
import { objectCssVars } from './css-vars.ts';

const button: ButtonObject = {
  id: 'b1',
  type: 'button',
  name: '',
  x: 16,
  y: 48,
  width: 380,
  height: 28,
  label: 'Go',
  onClick: [],
};

describe('objectCssVars', () => {
  it('returns unitless position and size custom properties', () => {
    expect(objectCssVars(button)).toEqual({ '--x': 16, '--y': 48, '--w': 380, '--h': 28 });
  });

  it('returns edge values unchanged', () => {
    expect(objectCssVars({ ...button, x: 0, y: 0, width: 8, height: 8 })).toEqual({
      '--x': 0,
      '--y': 0,
      '--w': 8,
      '--h': 8,
    });
  });
});

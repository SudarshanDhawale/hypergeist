import { describe, expect, it } from 'vitest';
import * as root from './index';
import * as format from './format/index';
import * as engine from './engine/index';

describe('shared package entry points', () => {
  it.each([
    ['.', root],
    ['./format', format],
    ['./engine', engine],
  ])('loads the %s entry module with no exports yet', (_name, entry) => {
    expect(typeof entry).toBe('object');
    expect(Object.keys(entry)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { validateStack } from '@hypergeist/shared/format';
import { loadSeedSet } from './seed-set.ts';
import demoText from '../stacks/thin-slice-todo.json?raw';

/** A small valid stack with the given id. */
function stackText(id: string): string {
  return JSON.stringify({
    formatVersion: 1,
    id,
    name: `Stack ${id}`,
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'c1',
    cards: [{ id: 'c1', name: 'One', objects: [], links: [], onOpen: [] }],
  });
}

describe('loadSeedSet with the bundled files', () => {
  const seedSet = loadSeedSet();

  it('has no problems', () => {
    expect(seedSet.problems).toEqual([]);
  });

  it('has at least one stack, and the demo stack is among them', () => {
    expect(seedSet.stacks.length).toBeGreaterThanOrEqual(1);
    expect(seedSet.stacks.map((s) => s.stack.id)).toContain('thin-slice-todo');
  });

  it('gives only stacks that pass validateStack', () => {
    for (const seed of seedSet.stacks) {
      expect(validateStack(seed.stack)).toEqual({ valid: true, errors: [], truncated: false });
    }
  });

  it('has unique stack ids', () => {
    const ids = seedSet.stacks.map((s) => s.stack.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses only .json files directly under apps/web/src/stacks/', () => {
    const direct = Object.keys(import.meta.glob('../stacks/*.json'));
    const nested = Object.keys(import.meta.glob('../stacks/**/*.json'));
    expect(direct.length).toBeGreaterThanOrEqual(1);
    // A nested file is not a seed. This fails if someone adds one and expects it to be seeded.
    expect(nested.sort()).toEqual(direct.sort());
    expect(seedSet.stacks).toHaveLength(direct.length);
  });
});

describe('loadSeedSet with injected files', () => {
  it('reports invalid JSON as a problem and still loads the other files', () => {
    const result = loadSeedSet({
      'a.json': '{ not json',
      'b.json': stackText('beta'),
    });
    expect(result.stacks.map((s) => s.stack.id)).toEqual(['beta']);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.file).toBe('a.json');
    expect(result.problems[0]?.errors[0]?.code).toBe('INVALID_JSON');
  });

  it('reports a structurally invalid stack as a problem', () => {
    const result = loadSeedSet({ 'a.json': '{"formatVersion":1}' });
    expect(result.stacks).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.errors.length).toBeGreaterThan(0);
  });

  it('keeps the first file with a stack id and reports the later one as DUPLICATE_ID', () => {
    const result = loadSeedSet({
      'b.json': stackText('same'),
      'a.json': stackText('same'),
      'c.json': stackText('other'),
    });
    expect(result.stacks.map((s) => s.stack.id)).toEqual(['same', 'other']);
    expect(result.problems).toHaveLength(1);
    const problem = result.problems[0];
    expect(problem?.file).toBe('b.json');
    expect(problem?.errors).toHaveLength(1);
    expect(problem?.errors[0]).toMatchObject({
      code: 'DUPLICATE_ID',
      path: '/id',
      actual: '"same"',
    });
  });

  it('orders stacks and problems by file name, not by insertion order', () => {
    const result = loadSeedSet({
      'c.json': stackText('gamma'),
      'z.json': 'nope',
      'a.json': stackText('alpha'),
      'b.json': stackText('beta'),
      'm.json': 'nope',
    });
    expect(result.stacks.map((s) => s.stack.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(result.problems.map((p) => p.file)).toEqual(['m.json', 'z.json']);
  });

  it('gives an empty result for no files', () => {
    expect(loadSeedSet({})).toEqual({ stacks: [], problems: [] });
  });

  it('does not modify the input and gives the same result on a second call', () => {
    const files: Record<string, string> = {
      'b.json': stackText('beta'),
      'a.json': demoText,
      'c.json': 'nope',
    };
    const snapshot = { ...files };
    const keysBefore = Object.keys(files);
    const first = loadSeedSet(files);
    const second = loadSeedSet(files);
    expect(files).toEqual(snapshot);
    expect(Object.keys(files)).toEqual(keysBefore);
    expect(second).toEqual(first);
  });
});

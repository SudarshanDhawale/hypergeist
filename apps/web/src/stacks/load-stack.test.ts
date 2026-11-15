import { describe, expect, it } from 'vitest';
import demoText from './thin-slice-todo.json?raw';
import { loadStack } from './load-stack.ts';

describe('loadStack', () => {
  it('returns the typed Stack for the bundled Demo_Stack text', () => {
    const result = loadStack(demoText);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.stack.formatVersion).toBe(1);
    expect(result.stack.cards.some((card) => card.id === result.stack.startCardId)).toBe(true);
  });

  it('returns structured errors for invalid text', () => {
    const result = loadStack('{ not json');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.code).toBe('INVALID_JSON');
  });

  it('returns structured errors for empty text', () => {
    const result = loadStack('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe('INVALID_JSON');
    expect(result.errors[0]?.path).toBe('');
  });

  it('rejects a Stack with one unknown object type and points at its type', () => {
    const stack: unknown = JSON.parse(demoText);
    const mutated = structuredClone(stack) as {
      cards: { objects: { type: string }[] }[];
    };
    const target = mutated.cards[0]?.objects[0];
    if (target === undefined) throw new Error('Demo_Stack first Card has no Objects');
    target.type = 'nope';

    const result = loadStack(JSON.stringify(mutated));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = result.errors.find((e) => e.path === '/cards/0/objects/0/type');
    expect(error).toBeDefined();
    expect(error?.message).toContain('is unknown');
  });
});

import { describe, expect, it } from 'vitest';
import { ENTITY_ID_PATTERN, validateStack } from '@hypergeist/shared/format';
import { pickNewStackId, startNewStack } from './new-stack.ts';

describe('pickNewStackId', () => {
  it('returns my-stack when nothing is taken', () => {
    expect(pickNewStackId(new Set())).toBe('my-stack');
    expect(pickNewStackId([])).toBe('my-stack');
  });

  it('returns my-stack when only other ids are taken', () => {
    expect(pickNewStackId(new Set(['todo', 'my-stack-2']))).toBe('my-stack');
  });

  it('returns my-stack-2 when my-stack is taken', () => {
    expect(pickNewStackId(new Set(['my-stack']))).toBe('my-stack-2');
  });

  it('skips taken numbers', () => {
    expect(pickNewStackId(new Set(['my-stack', 'my-stack-2', 'my-stack-3']))).toBe('my-stack-4');
    expect(pickNewStackId(new Set(['my-stack', 'my-stack-3']))).toBe('my-stack-2');
  });

  it('finds a free id among many taken ids', () => {
    const taken = new Set<string>(['my-stack']);
    for (let n = 2; n <= 2000; n += 1) taken.add(`my-stack-${n}`);
    const id = pickNewStackId(taken);
    expect(id).toBe('my-stack-2001');
    expect(taken.has(id)).toBe(false);
    expect(ENTITY_ID_PATTERN.test(id)).toBe(true);
  });

  it('is deterministic and does not change its input', () => {
    const taken = new Set(['my-stack']);
    const before = [...taken];
    expect(pickNewStackId(taken)).toBe(pickNewStackId(taken));
    expect([...taken]).toEqual(before);
  });

  it('gives ids that match the Entity ID pattern', () => {
    const taken = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      const id = pickNewStackId(taken);
      expect(ENTITY_ID_PATTERN.test(id)).toBe(true);
      expect(taken.has(id)).toBe(false);
      taken.add(id);
    }
  });
});

describe('startNewStack', () => {
  it('makes a valid stack named "New stack" with one empty card', () => {
    const { stack, currentCardId } = startNewStack({ takenIds: new Set() });
    expect(validateStack(stack).valid).toBe(true);
    expect(stack.id).toBe('my-stack');
    expect(stack.name).toBe('New stack');
    expect(stack.cards).toHaveLength(1);
    expect(stack.cards[0]?.objects).toEqual([]);
    expect(stack.startCardId).toBe(currentCardId);
    expect(stack.cards[0]?.id).toBe(currentCardId);
    expect(ENTITY_ID_PATTERN.test(stack.id)).toBe(true);
    expect(ENTITY_ID_PATTERN.test(currentCardId)).toBe(true);
  });

  it('uses a free id when my-stack is taken', () => {
    const { stack } = startNewStack({ takenIds: new Set(['my-stack', 'my-stack-2']) });
    expect(stack.id).toBe('my-stack-3');
    expect(validateStack(stack).valid).toBe(true);
  });

  it('accepts an array of taken ids', () => {
    expect(startNewStack({ takenIds: ['my-stack'] }).stack.id).toBe('my-stack-2');
  });

  it('is deterministic', () => {
    const taken = new Set(['my-stack']);
    expect(startNewStack({ takenIds: taken })).toEqual(startNewStack({ takenIds: taken }));
  });

  it('does not throw with many taken ids', () => {
    const taken = new Set<string>(['my-stack']);
    for (let n = 2; n <= 500; n += 1) taken.add(`my-stack-${n}`);
    const { stack } = startNewStack({ takenIds: taken });
    expect(stack.id).toBe('my-stack-501');
    expect(validateStack(stack).valid).toBe(true);
  });
});

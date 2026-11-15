import { describe, expect, it } from 'vitest';
import { ENTITY_ID_PATTERN } from '../format/index.ts';
import type { Stack } from '../format/index.ts';
import { collectEntityIds, nextEntityId } from './ids.ts';

const frame = { x: 0, y: 0, width: 100, height: 30 };

function makeStack(): Stack {
  return {
    formatVersion: 1,
    id: 's',
    name: 'S',
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'card-1',
    cards: [
      {
        id: 'card-1',
        name: 'One',
        objects: [
          { id: 'obj-1', type: 'button', name: 'Go', ...frame, label: 'Go', onClick: [] },
          {
            id: 'obj-3',
            type: 'list',
            name: 'Items',
            ...frame,
            items: [],
            ordered: false,
          },
        ],
        links: [{ id: 'link-1', targetCardId: 'card-2', label: 'Next' }],
        onOpen: [],
      },
      {
        id: 'card-2',
        name: 'Two',
        objects: [],
        links: [],
        onOpen: [],
      },
    ],
  };
}

describe('collectEntityIds', () => {
  it('collects Card, Object and Link ids', () => {
    expect([...collectEntityIds(makeStack())].sort()).toEqual([
      'card-1',
      'card-2',
      'link-1',
      'obj-1',
      'obj-3',
    ]);
  });

  it('does not modify a frozen Stack', () => {
    const stack = makeStack();
    Object.freeze(stack);
    expect(() => collectEntityIds(stack)).not.toThrow();
  });
});

describe('nextEntityId', () => {
  it('gives <kind>-1 for an empty set', () => {
    expect(nextEntityId(new Set(), 'card')).toBe('card-1');
    expect(nextEntityId(new Set(), 'obj')).toBe('obj-1');
    expect(nextEntityId(new Set(), 'link')).toBe('link-1');
  });

  it('picks the smallest unused number, filling gaps', () => {
    expect(nextEntityId(new Set(['obj-1', 'obj-3']), 'obj')).toBe('obj-2');
    expect(nextEntityId(new Set(['obj-1', 'obj-2', 'obj-3']), 'obj')).toBe('obj-4');
    expect(nextEntityId(new Set(['obj-2']), 'obj')).toBe('obj-1');
  });

  it('checks uniqueness across kinds', () => {
    expect(nextEntityId(new Set(['card-1']), 'card')).toBe('card-2');
    // `card-1` is held by an Object in this case; the kind of the holder does not matter.
    const withObjectNamedCard: Stack = {
      ...makeStack(),
      startCardId: 'c1',
      cards: [
        {
          id: 'c1',
          name: 'C',
          objects: [{ id: 'card-1', type: 'button', name: 'B', ...frame, label: 'B', onClick: [] }],
          links: [],
          onOpen: [],
        },
      ],
    };
    expect(nextEntityId(collectEntityIds(withObjectNamedCard), 'card')).toBe('card-2');
  });

  it('ignores ids of other kinds that merely share a number', () => {
    expect(nextEntityId(new Set(['card-1', 'link-1']), 'obj')).toBe('obj-1');
  });

  it('handles ids such as constructor and __proto__', () => {
    const used = new Set(['constructor', '__proto__', 'toString', 'hasOwnProperty']);
    expect(nextEntityId(used, 'card')).toBe('card-1');
  });

  it('is deterministic', () => {
    const used = new Set(['link-1', 'link-2']);
    expect(nextEntityId(used, 'link')).toBe(nextEntityId(used, 'link'));
  });

  it('always matches the Entity_ID pattern', () => {
    const used = new Set<string>();
    for (let i = 0; i < 300; i += 1) {
      const id = nextEntityId(used, 'card');
      expect(id).toMatch(ENTITY_ID_PATTERN);
      expect(used.has(id)).toBe(false);
      used.add(id);
    }
    expect(nextEntityId(used, 'card')).toBe('card-301');
  });
});

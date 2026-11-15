import { describe, expect, it } from 'vitest';
import type { AiFieldObject, Card, FieldObject, Link, Stack } from '../format/index.ts';
import { validateStack } from '../format/index.ts';
import { buildRenderModel } from './render-model.ts';
import type { RenderAiField, RenderModel } from './render-model.ts';

const frame = { x: 0, y: 0, width: 100, height: 30 };

function field(id: string, name: string, extra: Partial<FieldObject> = {}): FieldObject {
  return {
    id,
    type: 'field',
    name,
    ...frame,
    value: 'v',
    placeholder: '',
    multiline: false,
    readOnly: false,
    ...extra,
  };
}

function aiField(id: string, inputObjectIds: string[]): AiFieldObject {
  return {
    id,
    type: 'ai-field',
    name: `AI ${id}`,
    ...frame,
    prompt: 'Summarize',
    inputObjectIds,
    value: '',
  };
}

function card(id: string, name: string, extra: Partial<Card> = {}): Card {
  return { id, name, objects: [], links: [], onOpen: [], ...extra };
}

function stackOf(cards: Card[]): Stack {
  const [first] = cards;
  return {
    formatVersion: 1,
    id: 'stack-1',
    name: 'Test',
    cardWidth: 480,
    cardHeight: 320,
    startCardId: first?.id ?? 'none',
    cards,
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function modelOf(stack: Stack, cardId: string): RenderModel {
  const result = buildRenderModel(stack, cardId);
  if (!result.ok) {
    throw new Error(`expected a model, got ${JSON.stringify(result.errors)}`);
  }
  return result.model;
}

describe('buildRenderModel', () => {
  it('describes a Card with sizes, id, name, Objects in order and Links in order', () => {
    const objects = [field('a', 'Alpha'), field('b', 'Beta', { x: 10, y: 20 })];
    const links: Link[] = [
      { id: 'l1', label: 'Next', targetCardId: 'c2' },
      { id: 'l2', label: 'Back', targetCardId: 'c1' },
    ];
    const stack = stackOf([card('c1', 'First', { objects, links }), card('c2', 'Second')]);

    const model = modelOf(stack, 'c1');

    expect(model.cardWidth).toBe(480);
    expect(model.cardHeight).toBe(320);
    expect(model.id).toBe('c1');
    expect(model.name).toBe('First');
    expect(model.objects).toEqual(objects);
    expect(model.objects.map((object) => object.id)).toEqual(['a', 'b']);
    expect(model.links).toEqual([
      { id: 'l1', label: 'Next', targetCardId: 'c2', targetCardName: 'Second' },
      { id: 'l2', label: 'Back', targetCardId: 'c1', targetCardName: 'First' },
    ]);
  });

  it('returns empty arrays for a Card with 0 Objects and 0 Links', () => {
    const model = modelOf(stackOf([card('c1', 'Empty')]), 'c1');
    expect(model.objects).toEqual([]);
    expect(model.links).toEqual([]);
  });

  it('handles a Card with 100 Objects and 50 Links', () => {
    const objects = Array.from({ length: 100 }, (_, i) => field(`o${i}`, `Object ${i}`));
    // A Card may hold one Link per target Card, so 50 Links need 50 distinct targets.
    const links: Link[] = Array.from({ length: 50 }, (_, i) => ({
      id: `l${i}`,
      label: `Link ${i}`,
      targetCardId: `t${i}`,
    }));
    const targets = Array.from({ length: 50 }, (_, i) => card(`t${i}`, `Target ${i}`));
    const stack = stackOf([card('c1', 'Big', { objects, links }), ...targets]);
    expect(validateStack(stack).valid).toBe(true);

    const model = modelOf(stack, 'c1');

    expect(model.objects).toHaveLength(100);
    expect(model.links).toHaveLength(50);
    expect(model.objects.map((o) => o.id)).toEqual(objects.map((o) => o.id));
    expect(model.links.map((link) => link.targetCardName)).toEqual(
      targets.map((target) => target.name),
    );
  });

  it('adds inputs to an ai-field in inputObjectIds order and keeps inputObjectIds', () => {
    const objects = [field('a', 'Alpha'), field('b', 'Beta'), aiField('ai', ['b', 'a'])];
    const model = modelOf(stackOf([card('c1', 'One', { objects })]), 'c1');

    const ai = model.objects[2] as RenderAiField;
    expect(ai.type).toBe('ai-field');
    expect(ai.inputs).toEqual([
      { id: 'b', name: 'Beta' },
      { id: 'a', name: 'Alpha' },
    ]);
    expect(ai.inputObjectIds).toEqual(['b', 'a']);
    expect(model.objects[0]).not.toHaveProperty('inputs');
  });

  it('gives an ai-field with no inputs an empty inputs list', () => {
    const model = modelOf(stackOf([card('c1', 'One', { objects: [aiField('ai', [])] })]), 'c1');
    expect((model.objects[0] as RenderAiField).inputs).toEqual([]);
  });

  it('resolves a Link to its own Card', () => {
    const links: Link[] = [{ id: 'self', label: 'Stay', targetCardId: 'c1' }];
    const model = modelOf(stackOf([card('c1', 'Home', { links })]), 'c1');
    expect(model.links[0]?.targetCardName).toBe('Home');
  });

  it('does not clip an Object that lies beyond the card bounds', () => {
    const far = field('far', 'Far', { x: 5000, y: 4000, width: 800, height: 600 });
    const model = modelOf(stackOf([card('c1', 'One', { objects: [far] })]), 'c1');
    expect(model.objects[0]).toMatchObject({ x: 5000, y: 4000, width: 800, height: 600 });
  });

  it('survives a JSON round trip unchanged', () => {
    const objects = [field('a', 'Alpha'), aiField('ai', ['a'])];
    const links: Link[] = [{ id: 'l1', label: 'Go', targetCardId: 'c2' }];
    const stack = stackOf([card('c1', 'One', { objects, links }), card('c2', 'Two')]);
    const model = modelOf(stack, 'c1');

    expect(JSON.parse(JSON.stringify(model))).toEqual(model);
  });

  it('shares no object or array with the Stack and leaves the Stack unchanged when the model is changed', () => {
    const objects = [field('a', 'Alpha'), aiField('ai', ['a'])];
    const links: Link[] = [{ id: 'l1', label: 'Go', targetCardId: 'c2' }];
    const stack = stackOf([card('c1', 'One', { objects, links }), card('c2', 'Two')]);
    const before = JSON.parse(JSON.stringify(stack)) as Stack;
    const model = modelOf(stack, 'c1');

    const source = stack.cards[0];
    expect(model.objects).not.toBe(source?.objects);
    expect(model.links).not.toBe(source?.links);
    model.objects.forEach((object, i) => {
      expect(object).not.toBe(source?.objects[i]);
    });
    expect(model.links[0]).not.toBe(source?.links[0]);
    const ai = model.objects[1] as RenderAiField;
    expect(ai.inputObjectIds).not.toBe((source?.objects[1] as AiFieldObject).inputObjectIds);

    // Mutate a deep copy of the model (a model is plain data, so JSON copies it).
    const edited = JSON.parse(JSON.stringify(model)) as {
      objects: { name: string; inputObjectIds?: string[] }[];
      links: { label: string }[];
    };
    for (const object of edited.objects) {
      object.name = 'changed';
      object.inputObjectIds?.push('x');
    }
    for (const link of edited.links) {
      link.label = 'changed';
    }
    expect(stack).toEqual(before);

    // Mutate the model itself through casts: the Stack still does not change.
    for (const object of model.objects as unknown as { name: string }[]) {
      object.name = 'direct';
    }
    (ai.inputObjectIds as string[]).push('y');
    expect(stack).toEqual(before);
  });

  it('does not modify a deeply frozen Stack and is deterministic', () => {
    const objects = [field('a', 'Alpha'), aiField('ai', ['a'])];
    const links: Link[] = [{ id: 'l1', label: 'Go', targetCardId: 'c2' }];
    const stack = deepFreeze(stackOf([card('c1', 'One', { objects, links }), card('c2', 'Two')]));

    expect(buildRenderModel(stack, 'c1')).toEqual(buildRenderModel(stack, 'c1'));
  });

  it('never throws on an invalid Stack and falls back to empty names', () => {
    const objects = [aiField('ai', ['gone'])];
    const links: Link[] = [{ id: 'l1', label: 'Lost', targetCardId: 'nowhere' }];
    const stack = stackOf([card('c1', 'One', { objects, links })]);

    const model = modelOf(stack, 'c1');

    expect((model.objects[0] as RenderAiField).inputs).toEqual([{ id: 'gone', name: '' }]);
    expect(model.links[0]?.targetCardName).toBe('');
  });

  describe('UNKNOWN_ENTITY (Requirement 11.11)', () => {
    const stack = stackOf([
      card('c1', 'One', {
        objects: [field('a', 'Alpha')],
        links: [{ id: 'l1', label: 'Go', targetCardId: 'c1' }],
      }),
    ]);

    it('rejects an unknown id at /cardId', () => {
      const result = buildRenderModel(stack, 'missing');
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ code: 'UNKNOWN_ENTITY', path: '/cardId' });
      expect(result.errors[0]?.hint).toContain('c1');
      expect(result).not.toHaveProperty('model');
    });

    it('rejects an Object id and a Link id at /cardId', () => {
      for (const id of ['a', 'l1']) {
        const result = buildRenderModel(stack, id);
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.errors[0]).toMatchObject({ code: 'UNKNOWN_ENTITY', path: '/cardId' });
      }
    });
  });
});

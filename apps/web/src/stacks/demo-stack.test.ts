import { describe, expect, it } from 'vitest';
import { StackSchema, OBJECT_TYPES, ACTION_TYPES, validateStack } from '@hypergeist/shared/format';
import type { Card, StackObject } from '@hypergeist/shared/format';
import demoText from './thin-slice-todo.json?raw';

const parsed = StackSchema.parse(JSON.parse(demoText));

function cardById(id: string): Card {
  const card = parsed.cards.find((c) => c.id === id);
  if (card === undefined) throw new Error(`card ${id} is missing from the Demo_Stack`);
  return card;
}

function objectById(card: Card, id: string): StackObject {
  const object = card.objects.find((o) => o.id === id);
  if (object === undefined) throw new Error(`object ${id} is missing from card ${card.id}`);
  return object;
}

describe('Demo_Stack', () => {
  it('is valid according to the Slice_Validator', () => {
    const result = validateStack(demoText);
    expect(result).toEqual({ valid: true, errors: [], truncated: false });
  });

  it('has 3 cards at 512 by 342 with the To-do card first and as start card', () => {
    expect(parsed.cardWidth).toBe(512);
    expect(parsed.cardHeight).toBe(342);
    expect(parsed.cards.map((c) => c.name)).toEqual(['To-do', 'About', 'Limits']);
    expect(parsed.startCardId).toBe(parsed.cards[0]?.id);
  });

  it('has empty onOpen handlers on every card', () => {
    for (const card of parsed.cards) expect(card.onOpen).toEqual([]);
  });

  it('holds a Field, an Add button and an empty List on the To-do card', () => {
    const todo = cardById('todo');
    expect(todo.objects.map((o) => o.type)).toEqual(['field', 'button', 'list']);

    const input = objectById(todo, 'todo-input');
    const list = objectById(todo, 'todo-list');
    if (input.type !== 'field' || list.type !== 'list') throw new Error('unexpected object types');
    expect(input.value).toBe('');
    expect(input.placeholder).not.toBe('');
    expect(list.items).toEqual([]);
  });

  it('gives the Add button the three actions in order', () => {
    const add = objectById(cardById('todo'), 'todo-add');
    if (add.type !== 'button') throw new Error('todo-add is not a button');
    expect(add.label).toBe('Add');
    expect(add.onClick).toEqual([
      { type: 'append_item', targetObjectId: 'todo-list', fromObjectId: 'todo-input' },
      { type: 'set_value', targetObjectId: 'todo-input', value: '' },
      { type: 'show_message', text: 'Item added.' },
    ]);
  });

  it('links the To-do card to About and About to Limits', () => {
    expect(cardById('todo').links.map((l) => l.targetCardId)).toEqual(['about']);
    expect(cardById('about').links.map((l) => l.targetCardId)).toEqual(['limits']);
    expect(cardById('limits').links).toEqual([]);
  });

  it('has go_to_card back buttons on About and Limits', () => {
    const aboutBack = objectById(cardById('about'), 'about-back');
    const limitsBack = objectById(cardById('limits'), 'limits-back');
    if (aboutBack.type !== 'button' || limitsBack.type !== 'button') throw new Error('not buttons');
    expect(aboutBack.onClick).toEqual([{ type: 'go_to_card', cardId: 'todo' }]);
    expect(limitsBack.onClick).toEqual([{ type: 'go_to_card', cardId: 'about' }]);
  });

  it('describes the stack in a read-only multi-line About field', () => {
    const about = objectById(cardById('about'), 'about-text');
    if (about.type !== 'field') throw new Error('about-text is not a field');
    expect(about.readOnly).toBe(true);
    expect(about.multiline).toBe(true);
    expect(about.value.trim()).not.toBe('');
  });

  it('states the limits in a read-only multi-line Limits field', () => {
    const limits = objectById(cardById('limits'), 'limits-text');
    if (limits.type !== 'field') throw new Error('limits-text is not a field');
    expect(limits.readOnly).toBe(true);
    expect(limits.multiline).toBe(true);
    const text = limits.value.toLowerCase();
    expect(text).not.toContain('reloading the page resets');
    expect(text).toContain('stored in this browser only');
    expect(text).toContain("clearing the browser's site data deletes them");
    expect(text).toContain('overwrite each other');
    expect(text).toContain('the last save wins');
    expect(text).toContain('lose the last second');
    expect(text).toContain('"saved" label');
    expect(text).toContain('the open card and the mode are not saved');
    expect(text).not.toContain('later release');
    expect(text).toContain('shared model or from recorded examples');
    expect(text).toContain('own key is kept only in memory');
    expect(text).toContain('the ai can be wrong');
    expect(text).toContain('every ai change can be undone with undo');
    expect(text).toContain('empty field appends an empty item');
  });

  it('states the AI field and reminder limits and no longer says they arrive later', () => {
    const limits = objectById(cardById('limits'), 'limits-text');
    if (limits.type !== 'field') throw new Error('limits-text is not a field');
    const text = limits.value.toLowerCase();
    expect(text).toContain('ai fields use the shared demo model or an example answer');
    expect(text).toContain('they can be wrong');
    expect(text).toContain('one run counts against the demo limit');
    expect(text).toContain('reminders fire only while hypergeist is open or installed');
    expect(text).toContain('a missed reminder is shown when you return');
    expect(text).not.toContain('arrive later');
    expect(text).not.toContain('arrives later');
    expect(text).not.toContain('not built yet');
  });

  it('uses only supported object and action types', () => {
    const actionTypes = new Set<string>();
    for (const card of parsed.cards) {
      for (const action of card.onOpen) actionTypes.add(action.type);
      for (const object of card.objects) {
        expect(OBJECT_TYPES).toContain(object.type);
        if (object.type === 'button') for (const a of object.onClick) actionTypes.add(a.type);
      }
    }
    for (const type of actionTypes) expect(ACTION_TYPES).toContain(type);
  });

  it('keeps every object at least 28px tall and inside the card', () => {
    for (const card of parsed.cards) {
      for (const o of card.objects) {
        expect(o.height).toBeGreaterThanOrEqual(28);
        expect(o.x + o.width).toBeLessThanOrEqual(parsed.cardWidth);
        expect(o.y + o.height).toBeLessThanOrEqual(parsed.cardHeight);
      }
    }
  });
});

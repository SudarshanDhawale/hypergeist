import { describe, expect, it } from 'vitest';
import type { Action, Handler } from '../format/index.ts';
import { actionReferences, pruneHandler } from './handler-prune.ts';

const goTo: Action = { type: 'go_to_card', cardId: 'card-2' };
const setValue: Action = { type: 'set_value', targetObjectId: 'obj-1', value: 'x' };
const setFrom: Action = { type: 'set_value', targetObjectId: 'obj-1', fromObjectId: 'obj-2' };
const append: Action = { type: 'append_item', targetObjectId: 'obj-3', item: 'a' };
const appendFrom: Action = { type: 'append_item', targetObjectId: 'obj-3', fromObjectId: 'obj-2' };
const removeItem: Action = { type: 'remove_item', targetObjectId: 'obj-3', index: 0 };
const message: Action = { type: 'show_message', text: 'hi' };
const runAi: Action = { type: 'run_ai_field', targetObjectId: 'obj-4' };
const news: Action = { type: 'fetch_news', targetObjectId: 'obj-5', topics: ['tech'] };
const transcribe: Action = { type: 'transcribe_audio', targetObjectId: 'obj-6' };
const notifyAt: Action = {
  type: 'schedule_notification',
  message: 'm',
  at: '2026-01-01T00:00:00Z',
};
const notifyFrom: Action = {
  type: 'schedule_notification',
  message: 'm',
  atFromObjectId: 'obj-7',
};

const only = (id: string) => (ref: string) => ref === id;

describe('actionReferences', () => {
  it.each([
    ['go_to_card', goTo, ['card-2']],
    ['set_value with a literal', setValue, ['obj-1']],
    ['set_value from an Object', setFrom, ['obj-1', 'obj-2']],
    ['append_item with a literal', append, ['obj-3']],
    ['append_item from an Object', appendFrom, ['obj-3', 'obj-2']],
    ['remove_item', removeItem, ['obj-3']],
    ['show_message', message, []],
    ['run_ai_field', runAi, ['obj-4']],
    ['fetch_news', news, ['obj-5']],
    ['transcribe_audio', transcribe, ['obj-6']],
    ['schedule_notification with a time', notifyAt, []],
    ['schedule_notification from an Object', notifyFrom, ['obj-7']],
  ] satisfies [string, Action, string[]][])('%s', (_name, action, expected) => {
    expect(actionReferences(action)).toEqual(expected);
  });
});

describe('pruneHandler', () => {
  it.each([
    ['cardId of go_to_card', goTo, 'card-2'],
    ['targetObjectId of set_value', setValue, 'obj-1'],
    ['fromObjectId of set_value', setFrom, 'obj-2'],
    ['targetObjectId of append_item', append, 'obj-3'],
    ['fromObjectId of append_item', appendFrom, 'obj-2'],
    ['targetObjectId of remove_item', removeItem, 'obj-3'],
    ['targetObjectId of run_ai_field', runAi, 'obj-4'],
    ['targetObjectId of fetch_news', news, 'obj-5'],
    ['targetObjectId of transcribe_audio', transcribe, 'obj-6'],
    ['atFromObjectId of schedule_notification', notifyFrom, 'obj-7'],
  ] satisfies [string, Action, string][])('drops an Action by %s', (_name, action, id) => {
    const handler: Handler = [message, action];
    const result = pruneHandler(handler, only(id));
    expect(result.handler).toEqual([message]);
    expect(result.removed).toBe(1);
  });

  it('keeps show_message and schedule_notification with a fixed time whatever is removed', () => {
    const handler: Handler = [message, notifyAt];
    const result = pruneHandler(handler, () => true);
    expect(result.handler).toBe(handler);
    expect(result.removed).toBe(0);
  });

  it('counts an Action with two removed references once', () => {
    const handler: Handler = [setFrom, message];
    const result = pruneHandler(handler, (id) => id === 'obj-1' || id === 'obj-2');
    expect(result.handler).toEqual([message]);
    expect(result.removed).toBe(1);
  });

  it('drops an Action when only one of its two references is removed', () => {
    const result = pruneHandler([appendFrom], only('obj-2'));
    expect(result.handler).toEqual([]);
    expect(result.removed).toBe(1);
  });

  it('preserves the order of the remaining Actions', () => {
    const handler: Handler = [message, goTo, runAi, setValue, goTo, notifyAt];
    const result = pruneHandler(handler, only('card-2'));
    expect(result.handler).toEqual([message, runAi, setValue, notifyAt]);
    expect(result.removed).toBe(2);
  });

  it('handles an empty Handler and returns the same reference', () => {
    const handler: Handler = [];
    const result = pruneHandler(handler, () => true);
    expect(result.handler).toBe(handler);
    expect(result.removed).toBe(0);
  });

  it('returns the same reference when nothing matches', () => {
    const handler: Handler = [goTo, setValue, message];
    const result = pruneHandler(handler, only('obj-99'));
    expect(result.handler).toBe(handler);
    expect(result.removed).toBe(0);
  });

  it('does not mutate a frozen input and returns a new array when it drops', () => {
    const handler: Handler = Object.freeze([goTo, message]) as unknown as Handler;
    const result = pruneHandler(handler, only('card-2'));
    expect(result.handler).not.toBe(handler);
    expect(handler).toEqual([goTo, message]);
  });
});

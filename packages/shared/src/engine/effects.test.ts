import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../test-support/freeze.ts';
import type { Action, Stack, StackObject } from '../format/index.ts';
import { effectFor } from './effects.ts';

const frame = { x: 0, y: 0, width: 100, height: 30 };

const objects: readonly StackObject[] = [
  { id: 'go', type: 'button', name: 'Go', ...frame, label: 'Go', onClick: [] },
  {
    id: 'notes',
    type: 'field',
    name: 'Notes',
    ...frame,
    value: 'buy milk',
    placeholder: '',
    multiline: false,
    readOnly: false,
  },
  {
    id: 'when',
    type: 'field',
    name: 'When',
    ...frame,
    value: '2026-12-01T09:00:00Z',
    placeholder: '',
    multiline: false,
    readOnly: false,
  },
  { id: 'todo', type: 'list', name: 'Todo', ...frame, items: ['a', 'b', 'c'], ordered: false },
  { id: 'empty', type: 'list', name: 'Empty', ...frame, items: [], ordered: false },
  {
    id: 'summary',
    type: 'ai-field',
    name: 'Summary',
    ...frame,
    prompt: 'Summarize these.',
    inputObjectIds: ['notes', 'todo'],
    value: '',
  },
  {
    id: 'bare',
    type: 'ai-field',
    name: 'Bare',
    ...frame,
    prompt: 'Say hi.',
    inputObjectIds: [],
    value: '',
  },
];

function stackOf(list: readonly StackObject[]): Stack {
  return {
    formatVersion: 1,
    id: 's',
    name: 'S',
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'c1',
    cards: [{ id: 'c1', name: 'One', objects: [...list], links: [], onOpen: [] }],
  };
}

const stack = stackOf(objects);

describe('effectFor: run_ai_field', () => {
  it('carries the prompt and the input texts in inputObjectIds order', () => {
    expect(effectFor(stack, { type: 'run_ai_field', targetObjectId: 'summary' }, 3)).toEqual({
      kind: 'run_ai_field',
      actionIndex: 3,
      targetObjectId: 'summary',
      prompt: 'Summarize these.',
      inputs: [
        { objectId: 'notes', name: 'Notes', text: 'buy milk' },
        { objectId: 'todo', name: 'Todo', text: 'a\nb\nc' },
      ],
    });
  });

  it('keeps the order of inputObjectIds when it is reversed', () => {
    const reversed = stackOf(
      objects.map((o) =>
        o.id === 'summary' && o.type === 'ai-field'
          ? { ...o, inputObjectIds: ['todo', 'notes'] }
          : o,
      ),
    );
    const effect = effectFor(reversed, { type: 'run_ai_field', targetObjectId: 'summary' }, 0);
    expect(effect?.kind === 'run_ai_field' && effect.inputs.map((i) => i.objectId)).toEqual([
      'todo',
      'notes',
    ]);
  });

  it('gives an empty inputs list when the ai-field has no inputs', () => {
    expect(effectFor(stack, { type: 'run_ai_field', targetObjectId: 'bare' }, 0)).toEqual({
      kind: 'run_ai_field',
      actionIndex: 0,
      targetObjectId: 'bare',
      prompt: 'Say hi.',
      inputs: [],
    });
  });

  it('joins the items of a List input with newlines, and gives an empty List as empty text', () => {
    const withEmptyInput = stackOf(
      objects.map((o) =>
        o.id === 'bare' && o.type === 'ai-field' ? { ...o, inputObjectIds: ['empty'] } : o,
      ),
    );
    const effect = effectFor(withEmptyInput, { type: 'run_ai_field', targetObjectId: 'bare' }, 0);
    expect(effect?.kind === 'run_ai_field' && effect.inputs).toEqual([
      { objectId: 'empty', name: 'Empty', text: '' },
    ]);
  });
});

describe('effectFor: fetch_news', () => {
  it('copies the topics', () => {
    const action: Action = { type: 'fetch_news', targetObjectId: 'todo', topics: ['sci', 'wx'] };
    const effect = effectFor(stack, action, 1);
    expect(effect).toEqual({
      kind: 'fetch_news',
      actionIndex: 1,
      targetObjectId: 'todo',
      topics: ['sci', 'wx'],
    });
    if (effect?.kind === 'fetch_news' && action.type === 'fetch_news') {
      expect(effect.topics).not.toBe(action.topics);
    }
  });
});

describe('effectFor: transcribe_audio', () => {
  it('carries only the target id', () => {
    expect(effectFor(stack, { type: 'transcribe_audio', targetObjectId: 'notes' }, 2)).toEqual({
      kind: 'transcribe_audio',
      actionIndex: 2,
      targetObjectId: 'notes',
    });
  });
});

describe('effectFor: schedule_notification', () => {
  it('uses the literal at and sets no atFromObjectId', () => {
    const effect = effectFor(
      stack,
      { type: 'schedule_notification', message: 'Stretch', at: '2026-12-02T10:00:00Z' },
      0,
    );
    expect(effect).toEqual({
      kind: 'schedule_notification',
      actionIndex: 0,
      message: 'Stretch',
      at: '2026-12-02T10:00:00Z',
    });
    expect(effect).not.toHaveProperty('atFromObjectId');
  });

  it('reads at from the Field text and records the Field id', () => {
    expect(
      effectFor(
        stack,
        { type: 'schedule_notification', message: 'Stand up', atFromObjectId: 'when' },
        4,
      ),
    ).toEqual({
      kind: 'schedule_notification',
      actionIndex: 4,
      message: 'Stand up',
      at: '2026-12-01T09:00:00Z',
      atFromObjectId: 'when',
    });
  });

  it('passes through Field text that is not a timestamp without judging it', () => {
    const effect = effectFor(
      stack,
      { type: 'schedule_notification', message: 'M', atFromObjectId: 'notes' },
      0,
    );
    expect(effect?.kind === 'schedule_notification' && effect.at).toBe('buy milk');
  });
});

describe('effectFor: other Actions and purity', () => {
  const others: readonly Action[] = [
    { type: 'go_to_card', cardId: 'c1' },
    { type: 'set_value', targetObjectId: 'notes', value: 'x' },
    { type: 'append_item', targetObjectId: 'todo', item: 'x' },
    { type: 'remove_item', targetObjectId: 'todo', index: 0 },
    { type: 'show_message', text: 'hi' },
  ];

  it.each(others)('gives undefined for $type', (action) => {
    expect(effectFor(stack, action, 0)).toBeUndefined();
  });

  it('produces JSON-safe effects and leaves a frozen Stack unchanged', () => {
    const frozen = deepFreeze(deepCopy(stack));
    const actions: readonly Action[] = [
      { type: 'run_ai_field', targetObjectId: 'summary' },
      { type: 'fetch_news', targetObjectId: 'todo', topics: ['a'] },
      { type: 'transcribe_audio', targetObjectId: 'notes' },
      { type: 'schedule_notification', message: 'M', atFromObjectId: 'when' },
    ];
    actions.forEach((action, index) => {
      const effect = effectFor(frozen, action, index);
      expect(effect).toBeDefined();
      expect(JSON.parse(JSON.stringify(effect))).toEqual(effect);
    });
    expect(frozen).toEqual(stack);
  });
});

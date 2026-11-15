import { describe, expect, it } from 'vitest';
import { deepCopy, deepFreeze } from '../../test-support/freeze.ts';
import { validateStack } from '../format/index.ts';
import type {
  Action,
  AiFieldObject,
  FieldObject,
  Handler,
  ListObject,
  Stack,
} from '../format/index.ts';
import { executeHandler } from './execute-handler.ts';
import { findObject } from './stack-edit.ts';

// Feature: stack-engine, task 4.3. Examples for the five Actions the executor gained in step 3.

const frame = { x: 0, y: 0, width: 100, height: 30 };

function field(id: string, value: string): FieldObject {
  return {
    id,
    type: 'field',
    name: id,
    ...frame,
    value,
    placeholder: '',
    multiline: false,
    readOnly: false,
  };
}

function list(id: string, name: string, items: readonly string[]): ListObject {
  return { id, type: 'list', name, ...frame, items: [...items], ordered: false };
}

function aiField(id: string, inputObjectIds: readonly string[]): AiFieldObject {
  return {
    id,
    type: 'ai-field',
    name: id,
    ...frame,
    prompt: `Prompt of ${id}`,
    inputObjectIds: [...inputObjectIds],
    value: 'old answer',
  };
}

function makeStack(): Stack {
  return {
    formatVersion: 1,
    id: 's',
    name: 'S',
    cardWidth: 512,
    cardHeight: 342,
    startCardId: 'c1',
    cards: [
      {
        id: 'c1',
        name: 'One',
        objects: [
          field('note', 'hello'),
          field('out', ''),
          field('when', '2030-05-06T07:08:09Z'),
          list('items', 'Items', ['a', 'b', 'c']),
          list('news', 'News', []),
          list('single', 'Single', ['only']),
          aiField('ask', ['note', 'items']),
          aiField('ask-empty', []),
        ],
        links: [],
        onOpen: [],
      },
      { id: 'c2', name: 'Two', objects: [], links: [], onOpen: [] },
    ],
  };
}

function itemsOf(stack: Stack, id: string): readonly string[] | undefined {
  const object = findObject(stack, id);
  return object?.type === 'list' ? object.items : undefined;
}

function textOfField(stack: Stack, id: string): string | undefined {
  const object = findObject(stack, id);
  return object?.type === 'field' ? object.value : undefined;
}

describe('executeHandler: remove_item examples', () => {
  it('removes the first item and shifts the rest down', () => {
    const result = executeHandler(makeStack(), [
      { type: 'remove_item', targetObjectId: 'items', index: 0 },
    ]);
    expect(itemsOf(result.stack, 'items')).toEqual(['b', 'c']);
    expect(result.messages).toEqual([]);
    expect(result.effects).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
  });

  it('removes a middle item and keeps the order of the others', () => {
    const result = executeHandler(makeStack(), [
      { type: 'remove_item', targetObjectId: 'items', index: 1 },
    ]);
    expect(itemsOf(result.stack, 'items')).toEqual(['a', 'c']);
    expect(result.messages).toEqual([]);
  });

  it('removes the last item', () => {
    const result = executeHandler(makeStack(), [
      { type: 'remove_item', targetObjectId: 'items', index: 2 },
    ]);
    expect(itemsOf(result.stack, 'items')).toEqual(['a', 'b']);
    expect(result.messages).toEqual([]);
  });

  it('removes the only item and leaves an empty List', () => {
    const result = executeHandler(makeStack(), [
      { type: 'remove_item', targetObjectId: 'single', index: 0 },
    ]);
    expect(itemsOf(result.stack, 'single')).toEqual([]);
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it('leaves the Stack equal and adds no message when index equals the item count', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [
      { type: 'remove_item', targetObjectId: 'items', index: 3 },
    ]);
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
    expect(result.effects).toEqual([]);
  });

  it('leaves an empty List unchanged and adds no message', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [
      { type: 'remove_item', targetObjectId: 'news', index: 0 },
    ]);
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
  });

  it('runs the Actions after an out-of-range remove_item', () => {
    const result = executeHandler(makeStack(), [
      { type: 'remove_item', targetObjectId: 'items', index: 99 },
      { type: 'show_message', text: 'next' },
    ]);
    expect(itemsOf(result.stack, 'items')).toEqual(['a', 'b', 'c']);
    expect(result.messages).toEqual(['next']);
  });

  it('treats a negative index as an invalid Handler: nothing runs and the Stack is returned as is', () => {
    const stack = makeStack();
    const handler: Handler = [
      { type: 'set_value', targetObjectId: 'out', value: 'ran' },
      { type: 'remove_item', targetObjectId: 'items', index: -1 },
    ];
    const result = executeHandler(stack, handler);
    expect(result.stack).toBe(stack);
    expect(textOfField(result.stack, 'out')).toBe('');
    expect(itemsOf(result.stack, 'items')).toEqual(['a', 'b', 'c']);
    expect(result.effects).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatch(/handler is not valid/i);
  });

  it('removes items in order when repeated, so later indexes see the shifted List', () => {
    const result = executeHandler(makeStack(), [
      { type: 'remove_item', targetObjectId: 'items', index: 2 },
      { type: 'remove_item', targetObjectId: 'items', index: 2 },
      { type: 'remove_item', targetObjectId: 'items', index: 0 },
    ]);
    expect(itemsOf(result.stack, 'items')).toEqual(['b']);
    expect(result.messages).toEqual([]);
  });
});

describe('executeHandler: run_ai_field examples', () => {
  it('emits one effect with the prompt and the input texts in inputObjectIds order', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [{ type: 'run_ai_field', targetObjectId: 'ask' }]);
    expect(result.effects).toEqual([
      {
        kind: 'run_ai_field',
        actionIndex: 0,
        targetObjectId: 'ask',
        prompt: 'Prompt of ask',
        inputs: [
          { objectId: 'note', name: 'note', text: 'hello' },
          { objectId: 'items', name: 'Items', text: 'a\nb\nc' },
        ],
      },
    ]);
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
  });

  it('emits an effect with an empty inputs array when the AI field has no inputs', () => {
    const result = executeHandler(makeStack(), [
      { type: 'run_ai_field', targetObjectId: 'ask-empty' },
    ]);
    expect(result.effects).toEqual([
      {
        kind: 'run_ai_field',
        actionIndex: 0,
        targetObjectId: 'ask-empty',
        prompt: 'Prompt of ask-empty',
        inputs: [],
      },
    ]);
  });

  it('resolves input texts from the Stack as changed by earlier Actions', () => {
    const result = executeHandler(makeStack(), [
      { type: 'set_value', targetObjectId: 'note', value: 'changed' },
      { type: 'append_item', targetObjectId: 'items', item: 'd' },
      { type: 'run_ai_field', targetObjectId: 'ask' },
    ]);
    expect(result.effects).toHaveLength(1);
    expect(result.effects[0]).toMatchObject({
      kind: 'run_ai_field',
      actionIndex: 2,
      inputs: [
        { objectId: 'note', text: 'changed' },
        { objectId: 'items', text: 'a\nb\nc\nd' },
      ],
    });
  });

  it('leaves the AI field value untouched', () => {
    const result = executeHandler(makeStack(), [{ type: 'run_ai_field', targetObjectId: 'ask' }]);
    const target = findObject(result.stack, 'ask');
    expect(target?.type === 'ai-field' ? target.value : undefined).toBe('old answer');
  });
});

describe('executeHandler: fetch_news, transcribe_audio and schedule_notification examples', () => {
  it('fetch_news emits its target and a copy of the topics in order', () => {
    const stack = makeStack();
    const topics = ['science', 'sport', 'art'];
    const result = executeHandler(stack, [{ type: 'fetch_news', targetObjectId: 'news', topics }]);
    expect(result.effects).toEqual([
      {
        kind: 'fetch_news',
        actionIndex: 0,
        targetObjectId: 'news',
        topics: ['science', 'sport', 'art'],
      },
    ]);
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
  });

  it('transcribe_audio emits only the target id', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [{ type: 'transcribe_audio', targetObjectId: 'out' }]);
    expect(result.effects).toEqual([
      { kind: 'transcribe_audio', actionIndex: 0, targetObjectId: 'out' },
    ]);
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
  });

  it('schedule_notification with a literal at emits the message and at, without atFromObjectId', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [
      { type: 'schedule_notification', message: 'Stand up', at: '2031-01-02T03:04:05Z' },
    ]);
    expect(result.effects).toEqual([
      {
        kind: 'schedule_notification',
        actionIndex: 0,
        message: 'Stand up',
        at: '2031-01-02T03:04:05Z',
      },
    ]);
    expect(result.effects[0]).not.toHaveProperty('atFromObjectId');
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
  });

  it('schedule_notification with atFromObjectId resolves at from the Field text', () => {
    const stack = makeStack();
    const result = executeHandler(stack, [
      { type: 'schedule_notification', message: 'Call', atFromObjectId: 'when' },
    ]);
    expect(result.effects).toEqual([
      {
        kind: 'schedule_notification',
        actionIndex: 0,
        message: 'Call',
        at: '2030-05-06T07:08:09Z',
        atFromObjectId: 'when',
      },
    ]);
    expect(result.stack).toEqual(stack);
  });

  it('effects are plain JSON data', () => {
    const result = executeHandler(makeStack(), [
      { type: 'run_ai_field', targetObjectId: 'ask' },
      { type: 'fetch_news', targetObjectId: 'news', topics: ['x'] },
      { type: 'transcribe_audio', targetObjectId: 'out' },
      { type: 'schedule_notification', message: 'm', atFromObjectId: 'when' },
    ]);
    expect(result.effects).toHaveLength(4);
    expect(JSON.parse(JSON.stringify(result.effects))).toEqual(result.effects);
  });
});

describe('executeHandler: mixed Handlers', () => {
  it('returns effects and messages each in execution order with matching actionIndex values', () => {
    const result = executeHandler(makeStack(), [
      { type: 'show_message', text: 'm0' },
      { type: 'run_ai_field', targetObjectId: 'ask' },
      { type: 'show_message', text: 'm2' },
      { type: 'fetch_news', targetObjectId: 'news', topics: ['t'] },
      { type: 'remove_item', targetObjectId: 'items', index: 0 },
      { type: 'transcribe_audio', targetObjectId: 'out' },
      { type: 'show_message', text: 'm6' },
      { type: 'schedule_notification', message: 'n', at: '2030-01-01T00:00:00Z' },
    ]);
    expect(result.messages).toEqual(['m0', 'm2', 'm6']);
    expect(result.effects.map((effect) => [effect.kind, effect.actionIndex])).toEqual([
      ['run_ai_field', 1],
      ['fetch_news', 3],
      ['transcribe_audio', 5],
      ['schedule_notification', 7],
    ]);
    expect(itemsOf(result.stack, 'items')).toEqual(['b', 'c']);
    expect(result).not.toHaveProperty('navigateTo');
    expect(validateStack(result.stack).valid).toBe(true);
  });

  it('go_to_card after an effect keeps that effect and its messages and drops later Actions', () => {
    const result = executeHandler(makeStack(), [
      { type: 'show_message', text: 'before' },
      { type: 'fetch_news', targetObjectId: 'news', topics: ['t'] },
      { type: 'go_to_card', cardId: 'c2' },
      { type: 'run_ai_field', targetObjectId: 'ask' },
      { type: 'transcribe_audio', targetObjectId: 'out' },
      { type: 'remove_item', targetObjectId: 'items', index: 0 },
      { type: 'show_message', text: 'after' },
    ]);
    expect(result.navigateTo).toBe('c2');
    expect(result.effects).toEqual([
      { kind: 'fetch_news', actionIndex: 1, targetObjectId: 'news', topics: ['t'] },
    ]);
    expect(result.messages).toEqual(['before']);
    expect(itemsOf(result.stack, 'items')).toEqual(['a', 'b', 'c']);
  });

  it('a Handler of zero Actions returns an equal Stack, no messages, no effects, and no navigateTo', () => {
    const stack = makeStack();
    const result = executeHandler(stack, []);
    expect(result.stack).toEqual(stack);
    expect(result.messages).toEqual([]);
    expect(result.effects).toEqual([]);
    expect(result).not.toHaveProperty('navigateTo');
  });

  it('does not modify a deeply frozen Stack or Handler', () => {
    const stack = deepFreeze(makeStack());
    const handler: Handler = deepFreeze([
      { type: 'remove_item', targetObjectId: 'items', index: 1 },
      { type: 'run_ai_field', targetObjectId: 'ask' },
      { type: 'fetch_news', targetObjectId: 'news', topics: ['a', 'b'] },
      { type: 'transcribe_audio', targetObjectId: 'out' },
      { type: 'schedule_notification', message: 'm', atFromObjectId: 'when' },
      { type: 'go_to_card', cardId: 'c2' },
    ] satisfies Action[]);
    const stackBefore = deepCopy(stack);
    const handlerBefore = deepCopy(handler);

    const result = executeHandler(stack, handler);

    expect(stack).toEqual(stackBefore);
    expect(handler).toEqual(handlerBefore);
    expect(result.stack).not.toBe(stack);
    expect(itemsOf(result.stack, 'items')).toEqual(['a', 'c']);
    expect(result.effects).toHaveLength(4);
    expect(result.navigateTo).toBe('c2');
    // The effect copies its topics, so it shares nothing with the frozen Handler.
    const news = result.effects.find((effect) => effect.kind === 'fetch_news');
    expect(news?.kind === 'fetch_news' ? Object.isFrozen(news.topics) : undefined).toBe(false);
  });
});

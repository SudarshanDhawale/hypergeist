import { describe, expect, it } from 'vitest';
import { validateStack, parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import thinSliceText from '../stacks/thin-slice-todo.json?raw';
import { providerError } from './errors.ts';
import { startNewStack } from './new-stack.ts';
import { MAX_LISTED_EXAMPLES, createRecordedProvider } from './recorded-provider.ts';
import { loadScenarios } from './scenario-set.ts';
import type { Scenario } from './scenario-set.ts';
import { runTurn } from './turn.ts';
import type { TurnResult } from './turn.ts';
import type { ChatRequest, OpenAiTool } from './types.ts';

const BUNDLED = loadScenarios().scenarios;

const NO_TOOLS: readonly OpenAiTool[] = [];

type RequestParts = {
  readonly round?: number;
  readonly currentCardId?: string | null;
  readonly selectedObjectId?: string | null;
  /** Pass `false` for a text completion request (no `tools`). */
  readonly withTools?: boolean;
};

function request(userMessage: string, parts: RequestParts = {}): ChatRequest {
  return {
    messages: [{ role: 'user', content: userMessage }],
    ...(parts.withTools === false ? {} : { tools: NO_TOOLS }),
    meta: {
      userMessage,
      round: parts.round ?? 0,
      currentCardId: parts.currentCardId === undefined ? 'card-1' : parts.currentCardId,
      selectedObjectId: parts.selectedObjectId ?? null,
    },
  };
}

function loadThinSlice(): Stack {
  const parsed = parseStack(JSON.parse(thinSliceText));
  if (!parsed.ok) throw new Error('the thin-slice stack must be valid');
  return parsed.value;
}

/** Builds one scenario object through the real loader so it is schema-checked. */
function makeScenario(over: Record<string, unknown>): Scenario {
  const set = loadScenarios({
    './x.json': JSON.stringify({
      id: 'x',
      title: 'X',
      prompts: ['do x'],
      mode: 'edit',
      replies: [{ content: 'ok' }],
      ...over,
    }),
  });
  const first = set.scenarios[0];
  if (first === undefined) throw new Error('the test scenario must be valid');
  return first;
}

async function reply(provider: ReturnType<typeof createRecordedProvider>, req: ChatRequest) {
  const result = await provider.chat(req);
  if (!result.ok) throw new Error(`expected an ok result, got ${result.error.code}`);
  return result.reply;
}

describe('createRecordedProvider: matching', () => {
  const provider = createRecordedProvider(BUNDLED);

  it('has kind recorded', () => {
    expect(provider.kind).toBe('recorded');
  });

  it('matches every listed prompt exactly', async () => {
    for (const prompt of ['Make me a to-do list', 'Make a to-do list', 'I need a to-do list']) {
      const r = await reply(provider, request(prompt));
      expect(r.noMatch).toBeUndefined();
      expect(r.toolCalls.length).toBeGreaterThan(0);
    }
  });

  it('ignores case, outer and inner white space, and trailing . ! ?', async () => {
    const plain = await reply(provider, request('Add a button'));
    for (const variant of [
      'add a button',
      '  ADD   A\tBUTTON  ',
      'Add a button.',
      'add a button?!',
    ]) {
      expect(await reply(provider, request(variant))).toEqual(plain);
    }
  });

  it('does not match fuzzily', async () => {
    for (const prompt of [
      'Add a button please',
      'Add button',
      'make me a todo list',
      'Add a buttons',
    ]) {
      expect((await reply(provider, request(prompt))).noMatch).toBe(true);
    }
  });
});

describe('createRecordedProvider: recorded replies', () => {
  const provider = createRecordedProvider(BUNDLED);

  it('serializes arguments to JSON text and numbers the ids rec-<round>-<n>', async () => {
    const r = await reply(provider, request('Make me a to-do list', { currentCardId: 'card-9' }));
    expect(r.finishReason).toBe('tool_calls');
    expect(r.toolCalls.map((c) => c.id)).toEqual(['rec-0-0', 'rec-0-1', 'rec-0-2', 'rec-0-3']);
    expect(r.toolCalls.map((c) => c.name)).toEqual([
      'create_stack',
      'add_object',
      'add_object',
      'add_object',
    ]);
    expect(JSON.parse(r.toolCalls[0]?.arguments ?? '')).toEqual({ name: 'To-do' });
  });

  it('selects the reply by meta.round and numbers ids with the round', async () => {
    const second = await reply(provider, request('Make me a to-do list', { round: 1 }));
    expect(second.toolCalls.map((c) => c.id)).toEqual(['rec-1-0']);
    expect(second.toolCalls[0]?.name).toBe('set_action');
    const third = await reply(provider, request('Make me a to-do list', { round: 2 }));
    expect(third.toolCalls).toEqual([]);
    expect(third.content).toContain('to-do list');
    expect(third.finishReason).toBe('stop');
  });

  it('answers a round past the end with an ok reply with no calls and no content', async () => {
    for (const round of [3, 4, 99, -1, 1.5]) {
      const r = await reply(provider, request('Make me a to-do list', { round }));
      expect(r).toEqual({ content: null, toolCalls: [], finishReason: 'stop' });
    }
  });

  it('substitutes {{currentCardId}} in the arguments', async () => {
    const r = await reply(provider, request('Add a button', { currentCardId: 'card-7' }));
    expect(JSON.parse(r.toolCalls[0]?.arguments ?? '')).toEqual({
      cardId: 'card-7',
      type: 'button',
      label: 'New button',
      x: 24,
      y: 24,
      width: 120,
      height: 32,
    });
  });

  it('substitutes both placeholders recursively, in every occurrence, and not in keys', async () => {
    const custom = makeScenario({
      replies: [
        {
          toolCalls: [
            {
              name: 'update_object',
              arguments: {
                '{{currentCardId}}': 'key stays',
                id: '{{selectedObjectId}}',
                nested: { list: ['{{currentCardId}}/{{selectedObjectId}}', 5, true, null] },
              },
            },
          ],
        },
      ],
    });
    const r = await reply(
      createRecordedProvider([custom]),
      request('do x', { currentCardId: 'c$&1', selectedObjectId: 'obj-2' }),
    );
    expect(JSON.parse(r.toolCalls[0]?.arguments ?? '')).toEqual({
      '{{currentCardId}}': 'key stays',
      id: 'obj-2',
      nested: { list: ['c$&1/obj-2', 5, true, null] },
    });
  });

  it('uses an empty string for an absent selected object or current card', async () => {
    const custom = makeScenario({
      replies: [
        {
          toolCalls: [
            {
              name: 'update_object',
              arguments: { id: '[{{selectedObjectId}}]', c: '{{currentCardId}}' },
            },
          ],
        },
      ],
    });
    const r = await reply(
      createRecordedProvider([custom]),
      request('do x', { currentCardId: null, selectedObjectId: null }),
    );
    expect(JSON.parse(r.toolCalls[0]?.arguments ?? '')).toEqual({ id: '[]', c: '' });
  });

  it('keeps content next to tool calls and reports finishReason tool_calls', async () => {
    const custom = makeScenario({
      replies: [{ content: 'Adding.', toolCalls: [{ name: 'say', arguments: { text: 'hi' } }] }],
    });
    const r = await reply(createRecordedProvider([custom]), request('do x'));
    expect(r.content).toBe('Adding.');
    expect(r.finishReason).toBe('tool_calls');
  });

  it('is deterministic and does not change the scenarios', async () => {
    const before = structuredClone(BUNDLED);
    const a = await reply(provider, request('Make me a to-do list', { currentCardId: 'c1' }));
    const b = await reply(
      createRecordedProvider(BUNDLED),
      request('Make me a to-do list', { currentCardId: 'c1' }),
    );
    expect(b).toEqual(a);
    expect(BUNDLED).toEqual(before);
  });
});

describe('createRecordedProvider: no match', () => {
  it('returns the plain text, noMatch true and no tool calls', async () => {
    const provider = createRecordedProvider(BUNDLED);
    const r = await reply(provider, request('Plan my wedding'));
    expect(r).toEqual({
      content:
        'In demo mode I can only do these examples: "Add a button", "Make me a to-do list". Add your own key in Settings to try anything else.',
      toolCalls: [],
      finishReason: 'stop',
      noMatch: true,
    });
  });

  it('is the same for any round and for an empty message', async () => {
    const provider = createRecordedProvider(BUNDLED);
    const a = await reply(provider, request('Plan my wedding'));
    expect(await reply(provider, request('Plan my wedding', { round: 3 }))).toEqual(a);
    expect(await reply(provider, request(''))).toEqual(a);
  });

  it('lists the first prompt of each new-stack or edit scenario, never text scenarios, at most 6', async () => {
    const many = Array.from({ length: 8 }, (_, i) =>
      makeScenario({
        id: `s${i}`,
        prompts: [`first ${i}`, `second ${i}`],
        mode: i === 2 ? 'text' : 'edit',
      }),
    );
    const r = await reply(createRecordedProvider(many), request('unknown'));
    const listed = [...(r.content ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(listed).toEqual(['first 0', 'first 1', 'first 3', 'first 4', 'first 5', 'first 6']);
    expect(listed).toHaveLength(MAX_LISTED_EXAMPLES);
  });

  it('says there are no examples when there are no scenarios', async () => {
    const r = await reply(createRecordedProvider([]), request('anything'));
    expect(r.noMatch).toBe(true);
    expect(r.content).toContain('no examples');
    expect(r.content).toContain('Add your own key in Settings');
  });

  it('is DEMO_ONLY for a request with no tools (text completion)', async () => {
    const provider = createRecordedProvider(BUNDLED);
    const result = await provider.chat(request('Summarize my notes', { withTools: false }));
    expect(result).toEqual({ ok: false, error: providerError('DEMO_ONLY') });
  });

  it('still answers a matched text-completion prompt without tools', async () => {
    const text = makeScenario({
      id: 'text-one',
      prompts: ['Write a greeting'],
      mode: 'text',
      replies: [{ content: 'Hello!' }],
    });
    const provider = createRecordedProvider([text]);
    const r = await reply(provider, request('write a greeting.', { withTools: false }));
    expect(r.content).toBe('Hello!');
    expect(r.noMatch).toBeUndefined();
  });
});

describe('createRecordedProvider: abort', () => {
  it('returns ABORTED for an already aborted signal, matched or not', async () => {
    const provider = createRecordedProvider(BUNDLED);
    const controller = new AbortController();
    controller.abort();
    for (const prompt of ['Add a button', 'Plan my wedding']) {
      const result = await provider.chat(request(prompt), controller.signal);
      expect(result).toEqual({ ok: false, error: providerError('ABORTED') });
    }
  });

  it('answers normally with a signal that is not aborted', async () => {
    const provider = createRecordedProvider(BUNDLED);
    const result = await provider.chat(request('Add a button'), new AbortController().signal);
    expect(result.ok).toBe(true);
  });
});

/* ---------- every scenario through the Turn loop ---------- */

/** A third scenario that needs no code: it adds a second button with a fixed id. */
const THIRD = {
  id: 'add-a-second-button',
  title: 'Add a button with an id',
  prompts: ['Add another button'],
  mode: 'edit',
  replies: [
    {
      toolCalls: [
        {
          name: 'add_object',
          arguments: {
            cardId: '{{currentCardId}}',
            type: 'button',
            id: 'extra-button',
            label: 'Extra',
            x: 40,
            y: 60,
            width: 90,
            height: 30,
          },
        },
      ],
    },
    { content: 'Added.' },
  ],
};

async function runScenario(scenario: Scenario, all: readonly Scenario[]) {
  const provider = createRecordedProvider(all);
  const userMessage = scenario.prompts[0] ?? '';
  if (scenario.mode === 'new-stack') {
    const start = startNewStack({ takenIds: [] });
    const result = await runTurn({
      provider,
      stack: start.stack,
      currentCardId: start.currentCardId,
      selectedObjectId: null,
      userMessage,
      history: [],
      newStack: true,
      jsonMode: false,
      clock: () => 0,
    });
    return { result, before: start.stack };
  }
  const before = loadThinSlice();
  const result = await runTurn({
    provider,
    stack: before,
    currentCardId: 'todo',
    selectedObjectId: null,
    userMessage,
    history: [],
    newStack: false,
    jsonMode: false,
    clock: () => 0,
  });
  return { result, before };
}

function objectIds(stack: Stack): string[] {
  return stack.cards.flatMap((card) => card.objects.map((object) => object.id));
}

function expectDoneAndValid(result: TurnResult): void {
  expect(result.status).toBe('done');
  expect(result.stopReason).toBe('finished');
  expect(result.steps.every((step) => step.ok)).toBe(true);
  expect(validateStack(result.after).valid).toBe(true);
  expect(result.providerKind).toBe('recorded');
}

describe('every new-stack and edit scenario runs through runTurn', () => {
  const third = loadScenarios({ './third.json': JSON.stringify(THIRD) }).scenarios;
  const all: readonly Scenario[] = [...BUNDLED, ...third];
  const cases = all.filter((s) => s.mode !== 'text');

  it('covers the two bundled scenarios and the injected third one', () => {
    expect(cases.map((c) => c.id).sort()).toEqual([
      'add-a-button',
      'add-a-second-button',
      'todo-from-a-sentence',
    ]);
  });

  for (const scenario of cases) {
    it(`${scenario.id}: ends done with a valid stack that has changed, for each of its prompts`, async () => {
      for (const prompt of scenario.prompts) {
        const { result, before } = await runScenario({ ...scenario, prompts: [prompt] }, all);
        expectDoneAndValid(result);
        expect(result.after).not.toEqual(before);
        expect(result.say.length).toBeGreaterThan(0);
        expect(result.rounds).toBe(scenario.replies.length);
      }
    });
  }

  it('todo-from-a-sentence builds the named stack with a working Add button', async () => {
    const todo = BUNDLED.find((s) => s.id === 'todo-from-a-sentence');
    if (todo === undefined) throw new Error('the bundled scenario is missing');
    const { result } = await runScenario(todo, BUNDLED);
    expectDoneAndValid(result);
    expect(result.before).toBeNull();
    expect(result.after.name).toBe('To-do');
    expect(objectIds(result.after)).toEqual(['todo-new', 'todo-items', 'todo-add']);
    const card = result.after.cards[0];
    expect(card?.objects.find((o) => o.id === 'todo-new')).toMatchObject({
      type: 'field',
      name: 'New item',
      x: 24,
      y: 24,
      width: 320,
      height: 32,
      placeholder: 'What needs doing?',
    });
    expect(card?.objects.find((o) => o.id === 'todo-items')).toMatchObject({
      type: 'list',
      name: 'To-do items',
      x: 24,
      y: 72,
      width: 464,
      height: 220,
    });
    expect(card?.objects.find((o) => o.id === 'todo-add')).toMatchObject({
      type: 'button',
      label: 'Add',
      x: 360,
      y: 24,
      width: 100,
      height: 32,
      onClick: [
        { type: 'append_item', targetObjectId: 'todo-items', fromObjectId: 'todo-new' },
        { type: 'set_value', targetObjectId: 'todo-new', value: '' },
      ],
    });
    expect(result.say).toEqual([
      'I made a to-do list with a field, a list and an Add button. Type a task and press Add.',
    ]);
  });

  it('add-a-button adds one button with an engine-assigned id to the current card', async () => {
    const edit = BUNDLED.find((s) => s.id === 'add-a-button');
    if (edit === undefined) throw new Error('the bundled scenario is missing');
    const { result, before } = await runScenario(edit, BUNDLED);
    expectDoneAndValid(result);
    expect(result.before).toEqual(before);
    const oldIds = objectIds(before);
    const added = result.after.cards
      .find((card) => card.id === 'todo')
      ?.objects.filter((object) => !oldIds.includes(object.id));
    expect(added).toHaveLength(1);
    expect(added?.[0]).toMatchObject({
      type: 'button',
      label: 'New button',
      width: 120,
      height: 32,
    });
    expect(objectIds(result.after)).toHaveLength(oldIds.length + 1);
    expect(result.say).toEqual(['I added a button.']);
  });

  it('a third scenario injected through files works with no code change', async () => {
    expect(third).toHaveLength(1);
    const provider = createRecordedProvider(all);
    const result = await provider.chat(request('add another button!', { currentCardId: 'todo' }));
    expect(result.ok && result.reply.toolCalls[0]?.name).toBe('add_object');
    const extra = third[0];
    if (extra === undefined) throw new Error('the injected scenario is missing');
    const { result: turn } = await runScenario(extra, all);
    expectDoneAndValid(turn);
    expect(objectIds(turn.after)).toContain('extra-button');
  });

  it('an unmatched prompt ends done with the no-match text and an unchanged stack', async () => {
    const before = loadThinSlice();
    const result = await runTurn({
      provider: createRecordedProvider(all),
      stack: before,
      currentCardId: 'todo',
      selectedObjectId: null,
      userMessage: 'Plan my wedding',
      history: [],
      newStack: false,
      jsonMode: false,
      clock: () => 0,
    });
    expect(result.status).toBe('done');
    expect(result.after).toEqual(before);
    expect(result.steps).toEqual([]);
    expect(result.say[0]).toContain('In demo mode I can only do these examples');
  });
});

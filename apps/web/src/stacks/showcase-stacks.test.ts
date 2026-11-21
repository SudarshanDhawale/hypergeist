import { describe, expect, it } from 'vitest';
import { parseStack, validateStack } from '@hypergeist/shared/format';
import type { Action, Stack, StackObject } from '@hypergeist/shared/format';
import {
  createKeyHolder,
  createRecordedProvider,
  loadScenarios,
  normalizePrompt,
} from '../ai/index.ts';
import type { Provider } from '../ai/index.ts';
import { createScriptedProvider, providerFailure, reply } from '../ai/testing/scripted-provider.ts';
import { loadSeedSet } from '../persistence/seed-set.ts';
import { createMemoryReminderRepository } from '../reminders/memory-reminder-repository.ts';
import { PAST_MESSAGE } from '../reminders/reminder-logic.ts';
import { DUE_TIME_FORMAT_MESSAGE } from '../reminders/due-time.ts';
import { createAiStore } from '../state/ai-store.ts';
import { createEffectsRuntime } from '../state/effects-runtime.ts';
import { createEffectsStore } from '../state/effects-store.ts';
import { createStackStore } from '../state/stack-store.ts';
import smartTodoText from './smart-todo.json?raw';
import studyDeckText from './study-deck.json?raw';
import thinSliceText from './thin-slice-todo.json?raw';

/* ---------- helpers ---------- */

function parse(text: string): Stack {
  const parsed = parseStack(text);
  if (!parsed.ok) throw new Error('A bundled showcase stack is not valid.');
  return parsed.value;
}

const smartTodo = parse(smartTodoText);
const studyDeck = parse(studyDeckText);

function objectOf(stack: Stack, id: string): StackObject {
  const found = stack.cards.flatMap((card) => card.objects).find((object) => object.id === id);
  if (found === undefined) throw new Error(`Object ${id} is missing.`);
  return found;
}

function textOfObject(stack: Stack, id: string): string {
  const object = objectOf(stack, id);
  if (object.type === 'field' || object.type === 'ai-field') return object.value;
  throw new Error(`Object ${id} has no text.`);
}

function itemsOf(stack: Stack, id: string): readonly string[] {
  const object = objectOf(stack, id);
  if (object.type !== 'list') throw new Error(`Object ${id} is not a list.`);
  return object.items;
}

function handlerOf(stack: Stack, id: string): readonly Action[] {
  const object = objectOf(stack, id);
  if (object.type !== 'button') throw new Error(`Object ${id} is not a button.`);
  return object.onClick;
}

/** Lets promise callbacks run. The fakes only use microtasks. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

const NOW = new Date(2026, 10, 18, 9, 0, 0).getTime();

function isoLocal(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The store and runtime of one open stack, with a fixed clock and a reminder repository in memory. */
function open(stack: Stack, chain: readonly Provider[]) {
  const stackStore = createStackStore(stack);
  const effectsStore = createEffectsStore();
  let nextId = 1;
  const runtime = createEffectsRuntime({
    stackStore,
    effectsStore,
    aiStore: createAiStore(),
    keyHolder: createKeyHolder(),
    scenarios: loadScenarios().scenarios,
    fetch: (() => Promise.reject(new Error('No network in this test.'))) as typeof fetch,
    reminderRepo: createMemoryReminderRepository(),
    now: () => NOW,
    // Timers never run: nothing in these tests waits for a reminder to fire.
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    refreshQuota: () => Promise.resolve(),
    makeId: () => nextId++,
    chooseChain: () => ({ ok: true, chain, label: 'demo' }),
  });
  stackStore.getState().attachEffects(runtime.handle);
  return { stackStore, effectsStore, runtime };
}

function recordedChain(): readonly Provider[] {
  return [createRecordedProvider(loadScenarios().scenarios)];
}

const WHEN_GUESS_TEXT = 'Type a time like 2026-12-01T09:00 in the "When" box.';

/* ---------- the stacks ---------- */

describe('the bundled showcase stacks', () => {
  it('parse and validate', () => {
    for (const text of [smartTodoText, studyDeckText]) {
      expect(parseStack(text).ok).toBe(true);
    }
    expect(validateStack(smartTodo).valid).toBe(true);
    expect(validateStack(studyDeck).valid).toBe(true);
  });

  it('have the ids and names of the design, and fit the card', () => {
    expect([smartTodo.id, smartTodo.name]).toEqual(['smart-todo', 'Smart To-Do with Reminders']);
    expect([studyDeck.id, studyDeck.name]).toEqual(['study-deck', 'Study Deck']);
    for (const stack of [smartTodo, studyDeck]) {
      expect([stack.cardWidth, stack.cardHeight]).toEqual([512, 342]);
      for (const card of stack.cards) {
        for (const object of card.objects) {
          expect(object.height).toBeGreaterThanOrEqual(28);
          expect(object.x + object.width).toBeLessThanOrEqual(stack.cardWidth);
          expect(object.y + object.height).toBeLessThanOrEqual(stack.cardHeight);
        }
      }
    }
  });

  it('are seeded as bundled files next to the thin-slice stack, which is unchanged', () => {
    const seeds = loadSeedSet();
    expect(seeds.problems).toEqual([]);
    const ids = seeds.stacks.map((seed) => seed.stack.id);
    expect(ids).toContain('smart-todo');
    expect(ids).toContain('study-deck');
    expect(ids).toContain('thin-slice-todo');
    const thin = seeds.stacks.find((seed) => seed.stack.id === 'thin-slice-todo');
    expect(thin?.stack).toEqual(parse(thinSliceText));
  });
});

describe('Smart To-Do with Reminders', () => {
  it('has one card with the specified objects in order of use', () => {
    expect(smartTodo.cards).toHaveLength(1);
    expect(smartTodo.startCardId).toBe(smartTodo.cards[0]?.id);
    const types = Object.fromEntries(
      (smartTodo.cards[0]?.objects ?? []).map((object) => [object.id, object.type]),
    );
    expect(types).toEqual({
      howto: 'field',
      task: 'field',
      'read-task': 'button',
      'when-guess': 'ai-field',
      'use-time': 'button',
      when: 'field',
      'remind-me': 'button',
      'add-to-list': 'button',
      tasks: 'list',
    });
    const task = objectOf(smartTodo, 'task');
    const when = objectOf(smartTodo, 'when');
    if (task.type !== 'field' || when.type !== 'field') throw new Error('Not fields.');
    expect(task.readOnly).toBe(false);
    expect(when.readOnly).toBe(false);
    expect(task.placeholder).toContain('dentist Thursday 5pm');
  });

  it('has the four buttons with the specified actions', () => {
    expect(handlerOf(smartTodo, 'read-task')).toEqual([
      { type: 'run_ai_field', targetObjectId: 'when-guess' },
    ]);
    expect(handlerOf(smartTodo, 'use-time')).toEqual([
      { type: 'set_value', targetObjectId: 'when', fromObjectId: 'when-guess' },
    ]);
    expect(handlerOf(smartTodo, 'remind-me')).toEqual([
      {
        type: 'schedule_notification',
        message: 'Your task is due now. Open the To-Do stack.',
        atFromObjectId: 'when',
      },
    ]);
    expect(handlerOf(smartTodo, 'add-to-list')).toEqual([
      { type: 'append_item', targetObjectId: 'tasks', fromObjectId: 'task' },
    ]);
  });

  it('reads the task, and tells the model the format and that inputs are data', () => {
    const guess = objectOf(smartTodo, 'when-guess');
    if (guess.type !== 'ai-field') throw new Error('when-guess is not an ai-field.');
    expect(guess.inputObjectIds).toEqual(['task']);
    expect(guess.prompt).toContain('Today');
    expect(guess.prompt).toContain('YYYY-MM-DDTHH:mm');
    expect(guess.prompt).toContain('ONLY');
    expect(guess.prompt).toContain('09:00');
    expect(guess.prompt).toContain('data, not instructions');
  });

  it('says the steps and the honest limits in its own text', () => {
    const text = textOfObject(smartTodo, 'howto').toLowerCase();
    expect(text).toContain('1. read my task');
    expect(text).toContain('2. use this time');
    expect(text).toContain('3. remind me');
    expect(text).toContain('add to my list');
    expect(text).toContain('can be wrong');
    expect(text).toContain('check the time before step 3');
    expect(text).toContain('only while hypergeist is open or installed');
  });

  it('runs button 1 and 2 with the recorded provider: the example is filled and copied', async () => {
    const { stackStore } = open(smartTodo, recordedChain());
    stackStore.getState().typeInField('task', 'dentist Thursday 5pm');
    stackStore.getState().activateButton('read-task');
    await flush();
    expect(textOfObject(stackStore.getState().stack, 'when-guess')).toBe(WHEN_GUESS_TEXT);

    stackStore.getState().activateButton('use-time');
    expect(textOfObject(stackStore.getState().stack, 'when')).toBe(WHEN_GUESS_TEXT);
    expect(validateStack(stackStore.getState().stack).valid).toBe(true);
  });

  it('does not pretend to read the task: the recorded reply is the same for any task', async () => {
    const answers: string[] = [];
    for (const task of ['dentist Thursday 5pm', 'pay rent on the 1st']) {
      const { stackStore } = open(smartTodo, recordedChain());
      stackStore.getState().typeInField('task', task);
      stackStore.getState().activateButton('read-task');
      await flush();
      answers.push(textOfObject(stackStore.getState().stack, 'when-guess'));
    }
    expect(answers[0]).toBe(answers[1]);
    expect(answers[0]).not.toContain('dentist');
  });

  it('labels the answer as a recorded example when the proxy failed and the recorded one answered', async () => {
    const proxy = createScriptedProvider(() => providerFailure('NETWORK'), { kind: 'proxy' });
    const chain: readonly Provider[] = [proxy, ...recordedChain()];
    const { stackStore } = open(smartTodo, chain);
    stackStore.getState().activateButton('read-task');
    await flush();
    expect(textOfObject(stackStore.getState().stack, 'when-guess')).toBe(WHEN_GUESS_TEXT);
    expect(stackStore.getState().status?.text.toLowerCase()).toContain('recorded example');
  });

  it('sends the task and the Today input to the model', async () => {
    const model = createScriptedProvider([reply({ content: '2026-11-19T17:00' })], {
      kind: 'direct',
    });
    const { stackStore } = open(smartTodo, [model]);
    stackStore.getState().typeInField('task', 'dentist Thursday 5pm');
    stackStore.getState().activateButton('read-task');
    await flush();
    expect(textOfObject(stackStore.getState().stack, 'when-guess')).toBe('2026-11-19T17:00');
    const sent = JSON.parse(model.requests[0]?.messages[1]?.content ?? '{}') as {
      inputs: { name: string; text: string }[];
    };
    expect(sent.inputs.map((input) => input.name)).toEqual(['Task', 'Today']);
    expect(sent.inputs[0]?.text).toBe('dentist Thursday 5pm');
  });

  it('stores a reminder and leaves the list unchanged when a future time is typed', async () => {
    const { stackStore, effectsStore } = open(smartTodo, recordedChain());
    const due = NOW + 2 * 60 * 60 * 1000;
    stackStore.getState().typeInField('task', 'dentist Thursday 5pm');
    stackStore.getState().typeInField('when', isoLocal(due));
    stackStore.getState().activateButton('remind-me');
    await flush();

    const reminders = effectsStore.getState().reminders;
    expect(reminders).toHaveLength(1);
    expect(reminders[0]).toMatchObject({
      stackId: 'smart-todo',
      message: 'Your task is due now. Open the To-Do stack.',
      dueAt: due,
      state: 'pending',
    });
    expect(itemsOf(stackStore.getState().stack, 'tasks')).toEqual([]);
    expect(stackStore.getState().status?.text).toContain('Reminder set for');
    expect(stackStore.getState().status?.text).toContain('open or installed');
    expect(validateStack(stackStore.getState().stack).valid).toBe(true);
  });

  it('rejects a past time and leaves the list unchanged', async () => {
    const { stackStore, effectsStore } = open(smartTodo, recordedChain());
    stackStore.getState().typeInField('task', 'dentist Thursday 5pm');
    stackStore.getState().typeInField('when', isoLocal(NOW - 60 * 60 * 1000));
    stackStore.getState().activateButton('remind-me');
    await flush();

    expect(stackStore.getState().status?.text).toContain(PAST_MESSAGE);
    expect(effectsStore.getState().reminders).toEqual([]);
    expect(itemsOf(stackStore.getState().stack, 'tasks')).toEqual([]);
  });

  it('rejects the recorded demo text as a time and leaves the list unchanged', async () => {
    const { stackStore, effectsStore } = open(smartTodo, recordedChain());
    stackStore.getState().typeInField('task', 'dentist Thursday 5pm');
    stackStore.getState().activateButton('read-task');
    await flush();
    stackStore.getState().activateButton('use-time');
    stackStore.getState().activateButton('remind-me');
    await flush();

    expect(stackStore.getState().status?.text).toBe(DUE_TIME_FORMAT_MESSAGE);
    expect(effectsStore.getState().reminders).toEqual([]);
    expect(itemsOf(stackStore.getState().stack, 'tasks')).toEqual([]);
  });

  it('never changes the list when button 3 is pressed twice, and sets two reminders', async () => {
    const { stackStore, effectsStore } = open(smartTodo, recordedChain());
    stackStore.getState().typeInField('task', 'dentist Thursday 5pm');
    stackStore.getState().typeInField('when', isoLocal(NOW + 60 * 60 * 1000));
    stackStore.getState().activateButton('remind-me');
    stackStore.getState().activateButton('remind-me');
    await flush();
    expect(itemsOf(stackStore.getState().stack, 'tasks')).toEqual([]);
    expect(effectsStore.getState().reminders).toHaveLength(2);
  });

  it('appends the task when "Add to my list" is pressed, without a time or a reminder', async () => {
    const { stackStore, effectsStore } = open(smartTodo, recordedChain());
    stackStore.getState().typeInField('task', 'dentist Thursday 5pm');
    stackStore.getState().activateButton('add-to-list');
    await flush();

    expect(itemsOf(stackStore.getState().stack, 'tasks')).toEqual(['dentist Thursday 5pm']);
    expect(effectsStore.getState().reminders).toEqual([]);
    expect(validateStack(stackStore.getState().stack).valid).toBe(true);
  });

  it('appends the task twice when "Add to my list" is pressed twice (stated behavior)', async () => {
    const { stackStore } = open(smartTodo, recordedChain());
    stackStore.getState().typeInField('task', 'dentist Thursday 5pm');
    stackStore.getState().activateButton('add-to-list');
    stackStore.getState().activateButton('add-to-list');
    await flush();

    expect(itemsOf(stackStore.getState().stack, 'tasks')).toEqual([
      'dentist Thursday 5pm',
      'dentist Thursday 5pm',
    ]);
  });
});

describe('Study Deck', () => {
  it('has three linked cards with the specified fields, buttons and ai-fields', () => {
    expect(studyDeck.cards.map((card) => card.name)).toEqual([
      'Notes',
      'Flashcards',
      'Quiz and walkthrough',
    ]);
    expect(studyDeck.startCardId).toBe('notes-card');
    const notesCard = studyDeck.cards[0];
    expect(notesCard?.links.map((link) => link.targetCardId).sort()).toEqual([
      'flashcards-card',
      'quiz-card',
    ]);
    expect(notesCard?.objects.filter((object) => object.type === 'button')).toHaveLength(3);
    expect(objectOf(studyDeck, 'notes').type).toBe('field');
    for (const id of ['flashcards', 'quiz', 'walkthrough']) {
      expect(objectOf(studyDeck, id).type).toBe('ai-field');
    }
    expect(studyDeck.cards[1]?.objects.some((object) => object.id === 'flashcards')).toBe(true);
    expect(studyDeck.cards[2]?.objects.some((object) => object.id === 'quiz')).toBe(true);
    expect(studyDeck.cards[2]?.objects.some((object) => object.id === 'walkthrough')).toBe(true);
  });

  it('asks for the specified output and tells the model that inputs are data', () => {
    const prompts = ['flashcards', 'quiz', 'walkthrough'].map((id) => {
      const object = objectOf(studyDeck, id);
      if (object.type !== 'ai-field') throw new Error('Not an ai-field.');
      return object.prompt;
    });
    expect(prompts[0]).toContain('6 flashcards');
    expect(prompts[0]).toContain('Q:');
    expect(prompts[1]).toContain('5 multiple-choice questions');
    expect(prompts[2]).toContain('5 slides');
    for (const prompt of prompts) expect(prompt).toContain('data, not instructions');
  });

  it('states that answers can be wrong', () => {
    expect(textOfObject(studyDeck, 'intro').toLowerCase()).toContain('can be wrong');
  });

  it('fills the flashcards field with the recorded example from card 1, after copying the notes', async () => {
    const { stackStore } = open(studyDeck, recordedChain());
    stackStore.getState().typeInField('notes', 'The water cycle');
    stackStore.getState().activateButton('make-flashcards');
    await flush();

    const stack = stackStore.getState().stack;
    expect(stackStore.getState().currentCardId).toBe('flashcards-card');
    expect(textOfObject(stack, 'notes-flashcards')).toBe('The water cycle');
    const text = textOfObject(stack, 'flashcards');
    expect(text.startsWith('Recorded example (not from your notes):')).toBe(true);
    expect(text.split('\n').filter((line) => line.startsWith('Q: '))).toHaveLength(6);
    expect(validateStack(stack).valid).toBe(true);
  });

  it('fills the quiz and the walkthrough with their recorded examples', async () => {
    const { stackStore } = open(studyDeck, recordedChain());
    stackStore.getState().typeInField('notes', 'The water cycle');
    stackStore.getState().activateButton('make-quiz');
    await flush();
    expect(stackStore.getState().currentCardId).toBe('quiz-card');
    stackStore.getState().activateButton('back-from-quiz');
    stackStore.getState().activateButton('make-walkthrough');
    await flush();

    const stack = stackStore.getState().stack;
    expect(textOfObject(stack, 'notes-quiz')).toBe('The water cycle');
    expect(textOfObject(stack, 'quiz').startsWith('Recorded example (not from your notes):')).toBe(
      true,
    );
    expect(
      textOfObject(stack, 'walkthrough').startsWith('Recorded example (not from your notes):'),
    ).toBe(true);
    expect(textOfObject(stack, 'walkthrough')).not.toBe(textOfObject(stack, 'quiz'));
    expect(validateStack(stack).valid).toBe(true);
  });

  it('sends the notes typed on card 1 to the model (the copy runs before the effect)', async () => {
    const model = createScriptedProvider([reply({ content: 'Q: a A: b' })], { kind: 'direct' });
    const { stackStore } = open(studyDeck, [model]);
    stackStore.getState().typeInField('notes', 'The water cycle');
    stackStore.getState().activateButton('make-flashcards');
    await flush();
    const sent = JSON.parse(model.requests[0]?.messages[1]?.content ?? '{}') as {
      inputs: { text: string }[];
    };
    expect(sent.inputs[0]?.text).toBe('The water cycle');
  });
});

describe('recorded answers for the ai-fields of every bundled stack', () => {
  const { scenarios, problems } = loadScenarios();
  const byPrompt = new Map<string, (typeof scenarios)[number]>();
  for (const scenario of scenarios) {
    for (const prompt of scenario.prompts) byPrompt.set(normalizePrompt(prompt), scenario);
  }

  it('loads every scenario file without problems', () => {
    expect(problems).toEqual([]);
  });

  it('has a text scenario with one reply for every ai-field prompt of every bundled stack', () => {
    const seeds = loadSeedSet();
    const prompts: string[] = [];
    for (const seed of seeds.stacks) {
      for (const card of seed.stack.cards) {
        for (const object of card.objects) {
          if (object.type === 'ai-field') prompts.push(object.prompt);
        }
      }
    }
    expect(prompts.length).toBeGreaterThanOrEqual(4);
    for (const prompt of prompts) {
      const scenario = byPrompt.get(normalizePrompt(prompt));
      expect(scenario, `no scenario for the prompt: ${prompt}`).toBeDefined();
      expect(scenario?.mode).toBe('text');
      expect(scenario?.replies).toHaveLength(1);
    }
  });

  it('never has a recorded reply that claims to read the input', () => {
    for (const id of [
      'study-deck-flashcards',
      'study-deck-quiz',
      'study-deck-walkthrough',
    ] as const) {
      const scenario = scenarios.find((candidate) => candidate.id === id);
      expect(
        scenario?.replies[0]?.content?.startsWith('Recorded example (not from your notes):'),
      ).toBe(true);
    }
    const guess = scenarios.find((candidate) => candidate.id === 'smart-todo-when-guess');
    expect(guess?.replies[0]?.content).toBe(WHEN_GUESS_TEXT);
  });
});

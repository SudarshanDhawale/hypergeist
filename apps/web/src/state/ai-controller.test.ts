import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseStack } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { createKeyHolder, createSettingsRepository, loadScenarios } from '../ai/index.ts';
import type { AiSettings, Provider } from '../ai/index.ts';
import {
  createScriptedProvider,
  providerFailure,
  reply,
  resetToolCallIds,
  toolCall,
} from '../ai/testing/scripted-provider.ts';
import type { Script } from '../ai/testing/scripted-provider.ts';
import demoText from '../stacks/thin-slice-todo.json?raw';
import { createAiController } from './ai-controller.ts';
import type { AiControllerDeps } from './ai-controller.ts';
import { createAiStore } from './ai-store.ts';
import { createStackStore } from './stack-store.ts';

const STACK: Stack = (() => {
  const parsed = parseStack(demoText);
  if (!parsed.ok) throw new Error('The bundled demo stack is not valid.');
  return parsed.value;
})();

const SCENARIOS = loadScenarios().scenarios;
const SECRET_KEY = 'sk-test-secret-0123456789';

type FetchHandler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: FetchHandler): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return Promise.resolve().then(() => handler(url, init));
  };
  return { fetch: impl as typeof fetch, urls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const QUOTA_OK = { dailyLimit: 10, dailyUsed: 4, visitorLimit: 5, visitorUsed: 1 };

/** A fetch that answers the quota route and fails the chat route like a Worker without a model. */
const demoFetch = (): ReturnType<typeof fakeFetch> =>
  fakeFetch((url) => (url === '/api/ai/quota' ? json(QUOTA_OK) : json({}, 503)));

function createCard(id: string) {
  return toolCall('create_card', { name: id, id });
}

type Setup = {
  readonly settings?: AiSettings;
  /** One provider for every Turn, or a function that makes one per Turn. */
  readonly provider?: Provider | (() => Provider);
  readonly fetch?: typeof fetch;
  readonly deps?: Partial<AiControllerDeps>;
};

function setup(options: Setup = {}) {
  const stackStore = createStackStore(STACK);
  const aiStore = createAiStore();
  if (options.settings !== undefined) aiStore.getState().setSettings(options.settings);
  const keyHolder = createKeyHolder();
  const factory = new IDBFactory();
  const dbName = 'test-settings';
  const settingsRepo = createSettingsRepository(factory, { name: dbName });
  const provider = options.provider;
  const controller = createAiController({
    stackStore,
    aiStore,
    settingsRepo,
    keyHolder,
    fetch: options.fetch ?? demoFetch().fetch,
    scenarios: SCENARIOS,
    now: () => 0,
    ...(provider === undefined
      ? {}
      : {
          chooseChain: () => ({
            ok: true as const,
            chain: [typeof provider === 'function' ? provider() : provider],
            label: 'own' as const,
          }),
        }),
    ...options.deps,
  });
  return { controller, stackStore, aiStore, keyHolder, settingsRepo, factory, dbName };
}

function texts(aiStore: ReturnType<typeof createAiStore>, kind: string): string[] {
  return aiStore
    .getState()
    .lines.filter((line) => line.kind === kind)
    .map((line) => line.text);
}

function cardIds(stack: Stack): string[] {
  return stack.cards.map((card) => card.id);
}

function scripted(script: Script) {
  return createScriptedProvider(script, { kind: 'direct' });
}

const OWN: AiSettings = { provider: 'own', baseUrl: 'https://api.example.com/v1', model: 'm' };

beforeEach(() => {
  resetToolCallIds();
});

describe('send', () => {
  it('replaces the stack, pushes an Undo entry and adds the lines on success', async () => {
    const { controller, stackStore, aiStore } = setup({
      provider: scripted([
        reply({ calls: [toolCall('say', { text: 'Adding it.' }), createCard('notes')] }),
        reply({ content: 'All set.' }),
      ]),
    });
    await controller.send('Add a notes card');

    expect(cardIds(stackStore.getState().stack)).toContain('notes');
    expect(stackStore.getState().stack).not.toBe(STACK);
    const state = aiStore.getState();
    expect(state.busy).toBe(false);
    const { past } = stackStore.getState();
    expect(past).toHaveLength(1);
    expect(past[0]?.stack).toBe(STACK);
    expect(past[0]?.source).toBe('ai');
    expect(texts(aiStore, 'user')).toEqual(['Add a notes card']);
    expect(texts(aiStore, 'ghost')).toContain('Adding it.');
    expect(texts(aiStore, 'step')).toEqual(['Created card "notes"']);
    expect(texts(aiStore, 'note')).toContain('Done.');
  });

  it('keeps the accepted steps when the Turn is partial, and says it is only partly done', async () => {
    const { controller, stackStore, aiStore } = setup({
      provider: scripted([
        reply({
          calls: [
            createCard('notes'),
            toolCall('remove_object', { id: 'does-not-exist' }),
            toolCall('remove_object', { id: 'does-not-exist-2' }),
          ],
        }),
        reply({ calls: [toolCall('remove_object', { id: 'nope' })] }),
        reply({ calls: [toolCall('remove_object', { id: 'nope-2' })] }),
        reply({ calls: [toolCall('remove_object', { id: 'nope-3' })] }),
      ]),
    });
    await controller.send('Do things');
    expect(cardIds(stackStore.getState().stack)).toContain('notes');
    expect(stackStore.getState().past).toHaveLength(1);
    const notes = texts(aiStore, 'note').join(' ');
    expect(notes).toContain('Partly done');
    expect(notes).not.toContain('Done.');
  });

  it('changes nothing and pushes no Undo entry when the Turn fails', async () => {
    const { controller, stackStore, aiStore } = setup({
      provider: scripted(() => providerFailure('AUTH')),
    });
    await controller.send('Add a notes card');
    expect(stackStore.getState().stack).toBe(STACK);
    expect(stackStore.getState().past).toEqual([]);
    expect(aiStore.getState().busy).toBe(false);
    expect(texts(aiStore, 'error')[0]).toContain('I could not do that.');
  });

  it('stops on request, keeps the accepted changes and says so', async () => {
    const provider = scripted((_request, round) =>
      round === 0
        ? reply({ calls: [createCard('notes')] })
        : new Promise(() => {
            // Never answers. The abort ends it.
          }),
    );
    const { controller, stackStore, aiStore } = setup({ provider });
    const running = controller.send('Add cards');
    for (let turn = 0; turn < 20 && provider.calls < 2; turn += 1) await Promise.resolve();
    expect(aiStore.getState().busy).toBe(true);
    controller.stop();
    await running;

    expect(aiStore.getState().busy).toBe(false);
    expect(cardIds(stackStore.getState().stack)).toContain('notes');
    expect(stackStore.getState().past).toHaveLength(1);
    expect(texts(aiStore, 'note').join(' ')).toContain('Stopped');
  });

  it('sends only the last 6 user and Ghost lines as history', async () => {
    const requests: string[] = [];
    const { controller } = setup({
      provider: () =>
        scripted((request) => {
          requests.push(JSON.stringify(request.messages));
          return reply({ calls: [toolCall('say', { text: 'g' })] });
        }),
    });
    for (const label of ['u-1', 'u-2', 'u-3', 'u-4', 'u-5', 'u-6']) {
      await controller.send(label);
    }
    // The first request of the sixth Turn.
    const sixth = requests.filter((text) => text.includes('u-6'))[0] ?? '';
    expect(sixth).toContain('u-5');
    expect(sixth).toContain('u-4');
    expect(sixth).toContain('u-3');
    expect(sixth).not.toContain('u-2');
    expect(sixth).not.toContain('u-1');
  });

  it('sends the selected object only in AI edit mode', async () => {
    const seen: (string | null)[] = [];
    const { controller, stackStore } = setup({
      provider: () =>
        scripted((request) => {
          seen.push(request.meta.selectedObjectId);
          return reply({ content: 'ok' });
        }),
    });
    const card = stackStore.getState().stack.cards.find((c) => c.id === 'todo');
    const object = card?.objects[0];
    if (object === undefined) throw new Error('the demo card has no object');
    stackStore.getState().setMode('edit');
    stackStore.getState().selectObject(object.id);
    await controller.send('one');
    stackStore.getState().setMode('ai-edit');
    stackStore.getState().selectObject(object.id);
    await controller.send('two');
    expect(seen).toEqual([null, object.id]);
  });

  it('with own settings missing says what is missing and never falls back to the demo', async () => {
    const { fetch, urls } = fakeFetch(() => json({}, 500));
    const { controller, aiStore, stackStore } = setup({
      settings: { provider: 'own', baseUrl: '', model: '' },
      fetch,
    });
    await controller.send('Add a button');
    expect(texts(aiStore, 'error')[0]).toContain('Enter a base URL');
    expect(urls).toEqual([]);
    expect(stackStore.getState().stack).toBe(STACK);
    expect(aiStore.getState().busy).toBe(false);
  });

  it('uses the recorded example and adds the demo note when the shared model is unreachable', async () => {
    const { fetch, urls } = demoFetch();
    const { controller, aiStore, stackStore } = setup({ fetch });
    await controller.send('Add a button');
    expect(urls).toContain('/api/ai/chat');
    expect(texts(aiStore, 'note').join(' ')).toContain('recorded example');
    expect(stackStore.getState().stack).not.toBe(STACK);
    expect(stackStore.getState().past).toHaveLength(1);
  });

  it('ignores a send while busy and an empty text', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = scripted(async () => {
      await gate;
      return reply({ content: 'ok' });
    });
    const { controller, aiStore } = setup({ provider });
    await controller.send('   ');
    expect(aiStore.getState().lines).toEqual([]);

    const first = controller.send('first');
    await controller.send('second');
    expect(texts(aiStore, 'user')).toEqual(['first']);
    release();
    await first;
    expect(provider.calls).toBe(1);
  });

  it('never throws when the provider throws', async () => {
    const throwing: Provider = {
      kind: 'direct',
      chat: () => {
        throw new Error('boom');
      },
    };
    const { controller, aiStore } = setup({ provider: throwing });
    await expect(controller.send('hi')).resolves.toBeUndefined();
    expect(aiStore.getState().busy).toBe(false);
    expect(texts(aiStore, 'error')).toHaveLength(1);
  });

  it('never throws when choosing the providers throws', async () => {
    const { controller, aiStore } = setup({
      deps: {
        chooseChain: () => {
          throw new Error('boom');
        },
      },
    });
    await expect(controller.send('hi')).resolves.toBeUndefined();
    expect(aiStore.getState().busy).toBe(false);
    expect(texts(aiStore, 'error')[0]).toContain('Nothing was changed');
  });

  it('does not apply the change when another stack was opened during the Turn', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = scripted(async (_request, round) => {
      await gate;
      return round === 0 ? reply({ calls: [createCard('notes')] }) : reply({ content: 'ok' });
    });
    const { controller, stackStore, aiStore } = setup({ provider });
    const running = controller.send('Add a card');
    const other: Stack = { ...STACK, id: 'other-stack' };
    stackStore.getState().replaceStack(other);
    release();
    await running;
    expect(stackStore.getState().stack).toBe(other);
    expect(stackStore.getState().past).toEqual([]);
    expect(texts(aiStore, 'error').join(' ')).toContain('another stack');
  });
});

describe('undo', () => {
  it('restores the stack before the Turn through the shared history and adds a note', async () => {
    const { controller, stackStore, aiStore } = setup({
      provider: scripted([reply({ calls: [createCard('notes')] }), reply({ content: 'ok' })]),
    });
    await controller.send('Add a card');
    controller.undo();
    expect(stackStore.getState().stack).toBe(STACK);
    expect(stackStore.getState().future).toHaveLength(1);
    expect(texts(aiStore, 'note').some((text) => text.startsWith('Undid'))).toBe(true);
    const notes = texts(aiStore, 'note').length;
    controller.undo();
    expect(stackStore.getState().stack).toBe(STACK);
    expect(texts(aiStore, 'note')).toHaveLength(notes + 1);
    expect(texts(aiStore, 'note').at(-1)).toContain('no Ghost change');
  });

  it('cannot undo the Turn after a manual edit, and leaves that edit alone', async () => {
    const { controller, stackStore, aiStore } = setup({
      provider: scripted([reply({ calls: [createCard('notes')] }), reply({ content: 'ok' })]),
    });
    await controller.send('Add a card');
    stackStore.getState().addCard();
    const edited = stackStore.getState().stack;
    controller.undo();
    expect(stackStore.getState().stack).toBe(edited);
    expect(stackStore.getState().past).toHaveLength(2);
    expect(texts(aiStore, 'note').at(-1)).toContain('no Ghost change');
  });

  it('adds a note and changes nothing when another stack was opened after the Turn', async () => {
    const { controller, stackStore, aiStore } = setup({
      provider: scripted([reply({ calls: [createCard('notes')] }), reply({ content: 'ok' })]),
    });
    await controller.send('Add a card');
    const other: Stack = { ...STACK, id: 'other-stack' };
    stackStore.getState().replaceStack(other);
    controller.undo();
    expect(stackStore.getState().stack).toBe(other);
    expect(texts(aiStore, 'note').at(-1)).toContain('no Ghost change');
  });

  it('keeps at most 50 entries of history across Turns', async () => {
    let next = 0;
    const { controller, stackStore } = setup({
      provider: () => {
        next += 1;
        return scripted([reply({ calls: [createCard(`card-${String(next)}`)] })]);
      },
    });
    for (let index = 0; index < 51; index += 1) await controller.send(`add ${String(index)}`);
    expect(stackStore.getState().past).toHaveLength(50);
  });

  it('does nothing while a Turn runs', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { controller, stackStore } = setup({
      provider: scripted(async () => {
        await gate;
        return reply({ content: 'ok' });
      }),
    });
    stackStore.getState().applyStack({ ...STACK, name: 'Earlier' }, 'ai');
    const running = controller.send('hi');
    controller.undo();
    expect(stackStore.getState().past).toHaveLength(1);
    release();
    await running;
  });
});

describe('makeStack', () => {
  it('returns the new stack for done and does not touch the open stack or the Undo list', async () => {
    const { controller, stackStore, aiStore } = setup({
      provider: scripted([
        reply({ calls: [toolCall('create_stack', { name: 'To-do' })] }),
        reply({ content: 'Made it.' }),
      ]),
    });
    const outcome = await controller.makeStack('Make a to-do list', { takenIds: ['my-stack'] });
    expect(outcome.result?.status).toBe('done');
    expect(outcome.stack?.name).toBe('To-do');
    expect(outcome.stack?.id).toBe('my-stack-2');
    expect(stackStore.getState().stack).toBe(STACK);
    expect(stackStore.getState().past).toEqual([]);
    expect(aiStore.getState().busyNewStack).toBe(false);
    expect(aiStore.getState().busy).toBe(false);
  });

  it('returns the stack for partial', async () => {
    const { controller } = setup({
      provider: scripted([
        reply({
          calls: [
            toolCall('create_stack', { name: 'To-do' }),
            toolCall('remove_object', { id: 'x' }),
            toolCall('remove_object', { id: 'y' }),
          ],
        }),
        reply({ calls: [toolCall('remove_object', { id: 'z' })] }),
        reply({ calls: [toolCall('remove_object', { id: 'w' })] }),
        reply({ calls: [toolCall('remove_object', { id: 'v' })] }),
      ]),
    });
    const outcome = await controller.makeStack('Make a to-do list', { takenIds: [] });
    expect(outcome.result?.status).toBe('partial');
    expect(outcome.stack).not.toBeNull();
  });

  it('returns null for failed, with a message', async () => {
    const { controller } = setup({ provider: scripted(() => providerFailure('SERVER')) });
    const outcome = await controller.makeStack('Make a to-do list', { takenIds: [] });
    expect(outcome.result?.status).toBe('failed');
    expect(outcome.stack).toBeNull();
    expect(outcome.message).toContain('I could not do that.');
  });

  it('returns null with the missing-settings message when no provider can be used', async () => {
    const { controller } = setup({ settings: { provider: 'own', baseUrl: '', model: '' } });
    const outcome = await controller.makeStack('Make a to-do list', { takenIds: [] });
    expect(outcome.result).toBeNull();
    expect(outcome.stack).toBeNull();
    expect(outcome.message).toContain('Enter a base URL');
  });

  it('does not block the chat while it runs, and stop aborts it', async () => {
    const provider = scripted(
      () =>
        new Promise(() => {
          // Never answers. The abort ends it.
        }),
    );
    const { controller, aiStore } = setup({ provider });
    const making = controller.makeStack('Make a to-do list', { takenIds: [] });
    for (let turn = 0; turn < 20 && provider.calls < 1; turn += 1) await Promise.resolve();
    expect(aiStore.getState().busyNewStack).toBe(true);
    expect(aiStore.getState().busy).toBe(false);
    controller.stop();
    const outcome = await making;
    expect(outcome.result?.status).toBe('aborted');
    expect(outcome.stack).toBeNull();
    expect(aiStore.getState().busyNewStack).toBe(false);
  });

  it('never throws when the provider throws', async () => {
    const throwing: Provider = {
      kind: 'direct',
      chat: () => {
        throw new Error('boom');
      },
    };
    const { controller, aiStore } = setup({ provider: throwing });
    const outcome = await controller.makeStack('Make a to-do list', { takenIds: [] });
    expect(outcome.stack).toBeNull();
    expect(aiStore.getState().busyNewStack).toBe(false);
  });
});

describe('refreshQuota', () => {
  it('shows the smaller of the daily and the visitor remainder', async () => {
    const { controller, aiStore } = setup();
    await controller.refreshQuota();
    expect(aiStore.getState().quota).toEqual({ remaining: 4 });
  });

  it('shows 0 and never a negative number', async () => {
    const { fetch } = fakeFetch(() =>
      json({ dailyLimit: 10, dailyUsed: 12, visitorLimit: 5, visitorUsed: 1 }),
    );
    const { controller, aiStore } = setup({ fetch });
    await controller.refreshQuota();
    expect(aiStore.getState().quota).toEqual({ remaining: 0 });
  });

  it('asks the same origin without credentials', async () => {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const { fetch } = fakeFetch((url, init) => {
      calls.push({ url, init });
      return json(QUOTA_OK);
    });
    const { controller } = setup({ fetch });
    await controller.refreshQuota();
    expect(calls[0]?.url).toBe('/api/ai/quota');
    expect(calls[0]?.init?.credentials).toBe('omit');
  });

  it('hides the counter for 403, a thrown fetch and malformed JSON', async () => {
    for (const handler of [
      () => json({ error: { code: 'FORBIDDEN_ORIGIN' } }, 403),
      () => {
        throw new Error('offline');
      },
      () => json({ dailyLimit: 'many' }),
      () => new Response('not json', { status: 200 }),
    ] as FetchHandler[]) {
      const { fetch } = fakeFetch(handler);
      const { controller, aiStore } = setup({ fetch });
      aiStore.getState().setQuota({ remaining: 9 });
      await controller.refreshQuota();
      expect(aiStore.getState().quota).toBeNull();
    }
  });

  it('is hidden and makes no call in own mode', async () => {
    const { fetch, urls } = demoFetch();
    const { controller, aiStore } = setup({ settings: OWN, fetch });
    aiStore.getState().setQuota({ remaining: 9 });
    await controller.refreshQuota();
    expect(aiStore.getState().quota).toBeNull();
    expect(urls).toEqual([]);
  });

  it('is refreshed after a Turn', async () => {
    const { fetch, urls } = demoFetch();
    const { controller } = setup({
      fetch,
      provider: scripted([reply({ content: 'ok' })]),
      settings: { provider: 'demo', baseUrl: '', model: '' },
    });
    await controller.send('hi');
    expect(urls.filter((url) => url === '/api/ai/quota')).toHaveLength(1);
  });
});

describe('checkProvider', () => {
  it('turns on JSON mode when tool calling is no', async () => {
    const { fetch } = fakeFetch((url) =>
      url.endsWith('/models') ? json({ data: [{ id: 'm' }] }) : json({ error: {} }, 400),
    );
    const { controller, aiStore, keyHolder } = setup({ settings: OWN, fetch });
    keyHolder.set(SECRET_KEY);
    const outcome = await controller.checkProvider();
    expect(outcome.ok).toBe(true);
    expect(aiStore.getState().capability?.toolCalling).toBe('no');
    expect(aiStore.getState().jsonMode).toBe(true);
  });

  it('reports a bad base URL and demo mode without a network call', async () => {
    const { fetch, urls } = demoFetch();
    const bad = setup({ settings: { ...OWN, baseUrl: 'http://example.com' }, fetch });
    const badOutcome = await bad.controller.checkProvider();
    expect(badOutcome.ok).toBe(false);
    const demo = setup({ fetch });
    expect((await demo.controller.checkProvider()).ok).toBe(false);
    expect(urls).toEqual([]);
  });

  it('never throws when fetch throws', async () => {
    const { fetch } = fakeFetch(() => {
      throw new Error('offline');
    });
    const { controller } = setup({ settings: OWN, fetch });
    await expect(controller.checkProvider()).resolves.toBeDefined();
  });
});

async function readRawSettings(factory: IDBFactory, name: string): Promise<string> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name);
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(new Error('open failed'));
    };
  });
  const records = await new Promise<unknown[]>((resolve, reject) => {
    const request = db.transaction('settings').objectStore('settings').getAll();
    request.onsuccess = () => {
      resolve(request.result as unknown[]);
    };
    request.onerror = () => {
      reject(new Error('read failed'));
    };
  });
  db.close();
  return JSON.stringify(records);
}

describe('settings', () => {
  it('saves the three settings, keeps the key only in the key holder and out of storage', async () => {
    const { controller, aiStore, keyHolder, settingsRepo, factory, dbName } = setup();
    const outcome = await controller.saveSettings(OWN, SECRET_KEY);
    expect(outcome).toEqual({ ok: true });
    expect(keyHolder.get()).toBe(SECRET_KEY);
    expect(aiStore.getState().settings).toEqual(OWN);
    expect(aiStore.getState().hasKey).toBe(true);
    expect(JSON.stringify(aiStore.getState())).not.toContain(SECRET_KEY);

    const raw = await readRawSettings(factory, dbName);
    expect(raw).toContain('api.example.com');
    expect(raw).not.toContain(SECRET_KEY);
    expect((await settingsRepo.load()).settings).toEqual(OWN);
  });

  it('keeps the key when saved without one, and clears it with an empty key', async () => {
    const { controller, keyHolder, aiStore } = setup();
    await controller.saveSettings(OWN, SECRET_KEY);
    await controller.saveSettings({ ...OWN, model: 'other' });
    expect(keyHolder.get()).toBe(SECRET_KEY);
    await controller.saveSettings({ ...OWN, model: 'other' }, '');
    expect(keyHolder.get()).toBeUndefined();
    expect(aiStore.getState().hasKey).toBe(false);
  });

  it('refuses invalid settings with a message and changes nothing', async () => {
    const { controller, aiStore, keyHolder } = setup();
    const outcome = await controller.saveSettings({ ...OWN, baseUrl: 'http://example.com' }, 'k');
    expect(outcome.ok).toBe(false);
    expect(aiStore.getState().settings.provider).toBe('demo');
    expect(keyHolder.get()).toBeUndefined();
  });

  it('init loads the stored settings and refreshes the quota', async () => {
    const first = setup();
    await first.controller.saveSettings(OWN);
    const aiStore = createAiStore();
    const { fetch, urls } = demoFetch();
    const controller = createAiController({
      stackStore: createStackStore(STACK),
      aiStore,
      settingsRepo: first.settingsRepo,
      keyHolder: createKeyHolder(),
      fetch,
      scenarios: SCENARIOS,
      now: () => 0,
    });
    await controller.init();
    expect(aiStore.getState().settings).toEqual(OWN);
    expect(aiStore.getState().hasKey).toBe(false);
    // Own mode: no quota call.
    expect(urls).toEqual([]);

    const demo = setup({ fetch });
    await demo.controller.init();
    expect(demo.aiStore.getState().quota).toEqual({ remaining: 4 });
  });

  it('init never throws when the repository throws', async () => {
    const { aiStore } = setup();
    const controller = createAiController({
      stackStore: createStackStore(STACK),
      aiStore,
      settingsRepo: {
        load: () => Promise.reject(new Error('boom')),
        save: () => Promise.reject(new Error('boom')),
      },
      keyHolder: createKeyHolder(),
      fetch: demoFetch().fetch,
      scenarios: SCENARIOS,
      now: () => 0,
    });
    await expect(controller.init()).resolves.toBeUndefined();
    await expect(controller.saveSettings(OWN, 'k')).resolves.toMatchObject({ ok: false });
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_MESSAGE,
  MODEL_NOT_LISTED_MESSAGE,
  MODELS_TIMEOUT_MS,
  NO_TOOLS_MESSAGE,
  UNREACHABLE_MESSAGE,
  createCapabilityCache,
  detectCapabilities,
} from './capabilities.ts';
import type { CapabilityReport } from './capabilities.ts';

const KEY = 'sk-test-DISTINCTIVE-key-9f8e7d6c5b4a';
const BASE = 'https://api.example.test/v1';
const MODEL = 'test-model';

type FetchCall = { readonly url: string; readonly init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

const TOOL_REPLY = {
  choices: [
    {
      finish_reason: 'tool_calls',
      message: {
        content: null,
        tool_calls: [{ id: 't1', type: 'function', function: { name: 'noop', arguments: '{}' } }],
      },
    },
  ],
};

const TEXT_REPLY = {
  choices: [{ finish_reason: 'stop', message: { content: 'Sure.' } }],
};

/** A fake fetch that records calls and answers `/models` and `/chat/completions` separately. */
function fakeFetch(handlers: {
  models?: (call: FetchCall) => Response | Promise<Response>;
  chat?: (call: FetchCall) => Response | Promise<Response>;
}) {
  const calls: FetchCall[] = [];
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const call: FetchCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    const handler = call.url.endsWith('/models') ? handlers.models : handlers.chat;
    if (handler === undefined) return Promise.reject(new Error('unexpected call'));
    return Promise.resolve(handler(call));
  });
  return {
    fetch: fn as unknown as typeof fetch,
    calls,
    modelCalls: () => calls.filter((c) => c.url.endsWith('/models')),
    chatCalls: () => calls.filter((c) => c.url.endsWith('/chat/completions')),
  };
}

function listOf(...ids: string[]): Response {
  return json({ object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
}

function run(
  fetchFn: typeof fetch,
  extra: Partial<Parameters<typeof detectCapabilities>[0]> = {},
): Promise<CapabilityReport> {
  return detectCapabilities({
    baseUrl: BASE,
    model: MODEL,
    getKey: () => KEY,
    fetch: fetchFn,
    ...extra,
  });
}

describe('detectCapabilities: models call', () => {
  it('sends GET <base>/models with the key only in the authorization header', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL), chat: () => json(TOOL_REPLY) });
    await run(f.fetch, { baseUrl: `${BASE}/` });
    const call = f.modelCalls()[0];
    expect(call?.url).toBe(`${BASE}/models`);
    expect(call?.init.method).toBe('GET');
    expect(call?.init.credentials).toBe('omit');
    expect(call?.init.redirect).toBe('error');
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
    expect(call?.init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    expect(call?.init.body).toBeUndefined();
    expect(call?.url).not.toContain(KEY);
  });

  it('reports success with whisper in the model list', async () => {
    const f = fakeFetch({
      models: () => listOf(MODEL, 'Whisper-Large-V3', 'other'),
      chat: () => json(TOOL_REPLY),
    });
    const report = await run(f.fetch);
    expect(report).toEqual({
      reachable: true,
      authOk: true,
      modelListed: true,
      toolCalling: 'yes',
      transcription: 'yes',
      models: [MODEL, 'Whisper-Large-V3', 'other'],
      messages: [],
    });
  });

  it('detects transcribe in a model id', async () => {
    const f = fakeFetch({
      models: () => listOf(MODEL, 'gpt-4o-mini-TRANSCRIBE'),
      chat: () => json(TOOL_REPLY),
    });
    expect((await run(f.fetch)).transcription).toBe('yes');
  });

  it('reports transcription unknown, never no, without such a model', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL, 'other'), chat: () => json(TOOL_REPLY) });
    expect((await run(f.fetch)).transcription).toBe('unknown');
  });

  it('accepts a models/ prefixed id for the configured model', async () => {
    const f = fakeFetch({ models: () => listOf(`models/${MODEL}`), chat: () => json(TOOL_REPLY) });
    expect((await run(f.fetch)).modelListed).toBe(true);
  });

  it('reports 401 as authOk false and skips the tool probe', async () => {
    const f = fakeFetch({ models: () => json({ error: 'nope' }, 401) });
    const report = await run(f.fetch);
    expect(report.reachable).toBe(true);
    expect(report.authOk).toBe(false);
    expect(report.toolCalling).toBe('unknown');
    expect(report.messages).toContain(AUTH_MESSAGE);
    expect(f.chatCalls()).toHaveLength(0);
  });

  it('reports 403 as authOk false', async () => {
    const f = fakeFetch({ models: () => json({}, 403) });
    const report = await run(f.fetch);
    expect(report.authOk).toBe(false);
    expect(f.chatCalls()).toHaveLength(0);
  });

  it('reports a TypeError as unreachable with the CORS sentence and the demo suggestion', async () => {
    const calls: string[] = [];
    const fetchFn = ((input: string | URL | Request) => {
      calls.push(String(input));
      return Promise.reject(new TypeError('Failed to fetch'));
    }) as unknown as typeof fetch;
    const report = await run(fetchFn);
    expect(report.reachable).toBe(false);
    expect(report.authOk).toBe('unknown');
    expect(report.modelListed).toBe('unknown');
    expect(report.messages[0]).toBe(
      'The browser could not reach this provider. It may not allow requests from web pages. Try demo mode.',
    );
    expect(report.messages[0]).toBe(UNREACHABLE_MESSAGE);
    expect(report.messages[0]).toContain('demo mode');
    expect(calls).toHaveLength(1);
  });

  it('keeps the tool probe going when the provider has no model list (404)', async () => {
    const f = fakeFetch({ models: () => json({}, 404), chat: () => json(TOOL_REPLY) });
    const report = await run(f.fetch);
    expect(report.reachable).toBe(true);
    expect(report.modelListed).toBe('unknown');
    expect(report.authOk).toBe('unknown');
    expect(report.toolCalling).toBe('yes');
    expect(report.models).toEqual([]);
    expect(f.chatCalls()).toHaveLength(1);
  });

  it('treats unparseable and empty lists as modelListed unknown', async () => {
    for (const body of ['not json', '{"data":"x"}', '{"data":[{"id":5}]}', '{"data":[]}']) {
      const f = fakeFetch({
        models: () => new Response(body, { status: 200 }),
        chat: () => json(TOOL_REPLY),
      });
      const report = await run(f.fetch);
      expect(report.modelListed).toBe('unknown');
      expect(report.models).toEqual([]);
      expect(report.messages).not.toContain(MODEL_NOT_LISTED_MESSAGE);
    }
  });

  it('reports the model missing from the list', async () => {
    const f = fakeFetch({ models: () => listOf('a', 'b'), chat: () => json(TOOL_REPLY) });
    const report = await run(f.fetch);
    expect(report.modelListed).toBe(false);
    expect(report.messages).toEqual([MODEL_NOT_LISTED_MESSAGE]);
  });

  it('keeps at most 50 models and cuts each id to 100 characters', async () => {
    const ids = Array.from({ length: 80 }, (_, i) => `model-${i}`);
    ids[0] = 'x'.repeat(250);
    ids[79] = 'whisper-late';
    const f = fakeFetch({ models: () => listOf(...ids), chat: () => json(TOOL_REPLY) });
    const report = await run(f.fetch);
    expect(report.models).toHaveLength(50);
    expect(report.models[0]).toBe('x'.repeat(100));
    // Transcription is read from the whole list, not only from the kept part.
    expect(report.transcription).toBe('yes');
  });

  it('does not split a surrogate pair when cutting an id', async () => {
    const id = `${'a'.repeat(99)}😀tail`;
    const f = fakeFetch({ models: () => listOf(id), chat: () => json(TOOL_REPLY) });
    const report = await run(f.fetch);
    expect(report.models[0]).toBe(`${'a'.repeat(99)}😀`);
  });

  it('times out the models call after 15 seconds with the injected timers', async () => {
    let fire: (() => void) | undefined;
    let delay = -1;
    const stopped: unknown[] = [];
    const fetchFn = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
      })) as unknown as typeof fetch;
    const pending = run(fetchFn, {
      setTimeout: (handler, ms) => {
        fire = handler;
        delay = ms;
        return 'timer-1';
      },
      clearTimeout: (handle) => {
        stopped.push(handle);
      },
    });
    await Promise.resolve();
    expect(delay).toBe(MODELS_TIMEOUT_MS);
    expect(delay).toBe(15_000);
    fire?.();
    const report = await pending;
    expect(report.reachable).toBe(false);
    expect(report.messages[0]).toBe('The model took too long to answer.');
    expect(stopped).toContain('timer-1');
  });

  it('stops when the caller aborts and does not run the probe', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
      calls.push(String(input));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError')));
        controller.abort();
      });
    }) as unknown as typeof fetch;
    const report = await run(fetchFn, { signal: controller.signal });
    expect(report.reachable).toBe(false);
    expect(report.messages[0]).toBe('The request was stopped.');
    expect(calls).toHaveLength(1);
  });

  it('never rejects, even when getKey throws', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL) });
    const report = await run(f.fetch, {
      getKey: () => {
        throw new Error(`boom ${KEY}`);
      },
    });
    expect(report.reachable).toBe(false);
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it('never rejects when fetch throws something that is not a TypeError', async () => {
    const fetchFn = (() => Promise.reject(new Error(`secret ${KEY}`))) as unknown as typeof fetch;
    const report = await run(fetchFn);
    expect(report.reachable).toBe(false);
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it('sends no authorization header and skips the probe when there is no key', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL) });
    const report = await run(f.fetch, { getKey: () => undefined });
    expect(f.modelCalls()[0]?.init.headers).not.toHaveProperty('authorization');
    expect(f.chatCalls()).toHaveLength(0);
    expect(report.authOk).toBe('unknown');
    expect(report.toolCalling).toBe('unknown');
    expect(report.messages).toContain(NO_TOOLS_MESSAGE);
  });
});

describe('detectCapabilities: tool probe', () => {
  it('reports yes when the reply has a tool call, with the noop request', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL), chat: () => json(TOOL_REPLY) });
    const report = await run(f.fetch);
    expect(report.toolCalling).toBe('yes');
    expect(report.messages).toEqual([]);
    const call = f.chatCalls()[0];
    expect(call?.url).toBe(`${BASE}/chat/completions`);
    expect(call?.init.headers).toMatchObject({ authorization: `Bearer ${KEY}` });
    const body: unknown = JSON.parse(String(call?.init.body));
    expect(body).toMatchObject({
      model: MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Call the noop tool.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'noop',
            description: 'Does nothing.',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
          },
        },
      ],
    });
    expect(String(call?.init.body)).not.toContain(KEY);
  });

  it('reports no on a 400 and adds the JSON fallback sentence', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL), chat: () => json({ error: 'x' }, 400) });
    const report = await run(f.fetch);
    expect(report.toolCalling).toBe('no');
    expect(report.messages).toEqual([
      'This model may not support tool calls. The app will ask it for JSON instead.',
    ]);
  });

  it('reports unknown when the reply has no tool call', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL), chat: () => json(TEXT_REPLY) });
    const report = await run(f.fetch);
    expect(report.toolCalling).toBe('unknown');
    expect(report.messages).toEqual([NO_TOOLS_MESSAGE]);
  });

  it('reports unknown with the provider error message on other errors', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL), chat: () => json({}, 500) });
    const report = await run(f.fetch);
    expect(report.toolCalling).toBe('unknown');
    expect(report.messages).toEqual(['The provider had a problem on its side.', NO_TOOLS_MESSAGE]);
  });

  it('marks authOk false when the chat call is rejected for the key', async () => {
    const f = fakeFetch({ models: () => listOf(MODEL), chat: () => json({}, 401) });
    const report = await run(f.fetch);
    expect(report.authOk).toBe(false);
    expect(report.messages[0]).toBe(AUTH_MESSAGE);
  });

  it('stays reachable when only the probe has a network error', async () => {
    const calls: string[] = [];
    const fetchFn = ((input: string | URL | Request) => {
      calls.push(String(input));
      return String(input).endsWith('/models')
        ? Promise.resolve(listOf(MODEL))
        : Promise.reject(new TypeError('Failed to fetch'));
    }) as unknown as typeof fetch;
    const report = await run(fetchFn);
    expect(report.reachable).toBe(true);
    expect(report.toolCalling).toBe('unknown');
    expect(calls).toHaveLength(2);
  });

  it('passes the injected timers to the probe', async () => {
    const delays: number[] = [];
    const f = fakeFetch({ models: () => listOf(MODEL), chat: () => json(TOOL_REPLY) });
    await run(f.fetch, {
      setTimeout: (_handler, ms) => {
        delays.push(ms);
        return delays.length;
      },
      clearTimeout: () => undefined,
    });
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBe(15_000);
  });
});

describe('detectCapabilities: messages never contain the key', () => {
  it('holds for every outcome', async () => {
    const outcomes: Array<Parameters<typeof fakeFetch>[0]> = [
      { models: () => json({ error: KEY }, 401) },
      { models: () => json({ error: KEY }, 500), chat: () => json({ error: KEY }, 400) },
      { models: () => listOf(MODEL), chat: () => json({ error: KEY }, 401) },
      { models: () => listOf('a'), chat: () => new Response(KEY, { status: 200 }) },
      { models: () => new Response(KEY, { status: 200 }), chat: () => json({ error: KEY }, 429) },
    ];
    for (const handlers of outcomes) {
      const report = await run(fakeFetch(handlers).fetch);
      expect(JSON.stringify(report)).not.toContain(KEY);
      expect(JSON.stringify(report)).not.toContain('Bearer');
    }
  });
});

describe('createCapabilityCache', () => {
  const REPORT: CapabilityReport = {
    reachable: true,
    authOk: true,
    modelListed: true,
    toolCalling: 'yes',
    transcription: 'unknown',
    models: [MODEL],
    messages: [],
  };

  it('returns the same report for the same settings', () => {
    const cache = createCapabilityCache();
    const key = cache.keyFor(BASE, MODEL, true);
    expect(cache.get(key)).toBeUndefined();
    cache.set(key, REPORT);
    expect(cache.get(key)).toBe(REPORT);
    expect(cache.get(cache.keyFor(BASE, MODEL, true))).toBe(REPORT);
  });

  it('uses a different cache key when the base URL, model or key presence changes', () => {
    const cache = createCapabilityCache();
    const key = cache.keyFor(BASE, MODEL, true);
    cache.set(key, REPORT);
    expect(cache.get(cache.keyFor('https://other.example.test/v1', MODEL, true))).toBeUndefined();
    expect(cache.get(cache.keyFor(BASE, 'other-model', true))).toBeUndefined();
    expect(cache.get(cache.keyFor(BASE, MODEL, false))).toBeUndefined();
  });

  it('ignores a trailing slash on the base URL', () => {
    const cache = createCapabilityCache();
    expect(cache.keyFor(`${BASE}/`, MODEL, true)).toBe(cache.keyFor(BASE, MODEL, true));
  });

  it('builds the key as baseUrl|model|keyPresent without any key text', () => {
    const cache = createCapabilityCache();
    expect(cache.keyFor(BASE, MODEL, true)).toBe(`${BASE}|${MODEL}|keyPresent`);
    expect(cache.keyFor(BASE, MODEL, false)).toBe(`${BASE}|${MODEL}|noKey`);
    expect(cache.keyFor(BASE, MODEL, true)).not.toContain(KEY);
  });

  it('drops the report when the key goes away, and on clear', () => {
    const cache = createCapabilityCache();
    cache.set(cache.keyFor(BASE, MODEL, true), REPORT);
    // The user removes the key: the lookup uses the "no key" cache key and misses.
    expect(cache.get(cache.keyFor(BASE, MODEL, false))).toBeUndefined();
    cache.clear();
    expect(cache.get(cache.keyFor(BASE, MODEL, true))).toBeUndefined();
  });

  it('keeps separate caches per instance', () => {
    const a = createCapabilityCache();
    const b = createCapabilityCache();
    a.set('k', REPORT);
    expect(b.get('k')).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROVIDER_ERROR_CODES } from './errors.ts';
import {
  createProxyProvider,
  DEFAULT_PROXY_ENDPOINT,
  DEFAULT_PROXY_MODEL,
  DEFAULT_PROXY_TIMEOUT_MS,
} from './proxy-provider.ts';
import type { ChatRequest, OpenAiTool, ProviderErrorCode, ProviderResult } from './types.ts';

const TOOL: OpenAiTool = {
  type: 'function',
  function: { name: 'say', description: 'Say something', parameters: { type: 'object' } },
};

const USER_TEXT = 'make me a to-do stack';

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    messages: [
      { role: 'system', content: 'You build stacks.' },
      { role: 'user', content: USER_TEXT },
    ],
    tools: [TOOL],
    meta: { userMessage: USER_TEXT, round: 0, currentCardId: 'c1', selectedObjectId: 'o1' },
    ...overrides,
  };
}

const GOOD_REPLY = {
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'say', arguments: '{"text":"hello"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Call = { readonly url: string; readonly init: RequestInit };

function recordingFetch(respond: () => Response | Promise<Response>): {
  readonly fetch: typeof fetch;
  readonly calls: Call[];
} {
  const calls: Call[] = [];
  const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(respond());
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}

/** A fetch that never answers on its own and rejects like the browser when the signal aborts. */
function hangingFetch(): { readonly fetch: typeof fetch; readonly calls: Call[] } {
  const calls: Call[] = [];
  const fakeFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  };
  return { fetch: fakeFetch as typeof fetch, calls };
}

function failureCode(result: ProviderResult): ProviderErrorCode {
  if (result.ok) throw new Error('expected a failure');
  expect(PROVIDER_ERROR_CODES).toContain(result.error.code);
  return result.error.code;
}

async function codeFor(response: () => Response): Promise<ProviderErrorCode> {
  const { fetch } = recordingFetch(response);
  return failureCode(await createProxyProvider({ fetch }).chat(makeRequest()));
}

function headerKeys(init: RequestInit): string[] {
  const headers = init.headers;
  if (headers === undefined) return [];
  return Object.keys(headers as Record<string, string>).map((key) => key.toLowerCase());
}

function sentBody(call: Call | undefined): Record<string, unknown> {
  if (call === undefined || typeof call.init.body !== 'string') {
    throw new Error('expected a string body');
  }
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

describe('createProxyProvider: request', () => {
  it('has kind proxy', () => {
    const { fetch } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    expect(createProxyProvider({ fetch }).kind).toBe('proxy');
  });

  it('posts to the default endpoint with credentials omitted and redirects as errors', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    await createProxyProvider({ fetch }).chat(makeRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('/api/ai/chat');
    expect(DEFAULT_PROXY_ENDPOINT).toBe('/api/ai/chat');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.credentials).toBe('omit');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses a custom endpoint', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    await createProxyProvider({ fetch, endpoint: '/custom/chat' }).chat(makeRequest());
    expect(calls[0]?.url).toBe('/custom/chat');
  });

  it('sends only a content-type header and no authorization-like header', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    await createProxyProvider({ fetch }).chat(makeRequest());
    const keys = headerKeys(calls[0]?.init ?? {});
    expect(keys).toEqual(['content-type']);
    for (const key of keys) {
      expect(key).not.toMatch(/authorization|api-key|apikey|token|cookie|x-key/);
    }
  });

  it('sends the wire body with model auto by default and a custom model when given', async () => {
    const first = recordingFetch(() => jsonResponse(GOOD_REPLY));
    await createProxyProvider({ fetch: first.fetch }).chat(makeRequest());
    const body = sentBody(first.calls[0]);
    expect(DEFAULT_PROXY_MODEL).toBe('auto');
    expect(body['model']).toBe('auto');
    expect(body['stream']).toBe(false);
    expect(body['tool_choice']).toBe('auto');
    expect(body['messages']).toEqual([
      { role: 'system', content: 'You build stacks.' },
      { role: 'user', content: USER_TEXT },
    ]);
    expect(Array.isArray(body['tools'])).toBe(true);

    const second = recordingFetch(() => jsonResponse(GOOD_REPLY));
    await createProxyProvider({ fetch: second.fetch, model: 'fast' }).chat(makeRequest());
    expect(sentBody(second.calls[0])['model']).toBe('fast');
  });

  it('puts no authorization-like key and no meta in the request body', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    await createProxyProvider({ fetch }).chat(makeRequest());
    const body = sentBody(calls[0]);
    expect(Object.keys(body).sort()).toEqual(
      ['messages', 'model', 'stream', 'temperature', 'tool_choice', 'tools'].sort(),
    );
    expect(body).not.toHaveProperty('meta');
    for (const key of Object.keys(body)) {
      expect(key.toLowerCase()).not.toMatch(/authorization|key|token|secret|password/);
    }
    // The meta values are not sent anywhere except where the user text is a message.
    const text = String(calls[0]?.init.body);
    expect(text).not.toContain('currentCardId');
    expect(text).not.toContain('selectedObjectId');
    expect(text).not.toContain('userMessage');
  });

  it('omits tools when the request has none', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    await createProxyProvider({ fetch }).chat(makeRequest({ tools: undefined }));
    const body = sentBody(calls[0]);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('tool_choice');
  });
});

describe('createProxyProvider: replies', () => {
  it('parses a good reply with tool calls', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    const result = await createProxyProvider({ fetch }).chat(makeRequest());
    expect(result).toEqual({
      ok: true,
      reply: {
        content: null,
        toolCalls: [{ id: 'call_1', name: 'say', arguments: '{"text":"hello"}' }],
        finishReason: 'tool_calls',
      },
    });
  });

  it('parses a plain text reply', async () => {
    const { fetch } = recordingFetch(() =>
      jsonResponse({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }] }),
    );
    const result = await createProxyProvider({ fetch }).chat(makeRequest());
    expect(result).toEqual({
      ok: true,
      reply: { content: 'Hi', toolCalls: [], finishReason: 'stop' },
    });
  });

  it('gives BAD_REPLY for a 2xx body that is not JSON', async () => {
    expect(await codeFor(() => new Response('<html>hello</html>', { status: 200 }))).toBe(
      'BAD_REPLY',
    );
  });

  it('gives BAD_REPLY for a 2xx empty body', async () => {
    expect(await codeFor(() => new Response('', { status: 200 }))).toBe('BAD_REPLY');
  });

  it('gives BAD_REPLY for a 2xx body that does not match the schema', async () => {
    expect(await codeFor(() => jsonResponse({ choices: [] }))).toBe('BAD_REPLY');
    expect(await codeFor(() => jsonResponse({ nope: true }))).toBe('BAD_REPLY');
    expect(await codeFor(() => jsonResponse([1, 2, 3]))).toBe('BAD_REPLY');
    expect(await codeFor(() => jsonResponse({ choices: [{ message: { content: 5 } }] }))).toBe(
      'BAD_REPLY',
    );
  });

  it('accepts any 2xx status', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(GOOD_REPLY, 201));
    const result = await createProxyProvider({ fetch }).chat(makeRequest());
    expect(result.ok).toBe(true);
  });
});

describe('createProxyProvider: failure answers', () => {
  it('maps the proxy code RATE_LIMITED to RATE_LIMITED', async () => {
    expect(
      await codeFor(() => jsonResponse({ error: { code: 'RATE_LIMITED', message: 'x' } }, 429)),
    ).toBe('RATE_LIMITED');
  });

  it('maps the proxy code DAILY_CAP to QUOTA', async () => {
    expect(await codeFor(() => jsonResponse({ error: { code: 'DAILY_CAP' } }, 429))).toBe('QUOTA');
    expect(await codeFor(() => jsonResponse({ error: { code: 'DAILY_CAP' } }, 503))).toBe('QUOTA');
  });

  it('maps the proxy code MODEL_NOT_ALLOWED to BAD_REQUEST', async () => {
    expect(await codeFor(() => jsonResponse({ error: { code: 'MODEL_NOT_ALLOWED' } }, 400))).toBe(
      'BAD_REQUEST',
    );
    expect(await codeFor(() => jsonResponse({ error: { code: 'MODEL_NOT_ALLOWED' } }, 403))).toBe(
      'BAD_REQUEST',
    );
  });

  it('maps an unknown proxy code by HTTP status', async () => {
    expect(await codeFor(() => jsonResponse({ error: { code: 'WHATEVER' } }, 500))).toBe('SERVER');
    expect(await codeFor(() => jsonResponse({ error: { code: 'WHATEVER' } }, 429))).toBe(
      'RATE_LIMITED',
    );
    expect(await codeFor(() => jsonResponse({ error: { code: 'WHATEVER' } }, 400))).toBe(
      'BAD_REQUEST',
    );
    expect(await codeFor(() => jsonResponse({ error: { code: 'WHATEVER' } }, 401))).toBe('SERVER');
    expect(await codeFor(() => jsonResponse({ error: { code: 'WHATEVER' } }, 404))).toBe('SERVER');
  });

  it('maps JSON without a usable error code by HTTP status', async () => {
    expect(await codeFor(() => jsonResponse({}, 500))).toBe('SERVER');
    expect(await codeFor(() => jsonResponse({ error: 'text' }, 400))).toBe('BAD_REQUEST');
    expect(await codeFor(() => jsonResponse({ error: { code: 42 } }, 429))).toBe('RATE_LIMITED');
    expect(await codeFor(() => jsonResponse({ error: null }, 502))).toBe('SERVER');
  });

  it('gives SERVER for a 404 with and without a body', async () => {
    expect(await codeFor(() => new Response('Not found', { status: 404 }))).toBe('SERVER');
    expect(await codeFor(() => new Response(null, { status: 404 }))).toBe('SERVER');
    expect(await codeFor(() => jsonResponse({ error: { code: 'NOT_FOUND' } }, 404))).toBe('SERVER');
  });

  it('gives SERVER for an HTML error body', async () => {
    const html = '<!doctype html><html><body><h1>Internal Server Error</h1></body></html>';
    expect(await codeFor(() => new Response(html, { status: 500 }))).toBe('SERVER');
    expect(await codeFor(() => new Response(html, { status: 502 }))).toBe('SERVER');
    // A static host answering a POST to a missing route.
    expect(await codeFor(() => new Response(html, { status: 405 }))).toBe('SERVER');
    expect(await codeFor(() => new Response(html, { status: 200 }))).toBe('BAD_REPLY');
  });

  it('gives SERVER for a non-JSON error body and an empty error body', async () => {
    expect(await codeFor(() => new Response('upstream connect error', { status: 503 }))).toBe(
      'SERVER',
    );
    expect(await codeFor(() => new Response('', { status: 500 }))).toBe('SERVER');
    expect(await codeFor(() => new Response('', { status: 400 }))).toBe('SERVER');
    expect(await codeFor(() => new Response('"just a string"', { status: 500 }))).toBe('SERVER');
  });

  it('treats a redirect status like any other failure', async () => {
    expect(await codeFor(() => new Response(null, { status: 302 }))).toBe('SERVER');
  });

  it('never returns the body text of an error response', async () => {
    const secret = 'SECRET-BODY-TEXT-9f3a';
    const bodies = [
      JSON.stringify({ error: { code: 'RATE_LIMITED', message: secret } }),
      JSON.stringify({ error: { code: 'WHATEVER', message: secret, detail: secret } }),
      `<html>${secret}</html>`,
      secret,
    ];
    for (const body of bodies) {
      for (const status of [400, 404, 429, 500]) {
        const { fetch } = recordingFetch(() => new Response(body, { status }));
        const result = await createProxyProvider({ fetch }).chat(makeRequest());
        expect(JSON.stringify(result)).not.toContain(secret);
        expect(result.ok).toBe(false);
      }
    }
  });

  it('keeps the user text and the endpoint out of every error', async () => {
    const { fetch } = recordingFetch(() => new Response('oops', { status: 500 }));
    const result = await createProxyProvider({ fetch, endpoint: '/secret/path' }).chat(
      makeRequest(),
    );
    const text = JSON.stringify(result);
    expect(text).not.toContain(USER_TEXT);
    expect(text).not.toContain('/secret/path');
  });

  it('gives CORS_OR_OFFLINE when fetch throws a TypeError', async () => {
    const fetch = (() =>
      Promise.reject(new TypeError('Failed to fetch'))) as typeof globalThis.fetch;
    const result = await createProxyProvider({ fetch }).chat(makeRequest());
    expect(failureCode(result)).toBe('CORS_OR_OFFLINE');
    expect(JSON.stringify(result)).not.toContain('Failed to fetch');
  });

  it('gives NETWORK when fetch throws something else, and when it throws synchronously', async () => {
    const rejecting = (() => Promise.reject(new Error('boom-secret'))) as typeof globalThis.fetch;
    const rejected = await createProxyProvider({ fetch: rejecting }).chat(makeRequest());
    expect(failureCode(rejected)).toBe('NETWORK');
    expect(JSON.stringify(rejected)).not.toContain('boom-secret');

    const throwing = (() => {
      throw new Error('sync-secret');
    }) as typeof globalThis.fetch;
    const thrown = await createProxyProvider({ fetch: throwing }).chat(makeRequest());
    expect(failureCode(thrown)).toBe('NETWORK');
    expect(JSON.stringify(thrown)).not.toContain('sync-secret');
  });

  it('gives NETWORK when reading the body fails', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream-secret'));
      },
    });
    const { fetch } = recordingFetch(() => new Response(stream, { status: 200 }));
    const result = await createProxyProvider({ fetch }).chat(makeRequest());
    expect(failureCode(result)).toBe('NETWORK');
    expect(JSON.stringify(result)).not.toContain('stream-secret');
  });
});

describe('createProxyProvider: timeout and abort', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults the timeout to 60 seconds', async () => {
    expect(DEFAULT_PROXY_TIMEOUT_MS).toBe(60_000);
    const { fetch, calls } = hangingFetch();
    const pending = createProxyProvider({ fetch }).chat(makeRequest());
    await vi.advanceTimersByTimeAsync(59_999);
    expect(calls[0]?.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0]?.init.signal?.aborted).toBe(true);
    expect(failureCode(await pending)).toBe('TIMEOUT');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives TIMEOUT and aborts the fetch when the time is up', async () => {
    const { fetch, calls } = hangingFetch();
    const pending = createProxyProvider({ fetch, timeoutMs: 1000 }).chat(makeRequest());
    await vi.advanceTimersByTimeAsync(1000);
    const result = await pending;
    expect(failureCode(result)).toBe('TIMEOUT');
    expect(calls[0]?.init.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives TIMEOUT even when fetch ignores the signal', async () => {
    const fetch = (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch;
    const pending = createProxyProvider({ fetch, timeoutMs: 500 }).chat(makeRequest());
    await vi.advanceTimersByTimeAsync(500);
    expect(failureCode(await pending)).toBe('TIMEOUT');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives TIMEOUT when the body read stalls', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
    const { fetch } = recordingFetch(() => new Response(stalled, { status: 200 }));
    const pending = createProxyProvider({ fetch, timeoutMs: 500 }).chat(makeRequest());
    await vi.advanceTimersByTimeAsync(500);
    expect(failureCode(await pending)).toBe('TIMEOUT');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not time out a request that answers in time, and clears its timer', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    const result = await createProxyProvider({ fetch, timeoutMs: 1000 }).chat(makeRequest());
    expect(result.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(result.ok).toBe(true);
  });

  it('clears the timer after every kind of failure', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response('oops', { status: 500 }),
      () => jsonResponse({ error: { code: 'RATE_LIMITED' } }, 429),
      () => new Response('not json', { status: 200 }),
      () => Promise.reject(new TypeError('x')),
      () => Promise.reject(new Error('x')),
    ];
    for (const answer of answers) {
      const { fetch } = recordingFetch(answer);
      await createProxyProvider({ fetch }).chat(makeRequest());
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it('gives ABORTED and aborts the fetch when the caller aborts', async () => {
    const { fetch, calls } = hangingFetch();
    const controller = new AbortController();
    const pending = createProxyProvider({ fetch }).chat(makeRequest(), controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const result = await pending;
    expect(failureCode(result)).toBe('ABORTED');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives ABORTED when the caller aborts while fetch ignores the signal', async () => {
    const fetch = (() => new Promise<Response>(() => undefined)) as typeof globalThis.fetch;
    const controller = new AbortController();
    const pending = createProxyProvider({ fetch }).chat(makeRequest(), controller.signal);
    controller.abort();
    expect(failureCode(await pending)).toBe('ABORTED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives ABORTED and does not call fetch when the signal is already aborted', async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    const controller = new AbortController();
    controller.abort();
    const result = await createProxyProvider({ fetch }).chat(makeRequest(), controller.signal);
    expect(failureCode(result)).toBe('ABORTED');
    expect(calls).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives ABORTED when the caller aborts while the body is read', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start: () => undefined });
    const { fetch } = recordingFetch(() => new Response(stalled, { status: 200 }));
    const controller = new AbortController();
    const pending = createProxyProvider({ fetch }).chat(makeRequest(), controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    expect(failureCode(await pending)).toBe('ABORTED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets ABORTED win when the caller aborts and the time is up together', async () => {
    const { fetch } = hangingFetch();
    const controller = new AbortController();
    const pending = createProxyProvider({ fetch, timeoutMs: 100 }).chat(
      makeRequest(),
      controller.signal,
    );
    controller.abort();
    await vi.advanceTimersByTimeAsync(100);
    expect(failureCode(await pending)).toBe('ABORTED');
  });

  it('removes its listener from the caller signal after a normal answer', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    const controller = new AbortController();
    const removed: string[] = [];
    const original = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      removed.push(type);
      original(type, listener, options);
    }) as typeof controller.signal.removeEventListener;
    await createProxyProvider({ fetch }).chat(makeRequest(), controller.signal);
    expect(removed).toContain('abort');
  });

  it('uses injected timer functions and clears the handle it was given', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    const handle = { id: 'timer-1' };
    const set = vi.fn<(handler: () => void, ms: number) => unknown>(() => handle);
    const clear = vi.fn<(handle: unknown) => void>();
    const result = await createProxyProvider({
      fetch,
      timeoutMs: 1234,
      setTimeout: set,
      clearTimeout: clear,
    }).chat(makeRequest());
    expect(result.ok).toBe(true);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]?.[1]).toBe(1234);
    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(handle);
  });

  it('times out through an injected timer and clears it', async () => {
    const { fetch } = hangingFetch();
    let fire: (() => void) | undefined;
    const set = vi.fn<(handler: () => void, ms: number) => unknown>((handler) => {
      fire = handler;
      return 7;
    });
    const clear = vi.fn<(handle: unknown) => void>();
    const pending = createProxyProvider({ fetch, setTimeout: set, clearTimeout: clear }).chat(
      makeRequest(),
    );
    await vi.advanceTimersByTimeAsync(0);
    fire?.();
    expect(failureCode(await pending)).toBe('TIMEOUT');
    expect(clear).toHaveBeenCalledWith(7);
  });

  it('leaves no timer behind across repeated calls on one provider', async () => {
    const { fetch } = recordingFetch(() => jsonResponse(GOOD_REPLY));
    const provider = createProxyProvider({ fetch });
    for (let i = 0; i < 3; i += 1) {
      await provider.chat(makeRequest());
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

import { AI_WIRE_LIMITS, ChatRequestSchema } from '@hypergeist/shared/ai-wire';
import { describe, expect, it } from 'vitest';
import { PROVIDER_ERROR_CODES } from './errors.ts';
import { toolCall } from './testing/scripted-provider.ts';
import { buildToolRegistry, toOpenAiTools } from './tools.ts';
import type { ChatRequest, OpenAiTool } from './types.ts';
import { MAX_TOOL_CALLS_PER_REPLY, parseWireReply, toWireBody } from './wire.ts';

const META = {
  userMessage: 'secret-user-text',
  round: 0,
  currentCardId: 'c1',
  selectedObjectId: null,
};

const TOOL: OpenAiTool = {
  type: 'function',
  function: { name: 'say', description: 'Say something', parameters: { type: 'object' } },
};

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { messages: [{ role: 'user', content: 'hi' }], meta: META, ...overrides };
}

function reply(message: unknown, ...finish: readonly [] | readonly [unknown]): unknown {
  // No second argument means "stop"; an explicit `undefined` means the key is absent.
  const finishReason = finish.length === 0 ? 'stop' : finish[0];
  return { choices: [{ index: 0, message, finish_reason: finishReason }] };
}

function badReply(json: unknown): void {
  const result = parseWireReply(json);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('BAD_REPLY');
    expect(PROVIDER_ERROR_CODES).toContain(result.error.code);
  }
}

describe('toWireBody', () => {
  it('maps every message role', () => {
    const body = toWireBody(
      'm1',
      request({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'usr' },
          { role: 'assistant', content: 'asst' },
          { role: 'tool', toolCallId: 't1', content: 'result' },
        ],
      }),
    );
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'usr' },
      { role: 'assistant', content: 'asst' },
      { role: 'tool', tool_call_id: 't1', content: 'result' },
    ]);
  });

  it('maps an assistant message with tool calls and null content', () => {
    const body = toWireBody(
      'm1',
      request({
        messages: [
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              { id: 'a', name: 'say', arguments: '{"text":"x"}' },
              { id: 'b', name: 'say', arguments: '{}' },
            ],
          },
        ],
      }),
    );
    expect(body.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'a', type: 'function', function: { name: 'say', arguments: '{"text":"x"}' } },
          { id: 'b', type: 'function', function: { name: 'say', arguments: '{}' } },
        ],
      },
    ]);
  });

  it('omits tool_calls for an empty list and never sends null content without tool calls', () => {
    const body = toWireBody(
      'm1',
      request({
        messages: [
          { role: 'assistant', content: null, toolCalls: [] },
          { role: 'assistant', content: null },
        ],
      }),
    );
    expect(body.messages).toEqual([
      { role: 'assistant', content: '' },
      { role: 'assistant', content: '' },
    ]);
  });

  it('sets model, stream false and temperature 0.2', () => {
    const body = toWireBody('my-model', request());
    expect(body.model).toBe('my-model');
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.2);
  });

  it('adds tools and tool_choice auto only when tools are present', () => {
    const withTools = toWireBody('m', request({ tools: [TOOL] }));
    expect(withTools.tools).toEqual([TOOL]);
    expect(withTools.tool_choice).toBe('auto');
    for (const none of [request(), request({ tools: [] })]) {
      const body = toWireBody('m', none);
      expect('tools' in body).toBe(false);
      expect('tool_choice' in body).toBe(false);
    }
  });

  it('adds max_tokens only when given a positive integer', () => {
    expect('max_tokens' in toWireBody('m', request())).toBe(false);
    expect('max_tokens' in toWireBody('m', request(), {})).toBe(false);
    expect(toWireBody('m', request(), { maxTokens: 512 }).max_tokens).toBe(512);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect('max_tokens' in toWireBody('m', request(), { maxTokens: bad })).toBe(false);
    }
  });

  it('drops meta and stays plain JSON', () => {
    const body = toWireBody('m', request({ tools: [TOOL] }), { maxTokens: 10 });
    const text = JSON.stringify(body);
    expect('meta' in body).toBe(false);
    expect(text).not.toContain('meta');
    expect(text).not.toContain('secret-user-text');
    expect(text).not.toMatch(/authorization|bearer|api[_-]?key|sk-/i);
    expect(JSON.parse(text)).toEqual(body);
  });

  it('does not change its input', () => {
    const input = request({
      messages: [
        {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'a', name: 'say', arguments: '{}' }],
        },
      ],
      tools: [TOOL],
    });
    const before = JSON.stringify(input);
    toWireBody('m', input, { maxTokens: 5 });
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('parseWireReply', () => {
  it('reads content only', () => {
    const result = parseWireReply(reply({ role: 'assistant', content: 'hello' }));
    expect(result).toEqual({
      ok: true,
      reply: { content: 'hello', toolCalls: [], finishReason: 'stop' },
    });
  });

  it('reads tool calls only (null content)', () => {
    const result = parseWireReply(
      reply(
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'x1', type: 'function', function: { name: 'say', arguments: '{"text":"a"}' } },
          ],
        },
        'tool_calls',
      ),
    );
    expect(result).toEqual({
      ok: true,
      reply: {
        content: null,
        toolCalls: [{ id: 'x1', name: 'say', arguments: '{"text":"a"}' }],
        finishReason: 'tool_calls',
      },
    });
  });

  it('reads content and tool calls together', () => {
    const result = parseWireReply(
      reply(
        {
          content: 'doing it',
          tool_calls: [{ id: 'x', function: { name: 'say', arguments: '{}' } }],
        },
        'tool_calls',
      ),
    );
    expect(result.ok && result.reply.content).toBe('doing it');
    expect(result.ok && result.reply.toolCalls.length).toBe(1);
  });

  it('accepts missing content and missing or null tool_calls', () => {
    for (const message of [{}, { content: null }, { tool_calls: null }, { content: undefined }]) {
      expect(parseWireReply(reply(message))).toEqual({
        ok: true,
        reply: { content: null, toolCalls: [], finishReason: 'stop' },
      });
    }
  });

  it('keeps an empty string content', () => {
    const result = parseWireReply(reply({ content: '' }));
    expect(result.ok && result.reply.content).toBe('');
  });

  it('is BAD_REPLY when content is neither a string nor null', () => {
    for (const content of [5, true, {}, ['a'], [{ type: 'text', text: 'a' }]]) {
      badReply(reply({ content }));
    }
  });

  it('numbers a missing, null or empty tool call id by position', () => {
    const result = parseWireReply(
      reply({
        tool_calls: [
          { function: { name: 'a', arguments: '{}' } },
          { id: 'keep', function: { name: 'b', arguments: '{}' } },
          { id: null, function: { name: 'c', arguments: '{}' } },
          { id: '', function: { name: 'd', arguments: '{}' } },
        ],
      }),
    );
    expect(result.ok && result.reply.toolCalls.map((c) => c.id)).toEqual([
      'call-0',
      'keep',
      'call-2',
      'call-3',
    ]);
  });

  it('is BAD_REPLY for a non-string tool call id', () => {
    badReply(reply({ tool_calls: [{ id: 7, function: { name: 'a', arguments: '{}' } }] }));
  });

  it('is BAD_REPLY for the whole reply when arguments is not a string', () => {
    const good = { id: 'g', function: { name: 'say', arguments: '{}' } };
    for (const args of [{ text: 'x' }, ['a'], 5, null, undefined, true]) {
      badReply(
        reply({
          content: 'ok',
          tool_calls: [good, { id: 'bad', function: { name: 'say', arguments: args } }],
        }),
      );
    }
  });

  it('is BAD_REPLY when the function or its name is missing or not a string', () => {
    badReply(reply({ tool_calls: [{ id: 'a' }] }));
    badReply(reply({ tool_calls: [{ id: 'a', function: { arguments: '{}' } }] }));
    badReply(reply({ tool_calls: [{ id: 'a', function: { name: 3, arguments: '{}' } }] }));
    badReply(reply({ tool_calls: 'nope' }));
    badReply(reply({ tool_calls: [null] }));
  });

  it('accepts exactly 100 tool calls and rejects 101', () => {
    const calls = (n: number): unknown[] =>
      Array.from({ length: n }, (_, i) => ({
        id: `t${i}`,
        function: { name: 'say', arguments: '{}' },
      }));
    const ok = parseWireReply(reply({ tool_calls: calls(MAX_TOOL_CALLS_PER_REPLY) }));
    expect(ok.ok && ok.reply.toolCalls.length).toBe(100);
    badReply(reply({ tool_calls: calls(MAX_TOOL_CALLS_PER_REPLY + 1) }));
  });

  it('ignores unknown keys at every level', () => {
    const result = parseWireReply({
      id: 'cmpl-1',
      usage: { total_tokens: 3 },
      choices: [
        {
          index: 0,
          logprobs: null,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'hi',
            reasoning: 'thinking',
            tool_calls: [
              {
                id: 'a',
                type: 'function',
                index: 0,
                function: { name: 'say', arguments: '{}', extra: 1 },
              },
            ],
          },
        },
      ],
    });
    expect(result).toEqual({
      ok: true,
      reply: {
        content: 'hi',
        toolCalls: [{ id: 'a', name: 'say', arguments: '{}' }],
        finishReason: 'stop',
      },
    });
  });

  it('uses only the first choice', () => {
    const result = parseWireReply({
      choices: [{ message: { content: 'first' } }, { message: { content: 5 } }],
    });
    expect(result.ok && result.reply.content).toBe('first');
  });

  it('is BAD_REPLY with no choices or a bad choice', () => {
    badReply({});
    badReply({ choices: [] });
    badReply({ choices: 'x' });
    badReply({ choices: [null] });
    badReply({ choices: [{}] });
    badReply({ choices: [{ message: 'text' }] });
  });

  it('is BAD_REPLY for values that are not an object', () => {
    for (const value of [null, undefined, 'text', 42, true, [], [{ choices: [] }]]) {
      badReply(value);
    }
  });

  it('maps finish_reason to the four values', () => {
    const cases: readonly [unknown, string][] = [
      ['stop', 'stop'],
      ['tool_calls', 'tool_calls'],
      ['length', 'length'],
      ['content_filter', 'other'],
      ['function_call', 'other'],
      [null, 'other'],
      [undefined, 'other'],
    ];
    for (const [input, expected] of cases) {
      const result = parseWireReply(reply({ content: 'x' }, input));
      expect(result.ok && result.reply.finishReason).toBe(expected);
    }
    const missing = parseWireReply({ choices: [{ message: { content: 'x' } }] });
    expect(missing.ok && missing.reply.finishReason).toBe('other');
  });

  it('is BAD_REPLY when finish_reason is not a string', () => {
    badReply(reply({ content: 'x' }, 3));
  });

  it('never copies reply text into the error', () => {
    const result = parseWireReply(reply({ content: 99 }, 'sk-should-not-appear'));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(JSON.stringify(result.error)).not.toContain('sk-should-not-appear');
    }
  });

  it('does not set noMatch', () => {
    const result = parseWireReply(reply({ content: 'x' }));
    expect(result.ok && 'noMatch' in result.reply).toBe(false);
  });
});

describe('contract with the Worker proxy schema', () => {
  // The Worker parses every request with `ChatRequestSchema`. A body that the browser builds with
  // `toWireBody` must pass it unchanged, or the hosted path would answer BAD_REQUEST.
  function expectParses(body: unknown): void {
    const result = ChatRequestSchema.safeParse(body);
    if (!result.success) {
      throw new Error(
        `ChatRequestSchema rejected the body: ${JSON.stringify(result.error.issues)}`,
      );
    }
    expect(result.success).toBe(true);
  }

  it('accepts a plain user request', () => {
    expectParses(toWireBody('auto', request()));
  });

  it('accepts a request with the compact tool registry and stays well under the body limit', () => {
    const tools = toOpenAiTools(buildToolRegistry({ newStack: true }));
    const body = toWireBody('auto', request({ tools }));
    expect(body.tool_choice).toBe('auto');
    expect(body.tools?.length).toBe(tools.length);
    expectParses(body);
    const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
    // About 11.6 KB when written (2026-11-15), against the 128 KB limit. A quarter of the limit
    // leaves room for history and the card context.
    expect(bytes).toBeLessThan(AI_WIRE_LIMITS.maxBodyBytes / 4);
  });

  it('accepts a history with an assistant tool-call message (null content) and a tool message', () => {
    const body = toWireBody(
      'auto',
      request({
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'add a button' },
          {
            role: 'assistant',
            content: null,
            toolCalls: [
              toolCall('say', { text: 'ok' }, 'call-1'),
              toolCall('say', { text: 'again' }, 'call-2'),
            ],
          },
          { role: 'tool', toolCallId: 'call-1', content: '{"ok":true}' },
          { role: 'tool', toolCallId: 'call-2', content: '{"ok":true}' },
        ],
      }),
    );
    expect(body.messages[2]).toMatchObject({ role: 'assistant', content: null });
    expectParses(body);
  });

  it('accepts a request with the maxTokens option', () => {
    const body = toWireBody('auto', request(), { maxTokens: 1024 });
    expect(body.max_tokens).toBe(1024);
    expectParses(body);
  });

  it('accepts a JSON-mode request (no tools)', () => {
    const body = toWireBody(
      'auto',
      request({
        messages: [
          { role: 'system', content: 'Reply with one JSON object.' },
          { role: 'user', content: 'make a to-do stack' },
        ],
      }),
      { maxTokens: 2048 },
    );
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
    expectParses(body);
  });

  it('rejects a body with an unknown top-level field (the check is not vacuous)', () => {
    const body = { ...toWireBody('auto', request()), response_format: { type: 'json_object' } };
    expect(ChatRequestSchema.safeParse(body).success).toBe(false);
  });
});

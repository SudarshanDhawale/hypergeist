import { describe, expect, it } from 'vitest';
import {
  AI_WIRE_LIMITS,
  ChatRequestSchema,
  PublicReplySchema,
  UpstreamReplySchema,
} from './index.ts';

const minimal = { model: 'auto', messages: [{ role: 'user', content: 'hi' }] };

const tool = {
  type: 'function',
  function: {
    name: 'add_object',
    description: 'Add an object.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
};

const full = {
  model: 'auto',
  messages: [
    { role: 'system', content: 'You edit stacks.' },
    { role: 'user', content: 'add a button' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'call-0', type: 'function', function: { name: 'add_object', arguments: '{}' } },
      ],
    },
    { role: 'tool', tool_call_id: 'call-0', content: '{"ok":true}' },
    { role: 'assistant', content: 'Done.' },
  ],
  tools: [tool],
  tool_choice: 'auto',
  stream: false,
  temperature: 0.2,
  max_tokens: 2048,
};

function withMessages(count: number): unknown {
  return {
    ...minimal,
    messages: Array.from({ length: count }, () => ({ role: 'user', content: 'x' })),
  };
}

function assistantWithCalls(count: number): unknown {
  const call = { id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } };
  return {
    ...minimal,
    messages: [
      { role: 'assistant', content: null, tool_calls: Array.from({ length: count }, () => call) },
    ],
  };
}

describe('AI_WIRE_LIMITS', () => {
  it('pins the limits of the design', () => {
    expect(AI_WIRE_LIMITS).toEqual({
      maxBodyBytes: 131072,
      maxMessages: 60,
      maxContentChars: 40000,
      maxToolCalls: 100,
      maxTools: 12,
      maxDescriptionChars: 2000,
      maxNameChars: 64,
      maxIdChars: 200,
    });
  });
});

describe('ChatRequestSchema', () => {
  it('pins the top-level keys', () => {
    expect(Object.keys(ChatRequestSchema.shape).sort()).toEqual([
      'max_tokens',
      'messages',
      'model',
      'stream',
      'temperature',
      'tool_choice',
      'tools',
    ]);
  });

  it('accepts a minimal request', () => {
    expect(ChatRequestSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts a full request with tools, a tool-call history and all options', () => {
    expect(ChatRequestSchema.safeParse(full).success).toBe(true);
  });

  it('accepts a tool without a description and tool_choice none', () => {
    const body = {
      ...minimal,
      tools: [{ type: 'function', function: { name: 't', parameters: {} } }],
      tool_choice: 'none',
    };
    expect(ChatRequestSchema.safeParse(body).success).toBe(true);
  });

  it('accepts the limits exactly', () => {
    expect(ChatRequestSchema.safeParse(withMessages(AI_WIRE_LIMITS.maxMessages)).success).toBe(
      true,
    );
    expect(
      ChatRequestSchema.safeParse(assistantWithCalls(AI_WIRE_LIMITS.maxToolCalls)).success,
    ).toBe(true);
    const content = 'x'.repeat(AI_WIRE_LIMITS.maxContentChars);
    expect(
      ChatRequestSchema.safeParse({ ...minimal, messages: [{ role: 'user', content }] }).success,
    ).toBe(true);
    const tools = Array.from({ length: AI_WIRE_LIMITS.maxTools }, () => tool);
    expect(ChatRequestSchema.safeParse({ ...minimal, tools }).success).toBe(true);
  });

  it.each(['n', 'stop', 'user', 'response_format', 'logit_bias', 'reasoning_effort'])(
    'rejects the unknown top-level key %s',
    (key) => {
      expect(ChatRequestSchema.safeParse({ ...minimal, [key]: 1 }).success).toBe(false);
    },
  );

  it('rejects an unknown key inside a message, a tool and a tool call', () => {
    expect(
      ChatRequestSchema.safeParse({
        ...minimal,
        messages: [{ role: 'user', content: 'hi', name: 'bob' }],
      }).success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        ...minimal,
        tools: [{ ...tool, strict: true }],
      }).success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        ...minimal,
        tools: [{ type: 'function', function: { ...tool.function, strict: true } }],
      }).success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        ...minimal,
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c',
                type: 'function',
                index: 0,
                function: { name: 'n', arguments: '{}' },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a non-function tool type', () => {
    expect(
      ChatRequestSchema.safeParse({ ...minimal, tools: [{ ...tool, type: 'code_interpreter' }] })
        .success,
    ).toBe(false);
  });

  it('rejects stream true and tool_choice required', () => {
    expect(ChatRequestSchema.safeParse({ ...minimal, stream: true }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ ...minimal, tool_choice: 'required' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown role, a user message with null content and a tool message without id', () => {
    expect(
      ChatRequestSchema.safeParse({ ...minimal, messages: [{ role: 'developer', content: 'x' }] })
        .success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({ ...minimal, messages: [{ role: 'user', content: null }] })
        .success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({ ...minimal, messages: [{ role: 'tool', content: 'x' }] })
        .success,
    ).toBe(false);
  });

  it('rejects too many messages, too many tools and too many tool calls', () => {
    expect(ChatRequestSchema.safeParse(withMessages(AI_WIRE_LIMITS.maxMessages + 1)).success).toBe(
      false,
    );
    const tools = Array.from({ length: AI_WIRE_LIMITS.maxTools + 1 }, () => tool);
    expect(ChatRequestSchema.safeParse({ ...minimal, tools }).success).toBe(false);
    expect(
      ChatRequestSchema.safeParse(assistantWithCalls(AI_WIRE_LIMITS.maxToolCalls + 1)).success,
    ).toBe(false);
  });

  it('rejects content, a description, a name and an id over their limits', () => {
    const long = (n: number) => 'x'.repeat(n + 1);
    expect(
      ChatRequestSchema.safeParse({
        ...minimal,
        messages: [{ role: 'user', content: long(AI_WIRE_LIMITS.maxContentChars) }],
      }).success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        ...minimal,
        tools: [
          {
            type: 'function',
            function: { ...tool.function, description: long(AI_WIRE_LIMITS.maxDescriptionChars) },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        ...minimal,
        tools: [
          {
            type: 'function',
            function: { ...tool.function, name: long(AI_WIRE_LIMITS.maxNameChars) },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ChatRequestSchema.safeParse({
        ...minimal,
        messages: [{ role: 'tool', tool_call_id: long(AI_WIRE_LIMITS.maxIdChars), content: 'x' }],
      }).success,
    ).toBe(false);
  });

  it('rejects a non-object body and an empty or missing messages array', () => {
    for (const body of [null, undefined, 'text', 42, true, [], [minimal]]) {
      expect(ChatRequestSchema.safeParse(body).success).toBe(false);
    }
    expect(ChatRequestSchema.safeParse({ ...minimal, messages: [] }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ model: 'auto' }).success).toBe(false);
  });

  it('rejects a missing, empty or too long model', () => {
    expect(ChatRequestSchema.safeParse({ messages: minimal.messages }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ ...minimal, model: '' }).success).toBe(false);
    expect(ChatRequestSchema.safeParse({ ...minimal, model: 'm'.repeat(101) }).success).toBe(false);
  });

  it('rejects out-of-range temperature and max_tokens', () => {
    for (const temperature of [-0.1, 2.1, Number.NaN]) {
      expect(ChatRequestSchema.safeParse({ ...minimal, temperature }).success).toBe(false);
    }
    for (const max_tokens of [0, -1, 1.5, 100_001]) {
      expect(ChatRequestSchema.safeParse({ ...minimal, max_tokens }).success).toBe(false);
    }
    expect(
      ChatRequestSchema.safeParse({ ...minimal, temperature: 2, max_tokens: 100_000 }).success,
    ).toBe(true);
  });

  it('requires parameters to be an object', () => {
    for (const parameters of [null, 'x', 1, [1]]) {
      const body = {
        ...minimal,
        tools: [{ type: 'function', function: { name: 't', parameters } }],
      };
      expect(ChatRequestSchema.safeParse(body).success).toBe(false);
    }
  });
});

describe('PublicReplySchema', () => {
  const reply = {
    choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
  };

  it('accepts a text reply and a tool-call reply with null content', () => {
    expect(PublicReplySchema.safeParse(reply).success).toBe(true);
    expect(
      PublicReplySchema.safeParse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects extra keys at every level', () => {
    expect(PublicReplySchema.safeParse({ ...reply, usage: { total_tokens: 1 } }).success).toBe(
      false,
    );
    expect(PublicReplySchema.safeParse({ ...reply, id: 'chatcmpl-1' }).success).toBe(false);
    expect(
      PublicReplySchema.safeParse({
        choices: [{ ...reply.choices[0], index: 0 }],
      }).success,
    ).toBe(false);
    expect(
      PublicReplySchema.safeParse({
        choices: [
          {
            message: { role: 'assistant', content: 'x', reasoning: 'secret thoughts' },
            finish_reason: 'stop',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects zero or several choices and more than 100 tool calls', () => {
    expect(PublicReplySchema.safeParse({ choices: [] }).success).toBe(false);
    expect(
      PublicReplySchema.safeParse({ choices: [reply.choices[0], reply.choices[0]] }).success,
    ).toBe(false);
    const call = { id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } };
    expect(
      PublicReplySchema.safeParse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: Array.from({ length: 101 }, () => call),
            },
            finish_reason: 'tool_calls',
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe('UpstreamReplySchema', () => {
  it('keeps unknown keys at every level', () => {
    const result = UpstreamReplySchema.safeParse({
      id: 'chatcmpl-1',
      system_fingerprint: 'fp',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'hi', reasoning: 'x' },
          finish_reason: 'stop',
          logprobs: null,
        },
      ],
      usage: { total_tokens: 12, prompt_tokens: 10 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty('id', 'chatcmpl-1');
      expect(result.data.usage).toEqual({ total_tokens: 12, prompt_tokens: 10 });
    }
  });

  it('accepts a missing or null usage and a missing total_tokens', () => {
    const base = { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] };
    expect(UpstreamReplySchema.safeParse(base).success).toBe(true);
    expect(UpstreamReplySchema.safeParse({ ...base, usage: null }).success).toBe(true);
    expect(UpstreamReplySchema.safeParse({ ...base, usage: {} }).success).toBe(true);
  });

  it('accepts null content, tool calls without an id and a null finish_reason', () => {
    expect(
      UpstreamReplySchema.safeParse({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ function: { name: 'n', arguments: '{}' } }],
            },
            finish_reason: null,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('ignores a malformed second choice', () => {
    expect(
      UpstreamReplySchema.safeParse({
        choices: [{ message: { content: 'hi' } }, 'junk', 7],
      }).success,
    ).toBe(true);
  });

  it('rejects a reply that cannot be read', () => {
    const bad: unknown[] = [
      null,
      'text',
      [],
      {},
      { choices: [] },
      { choices: [{}] },
      { choices: [{ message: { content: 5 } }] },
      { choices: [{ message: { tool_calls: [{ function: { name: 'n', arguments: {} } }] } }] },
      { choices: [{ message: { tool_calls: [{ function: { name: 7, arguments: '{}' } }] } }] },
      { choices: [{ message: { content: 'x' } }], usage: { total_tokens: 'many' } },
    ];
    for (const value of bad) {
      expect(UpstreamReplySchema.safeParse(value).success).toBe(false);
    }
  });

  it('rejects more than 100 tool calls', () => {
    const call = { function: { name: 'n', arguments: '{}' } };
    expect(
      UpstreamReplySchema.safeParse({
        choices: [{ message: { tool_calls: Array.from({ length: 101 }, () => call) } }],
      }).success,
    ).toBe(false);
  });
});

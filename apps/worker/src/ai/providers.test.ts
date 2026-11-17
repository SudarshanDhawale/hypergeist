import type { ChatRequest } from '@hypergeist/shared/ai-wire';
import { describe, expect, it } from 'vitest';
import { PROVIDER_NAMES, type ProviderName } from '../env';
import type { AiConfig, AiProviderConfig, ReasoningEffort } from '../lib/config';
import { adaptRequest, authHeaders, PROVIDER_TABLE } from './providers';

const SARVAM_KEY = 'test-secret-sarvam-0000';
const OPENAI_KEY = 'test-secret-openai-0000';

function provider(name: ProviderName, model: string, key: string): AiProviderConfig {
  return { name, key, model, toJSON: () => ({ name, model }) };
}

const SARVAM = provider('sarvam', 'sarvam-model', SARVAM_KEY);
const OPENAI = provider('openai', 'openai-model', OPENAI_KEY);

function makeConfig(
  overrides: {
    allowedModels?: readonly string[];
    maxOutputTokens?: number;
    reasoningEffort?: ReasoningEffort | null;
  } = {},
): AiConfig {
  const providers = [SARVAM, OPENAI];
  const config: AiConfig = {
    enabled: true,
    origins: ['https://hypergeist.example'],
    allowedModels: overrides.allowedModels ?? [],
    providers,
    visitorDailyCap: 60,
    dailyCap: 400,
    dailyTokenCap: 1_000_000,
    lifetimeCap: 6_000,
    lifetimeTokenCap: 6_000_000,
    maxOutputTokens: overrides.maxOutputTokens ?? 2_048,
    reasoningEffort: overrides.reasoningEffort ?? null,
    salt: 'test-salt-0000',
    toJSON: () => {
      throw new Error('not used');
    },
  };
  return config;
}

function makeRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'auto',
    messages: [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'add a card' },
    ],
    ...overrides,
  };
}

const TOOLS: NonNullable<ChatRequest['tools']> = [
  {
    type: 'function',
    function: {
      name: 'create_card',
      description: 'Create a card',
      parameters: { type: 'object', properties: { title: { type: 'string' } } },
    },
  },
];

describe('PROVIDER_TABLE', () => {
  it('has exactly the known providers', () => {
    expect(Object.keys(PROVIDER_TABLE).sort()).toEqual([...PROVIDER_NAMES].sort());
  });

  it('uses https URLs on exactly the two documented hosts', () => {
    const urls = PROVIDER_NAMES.map((name) => new URL(PROVIDER_TABLE[name].url));
    for (const url of urls) {
      expect(url.protocol).toBe('https:');
      expect(url.username).toBe('');
      expect(url.search).toBe('');
      expect(url.hash).toBe('');
    }
    expect(urls.map((url) => url.host).sort()).toEqual(['api.openai.com', 'api.sarvam.ai']);
    expect(PROVIDER_TABLE.sarvam.url).toBe('https://api.sarvam.ai/v2/chat/completions');
    expect(PROVIDER_TABLE.openai.url).toBe('https://api.openai.com/v1/chat/completions');
  });

  it('holds the documented token parameter and temperature rule per provider', () => {
    expect(PROVIDER_TABLE.sarvam.tokenParam).toBe('max_tokens');
    expect(PROVIDER_TABLE.sarvam.allowTemperature).toBe(true);
    expect(PROVIDER_TABLE.openai.tokenParam).toBe('max_completion_tokens');
    expect(PROVIDER_TABLE.openai.allowTemperature).toBe(false);
  });
});

describe('adaptRequest: sarvam', () => {
  it('builds the body with max_tokens, clamped temperature and no reasoning_effort', () => {
    const request = makeRequest({
      tools: TOOLS,
      tool_choice: 'auto',
      temperature: 1.7,
      max_tokens: 500,
    });
    const body = adaptRequest(SARVAM, request, makeConfig({ reasoningEffort: 'low' }), {
      isFirst: true,
    });
    expect(body).toEqual({
      model: 'sarvam-model',
      messages: request.messages,
      tools: TOOLS,
      tool_choice: 'auto',
      stream: false,
      max_tokens: 500,
      temperature: 1,
    });
    expect('reasoning_effort' in body).toBe(false);
    expect('max_completion_tokens' in body).toBe(false);
  });

  it('keeps a temperature inside 0 to 1 and handles the edges', () => {
    const config = makeConfig();
    expect(adaptRequest(SARVAM, makeRequest({ temperature: 0.3 }), config)['temperature']).toBe(
      0.3,
    );
    expect(adaptRequest(SARVAM, makeRequest({ temperature: 0 }), config)['temperature']).toBe(0);
    expect(adaptRequest(SARVAM, makeRequest({ temperature: 2 }), config)['temperature']).toBe(1);
    const negative = { ...makeRequest(), temperature: -0.5 } as ChatRequest;
    expect(adaptRequest(SARVAM, negative, config)['temperature']).toBe(0);
  });

  it('omits temperature when the request has none or a non-finite one', () => {
    const config = makeConfig();
    expect('temperature' in adaptRequest(SARVAM, makeRequest(), config)).toBe(false);
    const nan = { ...makeRequest(), temperature: Number.NaN } as ChatRequest;
    expect('temperature' in adaptRequest(SARVAM, nan, config)).toBe(false);
  });
});

describe('adaptRequest: openai', () => {
  it('uses max_completion_tokens and sends no max_tokens and no temperature', () => {
    const request = makeRequest({ temperature: 0.5, max_tokens: 300 });
    const body = adaptRequest(OPENAI, request, makeConfig());
    expect(body['max_completion_tokens']).toBe(300);
    expect('max_tokens' in body).toBe(false);
    expect('temperature' in body).toBe(false);
    expect('reasoning_effort' in body).toBe(false);
    expect(body['model']).toBe('openai-model');
    expect(body['stream']).toBe(false);
  });

  it.each(['minimal', 'low', 'medium', 'high'] as const)(
    'sends reasoning_effort %s when configured',
    (effort) => {
      const body = adaptRequest(OPENAI, makeRequest(), makeConfig({ reasoningEffort: effort }));
      expect(body['reasoning_effort']).toBe(effort);
    },
  );
});

describe('adaptRequest: output limit', () => {
  it('clamps a client max_tokens above the configured limit', () => {
    const config = makeConfig({ maxOutputTokens: 1_000 });
    expect(adaptRequest(SARVAM, makeRequest({ max_tokens: 100_000 }), config)['max_tokens']).toBe(
      1_000,
    );
    expect(
      adaptRequest(OPENAI, makeRequest({ max_tokens: 1_001 }), config)['max_completion_tokens'],
    ).toBe(1_000);
  });

  it('uses the configured limit when the client sends none', () => {
    const config = makeConfig({ maxOutputTokens: 777 });
    expect(adaptRequest(SARVAM, makeRequest(), config)['max_tokens']).toBe(777);
    expect(adaptRequest(OPENAI, makeRequest(), config)['max_completion_tokens']).toBe(777);
  });

  it('keeps a smaller client value and never goes below 1', () => {
    const config = makeConfig();
    expect(adaptRequest(SARVAM, makeRequest({ max_tokens: 5 }), config)['max_tokens']).toBe(5);
    const zero = { ...makeRequest(), max_tokens: 0 } as ChatRequest;
    expect(adaptRequest(SARVAM, zero, config)['max_tokens']).toBe(1);
    const negative = { ...makeRequest(), max_tokens: -10 } as ChatRequest;
    expect(adaptRequest(OPENAI, negative, config)['max_completion_tokens']).toBe(1);
  });
});

describe('adaptRequest: model selection', () => {
  const config = makeConfig({ allowedModels: ['custom-model'] });

  it('uses the configured model for auto', () => {
    expect(
      adaptRequest(SARVAM, makeRequest({ model: 'auto' }), config, { isFirst: true })['model'],
    ).toBe('sarvam-model');
  });

  it('uses an allowlisted name for the first provider only', () => {
    const request = makeRequest({ model: 'custom-model' });
    expect(adaptRequest(SARVAM, request, config, { isFirst: true })['model']).toBe('custom-model');
    expect(adaptRequest(OPENAI, request, config, { isFirst: false })['model']).toBe('openai-model');
    expect(adaptRequest(OPENAI, request, config)['model']).toBe('openai-model');
  });

  it('ignores a name that is not on the allowlist', () => {
    const request = makeRequest({ model: 'other-model' });
    expect(adaptRequest(SARVAM, request, config, { isFirst: true })['model']).toBe('sarvam-model');
  });

  it('never selects a model when the allowlist is empty', () => {
    const request = makeRequest({ model: 'custom-model' });
    expect(adaptRequest(SARVAM, request, makeConfig(), { isFirst: true })['model']).toBe(
      'sarvam-model',
    );
  });
});

describe('adaptRequest: pass-through and isolation', () => {
  it('sets stream to false even if the request says nothing', () => {
    expect(adaptRequest(SARVAM, makeRequest(), makeConfig())['stream']).toBe(false);
  });

  it('forwards messages and tools as the same values and does not mutate them', () => {
    const request = makeRequest({ tools: TOOLS, tool_choice: 'none' });
    const before = structuredClone(request);
    const body = adaptRequest(SARVAM, request, makeConfig());
    expect(body['messages']).toBe(request.messages);
    expect(body['tools']).toBe(request.tools);
    expect(body['tool_choice']).toBe('none');
    expect(request).toEqual(before);
  });

  it('omits tools and tool_choice when the request has none', () => {
    const body = adaptRequest(OPENAI, makeRequest(), makeConfig());
    expect('tools' in body).toBe(false);
    expect('tool_choice' in body).toBe(false);
  });

  it('adds no message of its own', () => {
    const request = makeRequest();
    const body = adaptRequest(SARVAM, request, makeConfig());
    expect(body['messages']).toHaveLength(request.messages.length);
  });

  it('does not leak extra fields cast into the request', () => {
    const hostile = {
      ...makeRequest({ tools: TOOLS }),
      n: 5,
      stop: ['x'],
      logit_bias: { '1': 100 },
      response_format: { type: 'json_object' },
      user: 'someone',
      parallel_tool_calls: true,
      frequency_penalty: 2,
      max_completion_tokens: 99_999,
      reasoning_effort: 'high',
      api_key: 'leak-me',
    } as unknown as ChatRequest;
    for (const [target, isFirst] of [
      [SARVAM, true],
      [OPENAI, false],
    ] as const) {
      const body = adaptRequest(target, hostile, makeConfig(), { isFirst });
      const allowed = new Set([
        'model',
        'messages',
        'tools',
        'tool_choice',
        'stream',
        'max_tokens',
        'max_completion_tokens',
        'temperature',
        'reasoning_effort',
      ]);
      for (const key of Object.keys(body)) {
        expect(allowed.has(key)).toBe(true);
      }
      for (const key of [
        'n',
        'stop',
        'logit_bias',
        'response_format',
        'user',
        'parallel_tool_calls',
        'frequency_penalty',
        'api_key',
      ]) {
        expect(key in body).toBe(false);
      }
      // An extra max_completion_tokens or reasoning_effort in the request does not pass through.
      expect(
        body['max_completion_tokens'] === undefined || body['max_completion_tokens'] === 2_048,
      ).toBe(true);
      expect('reasoning_effort' in body).toBe(false);
    }
  });

  it('never puts a key into the body', () => {
    const request = makeRequest({ tools: TOOLS, temperature: 0.4 });
    const config = makeConfig({ reasoningEffort: 'medium' });
    for (const target of [SARVAM, OPENAI]) {
      const text = JSON.stringify(adaptRequest(target, request, config, { isFirst: true }));
      expect(text).not.toContain(SARVAM_KEY);
      expect(text).not.toContain(OPENAI_KEY);
    }
  });
});

describe('authHeaders', () => {
  it('sends Authorization Bearer and the extra header for sarvam', () => {
    expect(authHeaders('sarvam', SARVAM_KEY)).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${SARVAM_KEY}`,
      'api-subscription-key': SARVAM_KEY,
    });
  });

  it('sends only Authorization Bearer for openai', () => {
    const headers = authHeaders('openai', OPENAI_KEY);
    expect(headers).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${OPENAI_KEY}`,
    });
    expect('api-subscription-key' in headers).toBe(false);
  });

  it('returns a new object on every call', () => {
    expect(authHeaders('openai', OPENAI_KEY)).not.toBe(authHeaders('openai', OPENAI_KEY));
  });
});

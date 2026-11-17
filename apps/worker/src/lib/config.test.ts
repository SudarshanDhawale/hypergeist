import { describe, expect, it } from 'vitest';
import { PROVIDER_BINDINGS, PROVIDER_NAMES, type Env } from '../env';
import { BOUNDS, DEFAULTS, parseConfig, type AiConfig } from './config';

const SARVAM_KEY = 'test-secret-sarvam-0000';
const OPENAI_KEY = 'test-secret-openai-1111';
const SALT = 'test-secret-salt-2222';

const SECRETS = [SARVAM_KEY, OPENAI_KEY, SALT] as const;

/** The smallest environment that parses: Sarvam only, no optional var. */
function baseEnv(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    AI_ALLOWED_ORIGINS: 'https://hypergeist.example',
    AI_SARVAM_MODEL: 'sarvam-test-model',
    SARVAM_API_KEY: SARVAM_KEY,
    QUOTA_SALT: SALT,
    ...extra,
  };
}

function parseOk(env: Readonly<Record<string, unknown>>): AiConfig {
  const result = parseConfig(env);
  if (!result.ok) {
    throw new Error('expected the configuration to parse');
  }
  return result.config;
}

function without(env: Record<string, unknown>, name: string): Record<string, unknown> {
  const copy = { ...env };
  delete copy[name];
  return copy;
}

describe('parseConfig: defaults', () => {
  it('fills every optional value from DEFAULTS', () => {
    const config = parseOk(baseEnv());
    expect(config.enabled).toBe(DEFAULTS.enabled);
    expect(config.visitorDailyCap).toBe(60);
    expect(config.dailyCap).toBe(400);
    expect(config.dailyTokenCap).toBe(1_000_000);
    expect(config.lifetimeCap).toBe(6_000);
    expect(config.lifetimeTokenCap).toBe(6_000_000);
    expect(config.maxOutputTokens).toBe(2_048);
    expect(config.allowedModels).toEqual([]);
    expect(config.reasoningEffort).toBeNull();
    expect(config.origins).toEqual(['https://hypergeist.example']);
    expect(config.salt).toBe(SALT);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.name).toBe('sarvam');
    expect(config.providers[0]?.key).toBe(SARVAM_KEY);
    expect(config.providers[0]?.model).toBe('sarvam-test-model');
  });

  it('pins the DEFAULTS constant', () => {
    expect(DEFAULTS).toEqual({
      visitorDailyCap: 60,
      dailyCap: 400,
      dailyTokenCap: 1_000_000,
      lifetimeCap: 6_000,
      lifetimeTokenCap: 6_000_000,
      maxOutputTokens: 2_048,
      providers: 'sarvam',
      enabled: true,
    });
  });

  it('accepts an Env-typed value and ignores other bindings', () => {
    const env: Env = {
      ASSETS: {} as Fetcher,
      QUOTA: {} as DurableObjectNamespace,
      AI_BURST: {} as RateLimit,
      AI_ALLOWED_ORIGINS: 'https://hypergeist.example',
      AI_SARVAM_MODEL: 'sarvam-test-model',
      SARVAM_API_KEY: SARVAM_KEY,
      QUOTA_SALT: SALT,
    };
    expect(parseConfig(env).ok).toBe(true);
  });

  it('exposes the provider names and their secret and model var names', () => {
    expect(PROVIDER_NAMES).toEqual(['sarvam', 'openai']);
    expect(PROVIDER_BINDINGS.sarvam).toEqual({
      keyVar: 'SARVAM_API_KEY',
      modelVar: 'AI_SARVAM_MODEL',
    });
    expect(PROVIDER_BINDINGS.openai).toEqual({
      keyVar: 'OPENAI_API_KEY',
      modelVar: 'AI_OPENAI_MODEL',
    });
  });

  it('does not mutate its input and returns frozen values', () => {
    const env = Object.freeze(baseEnv({ AI_ALLOWED_MODELS: 'a,b' }));
    const before = JSON.stringify(env);
    const config = parseOk(env);
    expect(JSON.stringify(env)).toBe(before);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.origins)).toBe(true);
    expect(Object.isFrozen(config.providers)).toBe(true);
    expect(Object.isFrozen(config.providers[0])).toBe(true);
  });

  it('is deterministic', () => {
    const env = baseEnv({ AI_DAILY_CAP: '12' });
    expect(JSON.stringify(parseConfig(env))).toBe(JSON.stringify(parseConfig(env)));
  });

  it('keeps explicit values and trims whitespace around numbers', () => {
    const config = parseOk(
      baseEnv({
        AI_VISITOR_DAILY_CAP: ' 5 ',
        AI_DAILY_CAP: '10',
        AI_DAILY_TOKEN_CAP: '20',
        AI_LIFETIME_CAP: '30',
        AI_LIFETIME_TOKEN_CAP: '40',
        AI_MAX_OUTPUT_TOKENS: '512',
      }),
    );
    expect(config.visitorDailyCap).toBe(5);
    expect(config.dailyCap).toBe(10);
    expect(config.dailyTokenCap).toBe(20);
    expect(config.lifetimeCap).toBe(30);
    expect(config.lifetimeTokenCap).toBe(40);
    expect(config.maxOutputTokens).toBe(512);
  });
});

describe('parseConfig: numeric bounds', () => {
  const CAP_VARS = [
    ['AI_VISITOR_DAILY_CAP', 'visitorDailyCap'],
    ['AI_DAILY_CAP', 'dailyCap'],
    ['AI_DAILY_TOKEN_CAP', 'dailyTokenCap'],
    ['AI_LIFETIME_CAP', 'lifetimeCap'],
    ['AI_LIFETIME_TOKEN_CAP', 'lifetimeTokenCap'],
  ] as const;

  describe.each(CAP_VARS)('%s', (name, field) => {
    it('accepts the lower and upper edge', () => {
      expect(parseOk(baseEnv({ [name]: '1' }))[field]).toBe(1);
      expect(parseOk(baseEnv({ [name]: '10000000' }))[field]).toBe(BOUNDS.capMax);
    });

    it('rejects just outside the edges', () => {
      expect(parseConfig(baseEnv({ [name]: '0' }))).toEqual({ ok: false });
      expect(parseConfig(baseEnv({ [name]: '10000001' }))).toEqual({ ok: false });
    });
  });

  it('bounds AI_MAX_OUTPUT_TOKENS to 1 through 4096', () => {
    expect(parseOk(baseEnv({ AI_MAX_OUTPUT_TOKENS: '1' })).maxOutputTokens).toBe(1);
    expect(parseOk(baseEnv({ AI_MAX_OUTPUT_TOKENS: '4096' })).maxOutputTokens).toBe(4096);
    expect(parseConfig(baseEnv({ AI_MAX_OUTPUT_TOKENS: '0' })).ok).toBe(false);
    expect(parseConfig(baseEnv({ AI_MAX_OUTPUT_TOKENS: '4097' })).ok).toBe(false);
  });

  const BAD_NUMBERS: readonly unknown[] = [
    'abc',
    '1.5',
    '1.0',
    '-1',
    '-0',
    '+5',
    '1e3',
    '0x10',
    '5 5',
    '5,000',
    'NaN',
    'Infinity',
    '\uFF11\uFF12', // full-width digits
    '123456789', // nine digits
    '',
    '   ',
    5, // a JSON number is not a string
    null,
    true,
    {},
    [],
  ];

  it.each(BAD_NUMBERS.map((value) => [JSON.stringify(value) ?? String(value), value] as const))(
    'rejects a non-numeric or malformed number: %s',
    (_label, value) => {
      for (const name of ['AI_DAILY_CAP', 'AI_MAX_OUTPUT_TOKENS']) {
        expect(parseConfig(baseEnv({ [name]: value }))).toEqual({ ok: false });
      }
    },
  );

  it('treats an undefined numeric var as missing (default)', () => {
    expect(parseOk(baseEnv({ AI_DAILY_CAP: undefined })).dailyCap).toBe(400);
  });
});

describe('parseConfig: required values', () => {
  it.each([undefined, '', '   ', 5, null])('rejects QUOTA_SALT %j', (value) => {
    expect(parseConfig(baseEnv({ QUOTA_SALT: value }))).toEqual({ ok: false });
  });

  it('rejects a missing QUOTA_SALT', () => {
    expect(parseConfig(without(baseEnv(), 'QUOTA_SALT'))).toEqual({ ok: false });
  });

  it('trims the salt', () => {
    expect(parseOk(baseEnv({ QUOTA_SALT: `  ${SALT}\n` })).salt).toBe(SALT);
  });

  it.each([undefined, '', '   ', ',', ' , ', 5, null])('rejects AI_ALLOWED_ORIGINS %j', (value) => {
    expect(parseConfig(baseEnv({ AI_ALLOWED_ORIGINS: value }))).toEqual({ ok: false });
  });

  it('rejects a missing AI_ALLOWED_ORIGINS', () => {
    expect(parseConfig(without(baseEnv(), 'AI_ALLOWED_ORIGINS'))).toEqual({ ok: false });
  });
});

describe('parseConfig: AI_ALLOWED_ORIGINS', () => {
  it.each([
    'https://hypergeist.example',
    'https://app.hypergeist.example:8443',
    'https://hypergeist.pages.dev',
    'https://localhost:5173',
    'http://localhost',
    'http://localhost:8787',
    'http://localhost:5173',
    'http://127.0.0.1',
    'http://127.0.0.1:8787',
  ])('accepts %s', (origin) => {
    expect(parseOk(baseEnv({ AI_ALLOWED_ORIGINS: origin })).origins).toEqual([origin]);
  });

  it.each([
    'hypergeist.example',
    'ftp://hypergeist.example',
    'http://hypergeist.example', // plain http only for loopback
    'http://localhost.evil.example',
    'http://192.168.0.1',
    'http://[::1]:8787',
    'https://hypergeist.example/',
    'https://hypergeist.example/app',
    'https://hypergeist.example?x=1',
    'https://hypergeist.example#x',
    'https://user@hypergeist.example',
    'https://user:pass@hypergeist.example',
    'https://HYPERGEIST.example',
    'https://hypergeist.example:443',
    'http://localhost:80',
    'https://hypergeist.example:99999',
    'https://',
    'https://exa mple.com',
    '*',
    'null',
  ])('rejects %s', (origin) => {
    expect(parseConfig(baseEnv({ AI_ALLOWED_ORIGINS: origin }))).toEqual({ ok: false });
  });

  it('parses a comma list with spaces, keeps order, and drops duplicates', () => {
    const config = parseOk(
      baseEnv({
        AI_ALLOWED_ORIGINS:
          ' https://hypergeist.example , http://localhost:8787,http://localhost:5173, https://hypergeist.example ',
      }),
    );
    expect(config.origins).toEqual([
      'https://hypergeist.example',
      'http://localhost:8787',
      'http://localhost:5173',
    ]);
  });

  it('rejects the whole list when one entry is bad or empty', () => {
    expect(parseConfig(baseEnv({ AI_ALLOWED_ORIGINS: 'https://hypergeist.example,nope' })).ok).toBe(
      false,
    );
    expect(parseConfig(baseEnv({ AI_ALLOWED_ORIGINS: 'https://hypergeist.example,' })).ok).toBe(
      false,
    );
    expect(parseConfig(baseEnv({ AI_ALLOWED_ORIGINS: ',https://hypergeist.example' })).ok).toBe(
      false,
    );
  });
});

describe('parseConfig: AI_ALLOWED_MODELS', () => {
  it.each([undefined, '', '   '])('means no extra models for %j', (value) => {
    expect(parseOk(baseEnv({ AI_ALLOWED_MODELS: value })).allowedModels).toEqual([]);
  });

  it('parses a trimmed, de-duplicated list', () => {
    const config = parseOk(baseEnv({ AI_ALLOWED_MODELS: ' gpt-4.1-mini , sarvam-m,gpt-4.1-mini' }));
    expect(config.allowedModels).toEqual(['gpt-4.1-mini', 'sarvam-m']);
  });

  it.each(['a,,b', 'a,', ',a', 'has space', 'a b,c', `${'x'.repeat(101)}`, 5, null])(
    'rejects %j',
    (value) => {
      expect(parseConfig(baseEnv({ AI_ALLOWED_MODELS: value }))).toEqual({ ok: false });
    },
  );

  it('accepts a 100-character name', () => {
    const name = 'x'.repeat(100);
    expect(parseOk(baseEnv({ AI_ALLOWED_MODELS: name })).allowedModels).toEqual([name]);
  });
});

describe('parseConfig: providers', () => {
  const bothEnv = (extra: Record<string, unknown> = {}) =>
    baseEnv({
      AI_PROVIDERS: 'sarvam,openai',
      OPENAI_API_KEY: OPENAI_KEY,
      AI_OPENAI_MODEL: 'openai-test-model',
      ...extra,
    });

  it('parses two providers in the listed order, with whitespace', () => {
    const config = parseOk(bothEnv({ AI_PROVIDERS: ' sarvam , openai ' }));
    expect(config.providers.map((p) => p.name)).toEqual(['sarvam', 'openai']);
    expect(config.providers[1]?.key).toBe(OPENAI_KEY);
    expect(config.providers[1]?.model).toBe('openai-test-model');

    const reversed = parseOk(bothEnv({ AI_PROVIDERS: 'openai, sarvam' }));
    expect(reversed.providers.map((p) => p.name)).toEqual(['openai', 'sarvam']);
  });

  it('supports openai alone and then needs no Sarvam key or model', () => {
    const env = {
      AI_ALLOWED_ORIGINS: 'https://hypergeist.example',
      AI_PROVIDERS: 'openai',
      OPENAI_API_KEY: OPENAI_KEY,
      AI_OPENAI_MODEL: 'openai-test-model',
      QUOTA_SALT: SALT,
    };
    const config = parseOk(env);
    expect(config.providers).toHaveLength(1);
    expect(config.providers[0]?.name).toBe('openai');
  });

  it('ignores an unlisted provider whose key is malformed', () => {
    expect(parseConfig(baseEnv({ OPENAI_API_KEY: 'has space', AI_OPENAI_MODEL: '' })).ok).toBe(
      true,
    );
  });

  it.each([
    '',
    '  ',
    'groq',
    'gemini',
    'Sarvam',
    'OPENAI',
    'sarvam,groq',
    'sarvam,',
    ',sarvam',
    'sarvam,,openai',
    'sarvam;openai',
  ])('rejects AI_PROVIDERS %j', (value) => {
    expect(parseConfig(bothEnv({ AI_PROVIDERS: value }))).toEqual({ ok: false });
  });

  it('rejects duplicates and more than two providers', () => {
    expect(parseConfig(bothEnv({ AI_PROVIDERS: 'sarvam,sarvam' })).ok).toBe(false);
    expect(parseConfig(bothEnv({ AI_PROVIDERS: 'sarvam,openai,sarvam' })).ok).toBe(false);
    expect(parseConfig(bothEnv({ AI_PROVIDERS: 'sarvam,openai,openai' })).ok).toBe(false);
  });

  it('rejects a non-string AI_PROVIDERS', () => {
    expect(parseConfig(bothEnv({ AI_PROVIDERS: ['sarvam'] })).ok).toBe(false);
    expect(parseConfig(bothEnv({ AI_PROVIDERS: null })).ok).toBe(false);
  });

  it('rejects a listed provider with no key, an empty key, or a bad key', () => {
    for (const value of [
      undefined,
      '',
      '   ',
      'has space',
      'tab\there',
      'new\nline',
      5,
      null,
      'x'.repeat(513),
    ]) {
      expect(parseConfig(baseEnv({ SARVAM_API_KEY: value }))).toEqual({ ok: false });
      expect(parseConfig(bothEnv({ OPENAI_API_KEY: value }))).toEqual({ ok: false });
    }
  });

  it('rejects a listed provider with no model or an empty or bad model', () => {
    for (const value of [undefined, '', '   ', 'has space', 'a,b', 5, null, 'x'.repeat(101)]) {
      expect(parseConfig(baseEnv({ AI_SARVAM_MODEL: value }))).toEqual({ ok: false });
      expect(parseConfig(bothEnv({ AI_OPENAI_MODEL: value }))).toEqual({ ok: false });
    }
  });

  it('trims key and model', () => {
    const config = parseOk(
      baseEnv({ SARVAM_API_KEY: ` ${SARVAM_KEY}\n`, AI_SARVAM_MODEL: ' m-1 ' }),
    );
    expect(config.providers[0]?.key).toBe(SARVAM_KEY);
    expect(config.providers[0]?.model).toBe('m-1');
  });

  it('fails when the second listed provider is incomplete', () => {
    expect(parseConfig(without(bothEnv(), 'OPENAI_API_KEY')).ok).toBe(false);
    expect(parseConfig(without(bothEnv(), 'AI_OPENAI_MODEL')).ok).toBe(false);
  });
});

describe('parseConfig: AI_REASONING_EFFORT', () => {
  it.each([undefined, '', '   '])('is null for %j', (value) => {
    expect(parseOk(baseEnv({ AI_REASONING_EFFORT: value })).reasoningEffort).toBeNull();
  });

  it.each(['minimal', 'low', 'medium', 'high'] as const)('accepts %s', (value) => {
    expect(parseOk(baseEnv({ AI_REASONING_EFFORT: value })).reasoningEffort).toBe(value);
    expect(parseOk(baseEnv({ AI_REASONING_EFFORT: ` ${value} ` })).reasoningEffort).toBe(value);
  });

  it.each(['none', 'High', 'LOW', 'max', 'low,high', '1', 5, null, true])('rejects %j', (value) => {
    expect(parseConfig(baseEnv({ AI_REASONING_EFFORT: value }))).toEqual({ ok: false });
  });
});

describe('parseConfig: AI_ENABLED', () => {
  it.each(['false', 'FALSE', ' False ', false])(
    'disables for %j and still returns a config',
    (value) => {
      const result = parseConfig(baseEnv({ AI_ENABLED: value }));
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.enabled).toBe(false);
      }
    },
  );

  it.each([undefined, 'true', 'TRUE', '', '0', 'no', 'off', 'yes', '1', true, null, 0])(
    'means enabled for %j',
    (value) => {
      expect(parseOk(baseEnv({ AI_ENABLED: value })).enabled).toBe(true);
    },
  );
});

describe('parseConfig: never throws', () => {
  it('handles an empty environment and odd values', () => {
    expect(parseConfig({})).toEqual({ ok: false });
    for (const value of [undefined, null, 0, '', [], {}, () => 1, Symbol('x'), 10n]) {
      const env = {
        AI_ENABLED: value,
        AI_ALLOWED_ORIGINS: value,
        AI_ALLOWED_MODELS: value,
        AI_PROVIDERS: value,
        AI_DAILY_CAP: value,
        QUOTA_SALT: value,
        SARVAM_API_KEY: value,
        AI_SARVAM_MODEL: value,
      };
      expect(() => parseConfig(env)).not.toThrow();
    }
  });
});

describe('parseConfig: secrets never leak', () => {
  it('a failed parse is exactly { ok: false } with no detail', () => {
    const result = parseConfig(baseEnv({ AI_DAILY_CAP: 'not-a-number' }));
    expect(result).toEqual({ ok: false });
    expect(Object.keys(result)).toEqual(['ok']);
    expect(JSON.stringify(result)).toBe('{"ok":false}');
  });

  it('a failed parse that held every secret mentions none of them or any field name', () => {
    const results = [
      parseConfig({
        ...baseEnv({
          AI_PROVIDERS: 'sarvam,openai',
          OPENAI_API_KEY: OPENAI_KEY,
          AI_OPENAI_MODEL: '',
        }),
      }),
      parseConfig(baseEnv({ AI_DAILY_CAP: SALT })),
      parseConfig(baseEnv({ AI_ALLOWED_ORIGINS: SARVAM_KEY })),
      parseConfig(baseEnv({ AI_REASONING_EFFORT: OPENAI_KEY })),
      parseConfig(baseEnv({ AI_PROVIDERS: SARVAM_KEY })),
    ];
    for (const result of results) {
      expect(result.ok).toBe(false);
      const text = JSON.stringify(result);
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret);
      }
      expect(text).not.toMatch(/AI_|KEY|SALT|issue|path|message/);
    }
  });

  it('JSON.stringify of a good config contains no key and no salt', () => {
    const config = parseOk(
      baseEnv({
        AI_PROVIDERS: 'sarvam,openai',
        OPENAI_API_KEY: OPENAI_KEY,
        AI_OPENAI_MODEL: 'openai-test-model',
      }),
    );
    for (const text of [
      JSON.stringify(config),
      JSON.stringify({ ok: true, config }),
      JSON.stringify(parseConfig(baseEnv())),
      JSON.stringify(config.providers),
      JSON.stringify([config.providers[0]]),
      JSON.stringify({ nested: { config } }),
    ]) {
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it('the logged shape keeps the harmless fields', () => {
    const config = parseOk(baseEnv({ AI_DAILY_CAP: '7' }));
    const logged: unknown = JSON.parse(JSON.stringify(config));
    expect(logged).toEqual({
      enabled: true,
      origins: ['https://hypergeist.example'],
      allowedModels: [],
      providers: [{ name: 'sarvam', model: 'sarvam-test-model' }],
      visitorDailyCap: 60,
      dailyCap: 7,
      dailyTokenCap: 1_000_000,
      lifetimeCap: 6_000,
      lifetimeTokenCap: 6_000_000,
      maxOutputTokens: 2_048,
      reasoningEffort: null,
    });
  });

  it('a spread copy still redacts, because toJSON is an own property', () => {
    const config = parseOk(baseEnv());
    const text = JSON.stringify({ ...config });
    for (const secret of SECRETS) {
      expect(text).not.toContain(secret);
    }
  });
});

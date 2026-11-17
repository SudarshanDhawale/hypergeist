/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PublicReplySchema } from '@hypergeist/shared/ai-wire';
import { describe, expect, it } from 'vitest';
import { createMemoryQuotaClient } from './ai/quota-client';
import { createMemoryKv } from './ai/quota-logic';
import type { Deps } from './ai/deps';
import { app, buildApp } from './app';
import { DEFAULTS } from './lib/config';
import type { LogEntry } from './lib/log';

function corsHeaderNames(response: Response): string[] {
  const names: string[] = [];
  response.headers.forEach((_value, name) => {
    if (name.toLowerCase().startsWith('access-control-')) {
      names.push(name);
    }
  });
  return names;
}

describe('worker app smoke test', () => {
  it('GET /api/health responds 200 with { ok: true }', async () => {
    const response = await app.request('/api/health');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('GET /api/unknown responds 404 with the generic error body', async () => {
    const response = await app.request('/api/unknown');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('POST /api/health responds 404 with the generic error body', async () => {
    const response = await app.request('/api/health', { method: 'POST' });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });

  it('adds no access-control-* header to any response', async () => {
    const responses = await Promise.all([
      app.request('/api/health'),
      app.request('/api/unknown'),
      app.request('/api/health', { method: 'POST' }),
      app.request('/api/health', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://example.com',
          'access-control-request-method': 'GET',
        },
      }),
      app.request('/api/health', { headers: { origin: 'https://example.com' } }),
    ]);

    for (const response of responses) {
      expect(corsHeaderNames(response)).toEqual([]);
    }
  });
});

// ---- AI routes ---------------------------------------------------------------

const ORIGIN = 'http://localhost:8787';
const FAKE_ENV = {
  AI_ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
  AI_PROVIDERS: 'sarvam',
  AI_SARVAM_MODEL: 'sarvam-model',
  SARVAM_API_KEY: 'test-secret-sarvam-0000',
  QUOTA_SALT: 'test-secret-salt-0000',
};

function fakeDeps(): { deps: Partial<Deps>; upstream: string[]; logs: LogEntry[] } {
  const upstream: string[] = [];
  const logs: LogEntry[] = [];
  const deps: Partial<Deps> = {
    now: () => Date.UTC(2026, 10, 15, 12, 0, 0),
    fetch: (input) => {
      upstream.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
            usage: { total_tokens: 7 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    },
    limiter: { limit: () => Promise.resolve({ success: true }) },
    quota: createMemoryQuotaClient(createMemoryKv()),
    log: (entry) => {
      logs.push(entry);
    },
  };
  return { deps, upstream, logs };
}

function chatInit(overrides: Record<string, string> = {}): RequestInit {
  return {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'content-type': 'application/json',
      'cf-connecting-ip': '203.0.113.7',
      ...overrides,
    },
    body: JSON.stringify({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] }),
  };
}

function expectAiHeaders(response: Response): void {
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(corsHeaderNames(response)).toEqual([]);
}

describe('worker app: AI routes', () => {
  it('buildApp() without bindings imports and serves health without touching bindings', async () => {
    const response = await buildApp().request('/api/health');
    expect(response.status).toBe(200);
  });

  it('serves a full chat request end to end with fake dependencies', async () => {
    const { deps, upstream, logs } = fakeDeps();
    const response = await buildApp(deps).request('/api/ai/chat', chatInit(), FAKE_ENV);

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(PublicReplySchema.safeParse(body).success).toBe(true);
    expect(JSON.stringify(body)).toContain('hello');
    expect(upstream).toHaveLength(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.route).toBe('chat');
    expectAiHeaders(response);
  });

  it('serves the quota route with the same headers', async () => {
    const { deps } = fakeDeps();
    const response = await buildApp(deps).request(
      '/api/ai/quota',
      { headers: { origin: ORIGIN, 'cf-connecting-ip': '203.0.113.7' } },
      FAKE_ENV,
    );

    expect(response.status).toBe(200);
    expectAiHeaders(response);
  });

  it('adds the headers to error responses of the chat route', async () => {
    const { deps, upstream } = fakeDeps();
    const forbidden = await buildApp(deps).request(
      '/api/ai/chat',
      chatInit({ origin: 'https://evil.example' }),
      FAKE_ENV,
    );
    const disabled = await buildApp(deps).request('/api/ai/chat', chatInit(), {
      ...FAKE_ENV,
      AI_ENABLED: 'false',
    });

    expect(forbidden.status).toBe(403);
    expect(disabled.status).toBe(503);
    expectAiHeaders(forbidden);
    expectAiHeaders(disabled);
    expect(upstream).toEqual([]);
  });

  it.each([
    ['GET', '/api/ai/chat'],
    ['PUT', '/api/ai/chat'],
    ['DELETE', '/api/ai/chat'],
    ['OPTIONS', '/api/ai/chat'],
    ['POST', '/api/ai/quota'],
    ['DELETE', '/api/ai/quota'],
    ['GET', '/api/ai/unknown'],
    ['POST', '/api/ai/'],
  ])('%s %s gives the generic 404 with the AI headers', async (method, path) => {
    const { deps, upstream } = fakeDeps();
    const response = await buildApp(deps).request(
      path,
      { method, headers: { origin: ORIGIN } },
      FAKE_ENV,
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
    expectAiHeaders(response);
    expect(upstream).toEqual([]);
  });

  it('answers an unexpected exception with the generic 500 body and the AI headers', async () => {
    const { deps } = fakeDeps();
    const throwing: Partial<Deps> = {
      ...deps,
      log: () => {
        throw new Error('test-secret-boom');
      },
    };
    const response = await buildApp(throwing).request('/api/ai/chat', chatInit(), FAKE_ENV);
    const text = await response.text();

    expect(text).not.toContain('test-secret-');
    expectAiHeaders(response);
  });

  it('keeps the plain health route free of the AI headers', async () => {
    const response = await app.request('/api/health');
    expect(response.headers.get('cache-control')).toBeNull();
  });
});

// ---- wrangler.jsonc and .dev.vars.example ---------------------------------------

/** Removes `//` and `/* *\/` comments outside strings, then trailing commas outside strings. */
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') {
        j += text.charAt(j) === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  // Trailing commas: a comma followed only by whitespace and a closing bracket (strings are
  // skipped by matching them first).
  return out.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (match, closing: string | undefined) =>
    closing === undefined ? match : closing,
  );
}

function readText(relative: string): string {
  return readFileSync(resolve(import.meta.dirname, relative), 'utf8');
}

function readWrangler(): Record<string, unknown> {
  return JSON.parse(stripJsonc(readText('../wrangler.jsonc'))) as Record<string, unknown>;
}

describe('wrangler.jsonc', () => {
  const config = readWrangler();
  const vars = config['vars'] as Record<string, string>;

  it('keeps the asset settings and declares the bindings', () => {
    expect(config['main']).toBe('src/index.ts');
    expect(config['durable_objects']).toEqual({
      bindings: [{ name: 'QUOTA', class_name: 'QuotaStore' }],
    });
    expect(config['migrations']).toEqual([{ tag: 'v1', new_sqlite_classes: ['QuotaStore'] }]);
    expect(config['ratelimits']).toEqual([
      { name: 'AI_BURST', namespace_id: '1001', simple: { limit: 10, period: 60 } },
    ]);
  });

  it('has cap and default vars equal to DEFAULTS', () => {
    expect(vars['AI_VISITOR_DAILY_CAP']).toBe(String(DEFAULTS.visitorDailyCap));
    expect(vars['AI_DAILY_CAP']).toBe(String(DEFAULTS.dailyCap));
    expect(vars['AI_DAILY_TOKEN_CAP']).toBe(String(DEFAULTS.dailyTokenCap));
    expect(vars['AI_LIFETIME_CAP']).toBe(String(DEFAULTS.lifetimeCap));
    expect(vars['AI_LIFETIME_TOKEN_CAP']).toBe(String(DEFAULTS.lifetimeTokenCap));
    expect(vars['AI_MAX_OUTPUT_TOKENS']).toBe(String(DEFAULTS.maxOutputTokens));
    expect(vars['AI_PROVIDERS']).toBe(DEFAULTS.providers);
    expect(vars['AI_ENABLED']).toBe(String(DEFAULTS.enabled));
  });

  it('leaves the model ids empty so the AI stays disabled until they are set', () => {
    expect(vars['AI_SARVAM_MODEL']).toBe('');
    expect(vars['AI_OPENAI_MODEL']).toBe('');
  });

  it('holds no secret and no value that looks like a key', () => {
    const text = readText('../wrangler.jsonc');
    expect(text).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
    expect(text).not.toMatch(/[A-Za-z0-9_-]{32,}/);
    for (const name of ['SARVAM_API_KEY', 'OPENAI_API_KEY', 'QUOTA_SALT']) {
      expect(Object.keys(vars)).not.toContain(name);
    }
    for (const value of Object.values(vars)) {
      expect(value).not.toMatch(/^[A-Za-z0-9_-]{24,}$/);
    }
  });

  it('is parsed correctly by the JSONC helper (comments, trailing commas, strings)', () => {
    const parsed = JSON.parse(
      stripJsonc('{ "a": "x // y, ]", /* c */ "b": [1, 2,], // end\n }'),
    ) as unknown;
    expect(parsed).toEqual({ a: 'x // y, ]', b: [1, 2] });
  });
});

describe('secret files', () => {
  it('lists .dev.vars in .gitignore', () => {
    const lines = readText('../../../.gitignore')
      .split('\n')
      .map((line) => line.trim());
    expect(lines).toContain('.dev.vars');
  });

  it('has names only in .dev.vars.example', () => {
    const lines = readText('../.dev.vars.example')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'));
    expect(lines).toEqual(['SARVAM_API_KEY=', 'OPENAI_API_KEY=', 'QUOTA_SALT=']);
    for (const line of lines) {
      expect(line).toMatch(/^[A-Z0-9_]+=$/);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { app } from './app';

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

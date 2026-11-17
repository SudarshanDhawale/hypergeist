import { Hono } from 'hono';
import { handleChat } from './ai/chat-route';
import { defaultDeps, type Deps } from './ai/deps';
import { handleQuota } from './ai/quota-route';
import type { Env } from './env';

/**
 * Builds the Worker app. Tests pass `overrides` (fake clock, fetch, limiter, quota, log) and
 * get the same routes and headers as production.
 */
export function buildApp(overrides?: Partial<Deps>): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  // Built per request: a test that has no bindings can import the app without a crash, and the
  // bindings of one request are never shared with another.
  const resolveDeps = (env: Env): Deps => ({ ...defaultDeps(env), ...overrides });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Every response under `/api/ai/` (success, error and 404) is never cached and never sniffed.
  // No CORS header is added: the browser app and the Worker share one origin.
  app.use('/api/ai/*', async (c, next) => {
    await next();
    c.res.headers.set('cache-control', 'no-store');
    c.res.headers.set('x-content-type-options', 'nosniff');
  });

  app.post('/api/ai/chat', (c) => handleChat(c.req.raw, c.env, resolveDeps(c.env)));
  app.get('/api/ai/quota', (c) => handleQuota(c.req.raw, c.env, resolveDeps(c.env)));

  app.notFound((c) => c.json({ error: 'Not found' }, 404));

  // Generic body only: never echo the error message or stack to the client.
  app.onError((_err, c) => c.json({ error: 'Internal error' }, 500));

  return app;
}

export const app = buildApp();

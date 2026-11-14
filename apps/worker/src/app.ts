import { Hono } from 'hono';

export const app = new Hono();

app.get('/api/health', (c) => c.json({ ok: true }));

app.notFound((c) => c.json({ error: 'Not found' }, 404));

// Generic body only: never echo the error message or stack to the client.
app.onError((_err, c) => c.json({ error: 'Internal error' }, 500));

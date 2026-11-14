import { expect, test } from '@playwright/test';

test('home page shows the heading and contacts only the app origin', async ({ page, baseURL }) => {
  expect(baseURL).toBeTruthy();
  const appOrigin = new URL(baseURL ?? '').origin;

  const requestUrls: string[] = [];
  page.on('request', (request) => {
    requestUrls.push(request.url());
  });

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'HyperGeist' })).toBeVisible();
  await page.waitForLoadState('networkidle');

  expect(requestUrls.length).toBeGreaterThan(0);
  const origins = requestUrls.map((url) => new URL(url).origin);
  expect(origins.filter((origin) => origin !== appOrigin)).toEqual([]);
});

test('GET /api/health returns 200 and { ok: true }', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test('unknown page falls back to the SPA and unknown API route returns a JSON 404', async ({
  page,
  request,
}) => {
  await page.goto('/some/unknown/path');
  await expect(page.getByRole('heading', { name: 'HyperGeist' })).toBeVisible();

  const response = await request.get('/api/nope');
  expect(response.status()).toBe(404);
  expect(response.headers()['content-type']).toContain('application/json');
  expect(await response.json()).toEqual({ error: 'Not found' });
});

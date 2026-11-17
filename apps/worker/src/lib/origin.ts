/**
 * Same-origin check for the AI proxy routes.
 *
 * This check stops other websites from using the hosted key through a visitor's
 * browser. It does not stop a script that forges headers: anyone can send a
 * request with any `Origin` value from outside a browser. The real protection
 * against a script is the per-visitor, daily and lifetime limits.
 *
 * Rules:
 * - `Origin` must be present, non-empty and equal (exact, case-sensitive string
 *   match) to one of the allowed origins.
 * - One trailing slash is trimmed from each configured entry. The request's
 *   `Origin` value is never altered.
 * - When `Sec-Fetch-Site` is present, it must be `same-origin`.
 * - An empty allowed list never matches.
 */
export function checkOrigin(headers: Headers, allowedOrigins: readonly string[]): boolean {
  const origin = headers.get('origin');
  if (origin === null || origin === '') {
    return false;
  }

  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return false;
  }

  return allowedOrigins.some((entry) => trimOneTrailingSlash(entry) === origin);
}

function trimOneTrailingSlash(entry: string): string {
  return entry.endsWith('/') ? entry.slice(0, -1) : entry;
}

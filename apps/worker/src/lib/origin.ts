/**
 * Same-origin check for the AI proxy routes.
 *
 * This check stops other websites from using the hosted key through a visitor's
 * browser. It does not stop a script that forges headers: anyone can send a
 * request with any `Origin` or `Sec-Fetch-Site` value from outside a browser.
 * The real protection against a script is the per-visitor, daily and lifetime limits.
 *
 * Rules:
 * - With an `Origin` header present (non-empty): it must equal (exact,
 *   case-sensitive string match) one of the allowed origins. One trailing slash
 *   is trimmed from each configured entry; the request's `Origin` value is
 *   never altered. When `Sec-Fetch-Site` is present, it must be `same-origin`.
 * - Without an `Origin` (missing or empty): browsers do not send `Origin` on
 *   same-origin `GET` and `HEAD` requests, so those pass only when `method` is
 *   `GET` or `HEAD` (case-insensitive), `Sec-Fetch-Site` is present and equals
 *   `same-origin`, and the allowed list is not empty. Any other method (such as
 *   `POST`) without an `Origin` is rejected.
 * - An empty allowed list never matches.
 */
export function checkOrigin(
  headers: Headers,
  allowedOrigins: readonly string[],
  method: string,
): boolean {
  const origin = headers.get('origin');
  const fetchSite = headers.get('sec-fetch-site');

  if (origin === null || origin === '') {
    if (allowedOrigins.length === 0) {
      return false;
    }
    const upper = method.toUpperCase();
    return (upper === 'GET' || upper === 'HEAD') && fetchSite === 'same-origin';
  }

  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return false;
  }

  return allowedOrigins.some((entry) => trimOneTrailingSlash(entry) === origin);
}

function trimOneTrailingSlash(entry: string): string {
  return entry.endsWith('/') ? entry.slice(0, -1) : entry;
}

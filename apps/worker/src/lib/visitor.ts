const UNKNOWN_IP = 'unknown';
const KEY_LENGTH = 32;

/**
 * Derives a daily, salted, anonymous key for a visitor.
 *
 * The key is the first 32 lowercase hex characters of SHA-256 over
 * `${ip}|${date}|${salt}`. A null, undefined or blank IP (after trimming)
 * becomes the fixed string `unknown`. The date is the UTC date supplied by the
 * caller, so the key changes daily. The IP and the salt are never part of the
 * result, so the key can be stored and logged without keeping the address.
 *
 * Pure apart from the Web Crypto digest: no clock and no environment access.
 */
export async function visitorKey(
  ip: string | null | undefined,
  salt: string,
  date: string,
): Promise<string> {
  const trimmed = ip?.trim() ?? '';
  const address = trimmed === '' ? UNKNOWN_IP : trimmed;
  const input = new TextEncoder().encode(`${address}|${date}|${salt}`);
  const digest = await crypto.subtle.digest('SHA-256', input);
  let hex = '';
  for (const byte of new Uint8Array(digest)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex.slice(0, KEY_LENGTH);
}

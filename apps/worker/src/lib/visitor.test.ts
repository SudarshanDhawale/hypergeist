import { describe, expect, it } from 'vitest';
import { visitorKey } from './visitor';

const IP = '203.0.113.7';
const SALT = 'test-secret-salt-0000';
const DATE = '2026-11-15';

describe('visitorKey', () => {
  it('returns 32 lowercase hex characters', async () => {
    const key = await visitorKey(IP, SALT, DATE);

    expect(key).toHaveLength(32);
    expect(key).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic', async () => {
    expect(await visitorKey(IP, SALT, DATE)).toBe(await visitorKey(IP, SALT, DATE));
  });

  it('matches the first 32 hex characters of SHA-256 over ip|date|salt', async () => {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(`${IP}|${DATE}|${SALT}`),
    );
    const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 32);

    expect(await visitorKey(IP, SALT, DATE)).toBe(expected);
  });

  it('differs by ip', async () => {
    expect(await visitorKey('203.0.113.7', SALT, DATE)).not.toBe(
      await visitorKey('203.0.113.8', SALT, DATE),
    );
  });

  it('differs by date', async () => {
    expect(await visitorKey(IP, SALT, '2026-11-15')).not.toBe(
      await visitorKey(IP, SALT, '2026-11-16'),
    );
  });

  it('differs by salt', async () => {
    expect(await visitorKey(IP, 'test-secret-salt-0000', DATE)).not.toBe(
      await visitorKey(IP, 'test-secret-salt-0001', DATE),
    );
  });

  it('never contains the ip or the salt text', async () => {
    const ips = [IP, '2001:db8::7334'];
    for (const ip of ips) {
      const key = await visitorKey(ip, SALT, DATE);
      expect(key).not.toContain(ip);
      expect(key).not.toContain(SALT);
      expect(key).not.toContain(DATE);
    }
  });

  it('handles IPv6 addresses', async () => {
    const a = await visitorKey('2001:db8::7334', SALT, DATE);
    const b = await visitorKey('2001:db8::7335', SALT, DATE);

    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });

  it('trims the ip', async () => {
    expect(await visitorKey(`  ${IP}\t`, SALT, DATE)).toBe(await visitorKey(IP, SALT, DATE));
  });

  it('maps null, undefined, empty and blank ips to the same unknown key', async () => {
    const unknown = await visitorKey('unknown', SALT, DATE);

    expect(await visitorKey(null, SALT, DATE)).toBe(unknown);
    expect(await visitorKey(undefined, SALT, DATE)).toBe(unknown);
    expect(await visitorKey('', SALT, DATE)).toBe(unknown);
    expect(await visitorKey('   ', SALT, DATE)).toBe(unknown);
    expect(unknown).toMatch(/^[0-9a-f]{32}$/);
  });

  it('keeps the unknown key different from a real ip key', async () => {
    expect(await visitorKey(null, SALT, DATE)).not.toBe(await visitorKey(IP, SALT, DATE));
  });
});

import { describe, expect, it } from 'vitest';
import { readLimitedBody } from './body';

const LIMIT = 1024;

interface StreamHandle {
  request: Request;
  cancelled: () => boolean;
}

function streamRequest(
  pull: (controller: ReadableStreamDefaultController<Uint8Array>) => void,
  headers: Record<string, string> = {},
): StreamHandle {
  let wasCancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull,
    cancel() {
      wasCancelled = true;
    },
  });
  const init = { method: 'POST', body, headers, duplex: 'half' } as unknown as RequestInit;
  return {
    request: new Request('https://example.test/api/ai/chat', init),
    cancelled: () => wasCancelled,
  };
}

function chunksRequest(chunks: Uint8Array[], headers: Record<string, string> = {}): StreamHandle {
  let index = 0;
  return streamRequest((controller) => {
    const next = chunks[index];
    index += 1;
    if (next === undefined) {
      controller.close();
    } else {
      controller.enqueue(next);
    }
  }, headers);
}

function bytesOf(length: number, fill = 0x61): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

describe('readLimitedBody', () => {
  it('accepts a body of exactly the limit', async () => {
    const { request } = chunksRequest([bytesOf(LIMIT)]);
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: 'a'.repeat(LIMIT) });
  });

  it('rejects a body one byte over the limit and cancels the stream', async () => {
    const handle = chunksRequest([bytesOf(LIMIT), bytesOf(1)]);
    const result = await readLimitedBody(handle.request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(handle.cancelled()).toBe(true);
  });

  it('rejects a numeric content-length above the limit without reading', async () => {
    const { request } = chunksRequest([bytesOf(10)], { 'content-length': String(LIMIT + 1) });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    // Nothing took the stream, so no reader was ever attached to it.
    expect(request.body?.locked).toBe(false);
    expect(request.bodyUsed).toBe(false);
  });

  it('accepts a content-length equal to the limit', async () => {
    const { request } = chunksRequest([bytesOf(10)], { 'content-length': String(LIMIT) });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: 'a'.repeat(10) });
  });

  it('does not trust a content-length that understates the body', async () => {
    const handle = chunksRequest([bytesOf(LIMIT), bytesOf(LIMIT)], { 'content-length': '10' });
    const result = await readLimitedBody(handle.request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(handle.cancelled()).toBe(true);
  });

  it('does not trust a content-length that overstates a small body', async () => {
    const { request } = chunksRequest([bytesOf(5)], { 'content-length': String(LIMIT) });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: 'aaaaa' });
  });

  it.each(['abc', '-5', '', '1e9', '12.5', '0x10'])(
    'ignores a non-numeric or negative content-length (%j) and counts bytes',
    async (value) => {
      const { request } = chunksRequest([bytesOf(20)], { 'content-length': value });
      const result = await readLimitedBody(request, LIMIT);
      expect(result).toEqual({ ok: true, text: 'a'.repeat(20) });
    },
  );

  it('still enforces the limit by bytes when content-length is invalid', async () => {
    const { request } = chunksRequest([bytesOf(LIMIT + 1)], { 'content-length': '-1' });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('reads many tiny chunks and joins them', async () => {
    const chunks = Array.from({ length: LIMIT }, () => bytesOf(1, 0x62));
    const { request } = chunksRequest(chunks);
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: 'b'.repeat(LIMIT) });
  });

  it('rejects many tiny chunks that add up to over the limit', async () => {
    const chunks = Array.from({ length: LIMIT + 1 }, () => bytesOf(1));
    const handle = chunksRequest(chunks);
    const result = await readLimitedBody(handle.request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(handle.cancelled()).toBe(true);
  });

  it('stops reading at the limit instead of draining an endless stream', async () => {
    let pulls = 0;
    const handle = streamRequest((controller) => {
      pulls += 1;
      controller.enqueue(bytesOf(100));
    });
    const result = await readLimitedBody(handle.request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
    expect(handle.cancelled()).toBe(true);
    expect(pulls).toBeLessThan(50);
  });

  it('reports a stream that errors as unreadable', async () => {
    let index = 0;
    const { request } = streamRequest((controller) => {
      index += 1;
      if (index === 1) {
        controller.enqueue(bytesOf(5));
      } else {
        controller.error(new Error('secret upstream detail'));
      }
    });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reports a stream that errors on the first read as unreadable', async () => {
    const { request } = streamRequest((controller) => {
      controller.error(new Error('boom'));
    });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reports a non-byte chunk as unreadable', async () => {
    const body = new ReadableStream<unknown>({
      start(controller) {
        controller.enqueue('not bytes');
        controller.close();
      },
    });
    const init = { method: 'POST', body, duplex: 'half' } as unknown as RequestInit;
    const request = new Request('https://example.test/', init);
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('returns empty text for an empty stream body', async () => {
    const { request } = chunksRequest([]);
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: '' });
  });

  it('returns empty text for a request with no body', async () => {
    const request = new Request('https://example.test/api/ai/chat', { method: 'POST' });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: '' });
  });

  it('returns empty text for a GET request', async () => {
    const request = new Request('https://example.test/');
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: '' });
  });

  it('decodes a string body as UTF-8', async () => {
    const request = new Request('https://example.test/', { method: 'POST', body: 'héllo ✓' });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: 'héllo ✓' });
  });

  it('counts bytes, not characters', async () => {
    // 342 characters of 3 bytes each is 1026 bytes, over the limit of 1024.
    const request = new Request('https://example.test/', { method: 'POST', body: '✓'.repeat(342) });
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: false, reason: 'too-large' });
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const encoded = new TextEncoder().encode('✓');
    const { request } = chunksRequest([encoded.slice(0, 1), encoded.slice(1)]);
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: '✓' });
  });

  it('replaces invalid UTF-8 with replacement characters and does not throw', async () => {
    const { request } = chunksRequest([new Uint8Array([0x61, 0xff, 0xfe, 0x62])]);
    const result = await readLimitedBody(request, LIMIT);
    expect(result).toEqual({ ok: true, text: 'a\uFFFD\uFFFDb' });
  });

  it('returns unreadable when the body has already been consumed', async () => {
    const request = new Request('https://example.test/', { method: 'POST', body: 'x' });
    await request.text();
    const result = await readLimitedBody(request, LIMIT);
    expect(result.ok).toBe(false);
  });
});

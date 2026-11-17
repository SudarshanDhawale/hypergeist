export type BodyResult =
  { ok: true; text: string } | { ok: false; reason: 'too-large' | 'unreadable' };

const DIGITS_ONLY = /^\d+$/;

/**
 * Reads a request body as text without ever holding more than `maxBytes` plus
 * one chunk. A numeric `content-length` above the limit is rejected without
 * reading. The header is only a shortcut: the bytes actually read decide, so a
 * non-numeric, negative or lying header is ignored. Never throws.
 */
export async function readLimitedBody(request: Request, maxBytes: number): Promise<BodyResult> {
  try {
    const declared = request.headers.get('content-length');
    if (declared !== null) {
      const trimmed = declared.trim();
      if (DIGITS_ONLY.test(trimmed) && Number(trimmed) > maxBytes) {
        return { ok: false, reason: 'too-large' };
      }
    }

    const stream = request.body;
    if (stream === null) {
      return { ok: true, text: '' };
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = (await reader.read()) as {
          done: boolean;
          value: unknown;
        };
        if (done) {
          break;
        }
        if (!(value instanceof Uint8Array)) {
          await cancelQuietly(reader);
          return { ok: false, reason: 'unreadable' };
        }
        total += value.byteLength;
        if (total > maxBytes) {
          await cancelQuietly(reader);
          return { ok: false, reason: 'too-large' };
        }
        chunks.push(value);
      }
    } catch {
      await cancelQuietly(reader);
      return { ok: false, reason: 'unreadable' };
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      text: new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes),
    };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

async function cancelQuietly(reader: ReadableStreamDefaultReader): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // The stream is already broken or closed; there is nothing left to release.
  }
}

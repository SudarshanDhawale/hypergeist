import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadText } from './download-text.ts';

const createObjectURL = vi.fn<(blob: Blob) => string>(() => 'blob:test-url');
const revokeObjectURL = vi.fn<(url: string) => void>();

beforeEach(() => {
  vi.useFakeTimers();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  Object.defineProperty(URL, 'createObjectURL', { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('downloadText', () => {
  it('clicks a temporary anchor that points at a blob URL with the file name', () => {
    const seen: { href: string; download: string; connected: boolean }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      seen.push({ href: this.href, download: this.download, connected: this.isConnected });
    });

    downloadText('my-stack.hypergeist.json', '{"a":1}');

    expect(seen).toEqual([
      { href: 'blob:test-url', download: 'my-stack.hypergeist.json', connected: true },
    ]);
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('builds the blob from the text', async () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    downloadText('a.hypergeist.json', '{"hello":"world"}');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob?.type).toContain('application/json');
    expect(blob?.size).toBe(new TextEncoder().encode('{"hello":"world"}').length);
  });

  it('revokes the object URL after a delay, not at once', () => {
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    downloadText('a.hypergeist.json', '{}');
    expect(revokeObjectURL).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-url');
  });
});

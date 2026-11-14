import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = readFileSync(join(root, 'docs', 'assets-licenses.md'), 'utf8');

const rows: readonly (readonly string[])[] = text
  .split('\n')
  .filter((line) => line.startsWith('|'))
  .map((line) =>
    line
      .slice(1, line.endsWith('|') ? -1 : undefined)
      .split('|')
      .map((cell) => cell.trim()),
  );

function rowsFor(name: string): readonly (readonly string[])[] {
  return rows.filter((cells) => cells[0]?.startsWith(name));
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

describe('docs/assets-licenses.md', () => {
  it.each([
    ['Pixelify Sans', 'https://fontsource.org/fonts/pixelify-sans'],
    ['VT323', 'https://fontsource.org/fonts/vt323'],
  ])('has exactly one OFL row for %s', (name, url) => {
    const found = rowsFor(name);
    expect(found).toHaveLength(1);
    const [, source, license, usedIn, added] = found[0] ?? [];
    expect(source).toContain(url);
    expect(license).toBe('SIL Open Font License 1.1');
    expect(usedIn).toMatch(/Web_App/);
    expect(added).toMatch(datePattern);
  });

  it('has exactly one row stating the sleeping Ghost sprite is original project artwork', () => {
    const found = rowsFor('Sleeping Ghost sprite');
    expect(found).toHaveLength(1);
    const [, , license, usedIn, added] = found[0] ?? [];
    expect(license).toMatch(/original project artwork/i);
    expect(usedIn).toMatch(/Web_App/);
    expect(added).toMatch(datePattern);
  });
});

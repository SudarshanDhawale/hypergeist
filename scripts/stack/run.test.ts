import { describe, expect, it } from 'vitest';
import { run } from './run.ts';

const VALID_STACK = JSON.stringify({
  formatVersion: 1,
  id: 'tiny',
  name: 'Tiny',
  cardWidth: 512,
  cardHeight: 342,
  startCardId: 'home',
  cards: [{ id: 'home', name: 'Home', objects: [], links: [], onOpen: [] }],
});

const INVALID_STACK = JSON.stringify({
  formatVersion: 1,
  id: 'tiny',
  name: 'Tiny',
  cardWidth: 512,
  cardHeight: 342,
  startCardId: 'nowhere',
  cards: [{ id: 'home', name: 'Home', objects: [], links: [], onOpen: [] }],
});

const SIX_PROPERTIES = ['actual', 'code', 'expected', 'hint', 'message', 'path'];

function reader(files: Record<string, string>): (path: string) => string {
  return (path) => {
    const text = files[path];
    if (text === undefined) {
      throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
    }
    return text;
  };
}

describe('run: exit 0', () => {
  it('prints the indented result of a valid stack', () => {
    const result = run(['validate', 'ok.json'], reader({ 'ok.json': VALID_STACK }));
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      `${JSON.stringify({ valid: true, errors: [], truncated: false }, null, 2)}\n`,
    );
  });
});

describe('run: exit 1', () => {
  it('prints every error with the six properties for an invalid stack', () => {
    const result = run(['validate', 'bad.json'], reader({ 'bad.json': INVALID_STACK }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    const parsed: unknown = JSON.parse(result.stdout);
    expect(parsed).toMatchObject({ valid: false, truncated: false });
    const errors = (parsed as { errors: Record<string, unknown>[] }).errors;
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(Object.keys(error).sort()).toEqual(SIX_PROPERTIES);
    }
    expect(errors.map((error) => error['code'])).toContain('DANGLING_REFERENCE');
  });

  it('reports INVALID_JSON for text that is not JSON, passing the text unparsed', () => {
    const result = run(['validate', 'x.txt'], reader({ 'x.txt': 'not { json' }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    const parsed = JSON.parse(result.stdout) as { valid: boolean; errors: { code: string }[] };
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.code).toBe('INVALID_JSON');
  });
});

describe('run: exit 2', () => {
  const never = reader({});

  it.each([
    ['no arguments', []],
    ['a missing path', ['validate']],
    ['an empty path', ['validate', '']],
    ['another subcommand', ['check', 'a.json']],
    ['extra arguments', ['validate', 'a.json', 'b.json']],
  ])('prints one usage line and nothing to stdout for %s', (_label, argv) => {
    const result = run(argv, never);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('usage: pnpm stack validate <file>\n');
  });

  it('prints one read-error line and nothing to stdout for an unreadable file', () => {
    const result = run(['validate', 'missing.json'], never);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('stack: cannot read "missing.json": ENOENT\n');
  });

  it('keeps the read error on one line when the path holds a newline', () => {
    const result = run(['validate', 'a\nb.json'], never);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
  });

  it('falls back to UNKNOWN when the reader error has no code', () => {
    const result = run(['validate', 'a.json'], () => {
      throw new Error('boom');
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe('stack: cannot read "a.json": UNKNOWN\n');
  });
});

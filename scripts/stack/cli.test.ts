import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const demoStack = 'apps/web/src/stacks/thin-slice-todo.json';
const invalidStack = 'scripts/stack/fixtures/invalid-stack.json';
const notJson = 'scripts/stack/fixtures/not-json.txt';
const fixturesDirectory = 'scripts/stack/fixtures';

const SIX_PROPERTIES = ['actual', 'code', 'expected', 'hint', 'message', 'path'];
const USAGE_LINE = 'usage: pnpm stack validate <file>\n';

type CliRun = { readonly stdout: string; readonly stderr: string; readonly status: number | null };

/** Runs the real entry point in a child process from the repository root. */
function cli(...args: readonly string[]): CliRun {
  const child = spawnSync(
    process.execPath,
    ['--disable-warning=ExperimentalWarning', 'scripts/stack/cli.ts', ...args],
    { cwd: root, encoding: 'utf8', timeout: 30_000 },
  );
  if (child.error !== undefined) throw child.error;
  return { stdout: child.stdout, stderr: child.stderr, status: child.status };
}

type CliResult = {
  valid: boolean;
  errors: Record<string, unknown>[];
  truncated: boolean;
};

function parseResult(stdout: string): CliResult {
  expect(stdout.endsWith('\n')).toBe(true);
  return JSON.parse(stdout) as CliResult;
}

describe('stack CLI child process: exit 0', () => {
  it('prints a valid result for the Demo_Stack and nothing to stderr', () => {
    const result = cli('validate', demoStack);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(parseResult(result.stdout)).toEqual({ valid: true, errors: [], truncated: false });
  });
});

describe('stack CLI child process: exit 1', () => {
  it('prints errors with the six properties for the invalid fixture', () => {
    const result = cli('validate', invalidStack);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const parsed = parseResult(result.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors.length).toBeGreaterThan(0);
    for (const error of parsed.errors) {
      expect(Object.keys(error).sort()).toEqual(SIX_PROPERTIES);
    }
  });

  it('reports one INVALID_JSON error for the text fixture', () => {
    const result = cli('validate', notJson);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    const parsed = parseResult(result.stdout);
    expect(parsed.valid).toBe(false);
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.['code']).toBe('INVALID_JSON');
  });
});

describe('stack CLI child process: exit 2', () => {
  it.each([
    ['a missing file', 'scripts/stack/fixtures/does-not-exist.json', 'ENOENT'],
    ['a directory', fixturesDirectory, 'EISDIR'],
  ])('prints one read-error line and nothing to stdout for %s', (_label, file, code) => {
    const result = cli('validate', file);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(`stack: cannot read ${JSON.stringify(file)}: ${code}\n`);
  });

  it.each([
    ['missing arguments', []],
    ['a missing path', ['validate']],
    ['a wrong subcommand', ['check', demoStack]],
    ['extra arguments', ['validate', demoStack, demoStack]],
  ])('prints one usage line and nothing to stdout for %s', (_label, args) => {
    const result = cli(...args);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(USAGE_LINE);
  });
});

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFile, checkFiles } from './rules.ts';
import { collectFiles } from './scan.ts';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const violationsRoot = join(fixturesDir, 'violations');
const cleanRoot = join(fixturesDir, 'clean');

function summarize(
  violations: ReturnType<typeof checkFiles>,
): readonly { rule: string; file: string; specifier: string }[] {
  return violations.map(({ rule, file, specifier }) => ({ rule, file, specifier }));
}

describe('check-deps fixtures', () => {
  it('reports one violation per rule on the violations tree', async () => {
    const files = await collectFiles(violationsRoot);
    expect(files.map((f) => f.path)).toEqual([
      'apps/web/src/uses-worker.ts',
      'apps/worker/src/uses-shared-internals.ts',
      'packages/shared/src/lib/uses-app.ts',
    ]);

    // Sorted by file path.
    expect(summarize(checkFiles(files))).toEqual([
      {
        rule: 'cross-app-import',
        file: 'apps/web/src/uses-worker.ts',
        specifier: '@hypergeist/worker',
      },
      {
        rule: 'shared-internal-import',
        file: 'apps/worker/src/uses-shared-internals.ts',
        specifier: '@hypergeist/shared/src/engine/index',
      },
      {
        rule: 'shared-imports-app',
        file: 'packages/shared/src/lib/uses-app.ts',
        specifier: '../../../../apps/web/src/App',
      },
    ]);
  });

  it('reports no violations on the clean tree', async () => {
    const files = await collectFiles(cleanRoot);
    expect(files.map((f) => f.path)).toEqual([
      'apps/web/src/main.tsx',
      'apps/worker/src/index.ts',
      'packages/shared/src/index.ts',
    ]);
    expect(checkFiles(files)).toEqual([]);
  });
});

describe('check-deps import forms', () => {
  it('detects a dynamic import()', () => {
    const violations = checkFile({
      path: 'apps/web/src/lazy.ts',
      text: "export const load = () => import('@hypergeist/worker');\n",
    });
    expect(summarize(violations)).toEqual([
      { rule: 'cross-app-import', file: 'apps/web/src/lazy.ts', specifier: '@hypergeist/worker' },
    ]);
  });

  it('detects export * from', () => {
    const violations = checkFile({
      path: 'apps/worker/src/reexport.ts',
      text: "export * from '@hypergeist/web';\n",
    });
    expect(summarize(violations)).toEqual([
      {
        rule: 'cross-app-import',
        file: 'apps/worker/src/reexport.ts',
        specifier: '@hypergeist/web',
      },
    ]);
  });

  it('counts type-only imports as violations', () => {
    const violations = checkFile({
      path: 'apps/web/src/types.ts',
      text: "import type { Thing } from '@hypergeist/shared/src/thing';\n",
    });
    expect(summarize(violations)).toEqual([
      {
        rule: 'shared-internal-import',
        file: 'apps/web/src/types.ts',
        specifier: '@hypergeist/shared/src/thing',
      },
    ]);
  });

  it('reports the 1-based line of the offending import', () => {
    const violations = checkFile({
      path: 'apps/web/src/line.ts',
      text: "import 'react';\n\nimport '@hypergeist/worker';\n",
    });
    expect(violations.map((v) => v.line)).toEqual([3]);
  });

  it('allows the three public shared entry points', () => {
    const violations = checkFile({
      path: 'apps/web/src/ok.ts',
      text: [
        "import '@hypergeist/shared';",
        "import '@hypergeist/shared/format';",
        "import '@hypergeist/shared/engine';",
      ].join('\n'),
    });
    expect(violations).toEqual([]);
  });
});

describe('check-deps test-support exception', () => {
  const helper =
    "import { arbStack } from '../../../../packages/shared/test-support/arbitraries.ts';\n";

  it('lets an app test file import the shared test helpers', () => {
    for (const path of [
      'apps/web/src/persistence/x.property.test.ts',
      'apps/web/src/components/X.test.tsx',
      'apps/worker/src/x.test.ts',
    ]) {
      const depth = path.split('/').length - 1;
      const text = `import { arbStack } from '${'../'.repeat(depth)}packages/shared/test-support/arbitraries.ts';\n`;
      expect(checkFile({ path, text })).toEqual([]);
    }
  });

  it('still rejects the shared test helpers in non-test app code', () => {
    const violations = checkFile({ path: 'apps/web/src/persistence/x.ts', text: helper });
    expect(summarize(violations).map((v) => v.rule)).toEqual(['shared-internal-import']);
  });

  it('still rejects other shared internals in an app test file', () => {
    const violations = checkFile({
      path: 'apps/web/src/persistence/x.test.ts',
      text: "import { thing } from '../../../../packages/shared/src/engine/ids.ts';\n",
    });
    expect(summarize(violations).map((v) => v.rule)).toEqual(['shared-internal-import']);
  });

  it('still rejects a path that only starts like the test-support folder', () => {
    const violations = checkFile({
      path: 'apps/web/src/persistence/x.test.ts',
      text: "import { a } from '../../../../packages/shared/test-support-other/a.ts';\n",
    });
    expect(summarize(violations).map((v) => v.rule)).toEqual(['shared-internal-import']);
  });

  it('does not let shared code import app code through the exception', () => {
    const violations = checkFile({
      path: 'packages/shared/src/x.test.ts',
      text: "import { a } from '../../../apps/web/src/a.ts';\n",
    });
    expect(summarize(violations).map((v) => v.rule)).toEqual(['shared-imports-app']);
  });
});

describe('collectFiles walker', () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot !== undefined) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  async function put(root: string, relativePath: string): Promise<void> {
    const full = join(root, relativePath);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, 'export const x = 1;\n', 'utf8');
  }

  it('skips node_modules and dist and keeps only .ts and .tsx files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'check-deps-walker-'));
    tempRoot = root;

    await put(root, 'apps/web/src/keep.tsx');
    await put(root, 'apps/web/src/notes.md');
    await put(root, 'apps/web/node_modules/pkg/index.ts');
    await put(root, 'apps/web/dist/bundle.ts');
    await put(root, 'packages/shared/src/keep.ts');
    await put(root, 'packages/shared/node_modules/dep/index.ts');
    await put(root, 'packages/shared/dist/out.ts');

    const files = await collectFiles(root);
    expect(files.map((f) => f.path)).toEqual([
      'apps/web/src/keep.tsx',
      'packages/shared/src/keep.ts',
    ]);
  });
});

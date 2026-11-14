import { posix } from 'node:path';
import ts from 'typescript';

/**
 * Pure core of the dependency check. No file system access: callers pass in
 * repo-relative POSIX paths and file text.
 */

export type RuleId =
  | 'shared-imports-app' // packages/shared -> apps/*
  | 'cross-app-import' // apps/web <-> apps/worker
  | 'shared-internal-import'; // apps/* -> shared outside the public API

/** `path` is repo-relative with POSIX separators. */
export type SourceFile = { readonly path: string; readonly text: string };

export type Violation = {
  readonly rule: RuleId;
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  readonly specifier: string;
  readonly message: string;
};

export const SHARED_PUBLIC_ENTRY_POINTS: readonly string[] = [
  '@hypergeist/shared',
  '@hypergeist/shared/format',
  '@hypergeist/shared/engine',
];

type Owner = 'shared' | 'web' | 'worker';

type Target = {
  readonly owner: Owner;
  /** `package` for `@hypergeist/<name>[/...]`, `relative` for a path resolved from the importer. */
  readonly via: 'package' | 'relative';
};

const OWNER_DIRS: readonly (readonly [Owner, string])[] = [
  ['shared', 'packages/shared'],
  ['web', 'apps/web'],
  ['worker', 'apps/worker'],
];

const PACKAGE_SCOPE = '@hypergeist';

/** Returns the Owner of a normalized repo-relative path, or undefined when it has none. */
function ownerOfPath(repoPath: string): Owner | undefined {
  for (const [owner, dir] of OWNER_DIRS) {
    if (repoPath === dir || repoPath.startsWith(`${dir}/`)) return owner;
  }
  return undefined;
}

function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

/** Returns the line number (1-based) of the character at offset `pos`. */
function lineAt(text: string, pos: number): number {
  let line = 1;
  const end = Math.min(pos, text.length);
  for (let i = 0; i < end; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * Lists the module specifiers imported by `text`, in source order, with the 1-based
 * line on which each specifier appears. Covers `import ... from`, side-effect imports,
 * `export ... from`, `import('x')` and `require('x')` with string literals.
 */
export function extractSpecifiers(
  text: string,
): readonly { readonly specifier: string; readonly line: number }[] {
  const info = ts.preProcessFile(text, true, true);
  return [...info.importedFiles]
    .sort((a, b) => a.pos - b.pos)
    .map((ref) => ({ specifier: ref.fileName, line: lineAt(text, ref.pos) }));
}

function resolveTarget(importerPath: string, specifier: string): Target | undefined {
  if (isRelativeSpecifier(specifier)) {
    const resolved = posix.join(posix.dirname(importerPath), specifier);
    // A path that escapes the repo root is external.
    if (resolved === '..' || resolved.startsWith('../') || posix.isAbsolute(resolved)) {
      return undefined;
    }
    const owner = ownerOfPath(resolved);
    return owner === undefined ? undefined : { owner, via: 'relative' };
  }

  const parts = specifier.split('/');
  if (parts[0] === PACKAGE_SCOPE) {
    const name = parts[1];
    // Unknown @hypergeist/* names are external.
    if (name === 'shared' || name === 'web' || name === 'worker') {
      return { owner: name, via: 'package' };
    }
  }
  return undefined;
}

function classify(
  importer: Owner,
  target: Target,
  specifier: string,
): { readonly rule: RuleId; readonly message: string } | undefined {
  if (importer === 'shared') {
    if (target.owner === 'web' || target.owner === 'worker') {
      return {
        rule: 'shared-imports-app',
        message: `packages/shared must not import application code (apps/${target.owner})`,
      };
    }
    return undefined;
  }

  if (target.owner === 'shared') {
    const allowed = target.via === 'package' && SHARED_PUBLIC_ENTRY_POINTS.includes(specifier);
    if (allowed) return undefined;
    return {
      rule: 'shared-internal-import',
      message: `apps/${importer} must import the shared package only through ${SHARED_PUBLIC_ENTRY_POINTS.join(', ')}`,
    };
  }

  if (target.owner !== importer) {
    // importer and target are web and worker in some order.
    return {
      rule: 'cross-app-import',
      message: `apps/${importer} must not import apps/${target.owner}`,
    };
  }

  return undefined;
}

export function checkFile(file: SourceFile): readonly Violation[] {
  const importer = ownerOfPath(file.path);
  if (importer === undefined) return [];

  const violations: Violation[] = [];
  for (const { specifier, line } of extractSpecifiers(file.text)) {
    const target = resolveTarget(file.path, specifier);
    if (target === undefined) continue;
    const result = classify(importer, target, specifier);
    if (result === undefined) continue;
    violations.push({
      rule: result.rule,
      file: file.path,
      line,
      specifier,
      message: result.message,
    });
  }
  return violations;
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Checks every file and returns violations sorted by file, line, rule. */
export function checkFiles(files: readonly SourceFile[]): readonly Violation[] {
  const all = files.flatMap((file) => checkFile(file));
  return [...all].sort(
    (a, b) =>
      compareStrings(a.file, b.file) ||
      a.line - b.line ||
      compareStrings(a.rule, b.rule) ||
      // Tie-breakers keep the order total, so the result never depends on input order.
      compareStrings(a.specifier, b.specifier) ||
      compareStrings(a.message, b.message),
  );
}

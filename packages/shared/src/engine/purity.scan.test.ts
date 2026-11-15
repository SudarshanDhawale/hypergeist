import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Source scan for Requirement 10 (purity and environment independence), 1.5 and 5.14.
 *
 * Reads every non-test source file under `engine/` and `format/` and fails when it finds a
 * reference to an environment API (clock, randomness, timers, network, storage, DOM, Node) or an
 * import that breaks the layering rule. Comments are stripped and string contents are blanked
 * before the name scan, so prose and message text cannot trip it.
 */

const ENGINE_DIR = new URL('./', import.meta.url);
const FORMAT_DIR = new URL('../format/', import.meta.url);
const FORMAT_INDEX = new URL('../format/index.ts', import.meta.url);
const APPS_DIR = new URL('../../../../apps/', import.meta.url);

// --- Source scanner -------------------------------------------------------------------------

interface ScannedSource {
  /** Comments removed, string contents kept. Used to read import specifiers. */
  readonly kept: string;
  /** Comments removed, string and template text emptied. Used for the name scan. */
  readonly code: string;
  /** Text of every string, template chunk and regex-free literal found in code. */
  readonly strings: readonly string[];
}

const REGEX_PRECEDING_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_PRECEDING_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'void',
  'delete',
  'throw',
  'new',
  'else',
  'do',
]);

function precedesRegex(codeSoFar: string): boolean {
  const trimmed = codeSoFar.trimEnd();
  if (trimmed === '') return true;
  const last = trimmed.charAt(trimmed.length - 1);
  if (REGEX_PRECEDING_CHARS.includes(last)) return true;
  if (/[A-Za-z_$]/.test(last)) {
    const word = /[A-Za-z_$][\w$]*$/.exec(trimmed)?.[0] ?? '';
    return REGEX_PRECEDING_WORDS.has(word);
  }
  return false;
}

/** Splits TypeScript source into code and strings without a parser. Handles `//`, block comments, quotes, templates with `${}`, and regex literals. */
function scanSource(source: string): ScannedSource {
  let kept = '';
  let code = '';
  const strings: string[] = [];
  const templateDepths: number[] = [];
  let depth = 0;
  let i = 0;

  // `start` is the index just after the opening backtick or the closing brace of `${ }`.
  const readTemplate = (start: number): number => {
    let j = start;
    let text = '';
    while (j < source.length) {
      const c = source.charAt(j);
      if (c === '\\') {
        text += source.slice(j, j + 2);
        j += 2;
      } else if (c === '`') {
        strings.push(text);
        kept += `${text}\``;
        code += '`';
        return j + 1;
      } else if (c === '$' && source.charAt(j + 1) === '{') {
        strings.push(text);
        kept += `${text}\${`;
        code += '${';
        templateDepths.push(depth);
        depth += 1;
        return j + 2;
      } else {
        text += c;
        j += 1;
      }
    }
    strings.push(text);
    kept += text;
    return j;
  };

  while (i < source.length) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? source.length : end;
      kept += ' ';
      code += ' ';
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
      kept += ' ';
      code += ' ';
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < source.length && source.charAt(j) !== ch && source.charAt(j) !== '\n') {
        if (source.charAt(j) === '\\') {
          text += source.slice(j, j + 2);
          j += 2;
        } else {
          text += source.charAt(j);
          j += 1;
        }
      }
      strings.push(text);
      kept += `${ch}${text}${ch}`;
      code += `${ch}${ch}`;
      i = j + 1;
    } else if (ch === '`') {
      kept += '`';
      code += '`';
      i = readTemplate(i + 1);
    } else if (ch === '/' && precedesRegex(code)) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source.charAt(j) !== '\n') {
        const c = source.charAt(j);
        if (c === '\\') j += 2;
        else if (c === '[') {
          inClass = true;
          j += 1;
        } else if (c === ']') {
          inClass = false;
          j += 1;
        } else if (c === '/' && !inClass) break;
        else j += 1;
      }
      kept += source.slice(i, j + 1);
      code += '/ /';
      i = j + 1;
    } else if (ch === '{') {
      depth += 1;
      kept += ch;
      code += ch;
      i += 1;
    } else if (ch === '}') {
      const top = templateDepths[templateDepths.length - 1];
      if (top !== undefined && top === depth - 1) {
        templateDepths.pop();
        depth -= 1;
        kept += '}';
        code += '}';
        i = readTemplate(i + 1);
      } else {
        depth -= 1;
        kept += ch;
        code += ch;
        i += 1;
      }
    } else {
      kept += ch;
      code += ch;
      i += 1;
    }
  }
  return { kept, code, strings };
}

// --- Rules ----------------------------------------------------------------------------------

interface NameRule {
  readonly label: string;
  readonly pattern: RegExp;
}

// `(?<![\w$.])` keeps a property such as `entry.window` or `x.process` from matching, and
// `\b` keeps identifiers such as `updated` or `candidate` from matching `Date`.
const NAME_RULES: readonly NameRule[] = [
  { label: 'Date (Date.now, new Date())', pattern: /(?<![\w$.])Date\b/ },
  { label: 'Math.random', pattern: /(?<![\w$.])Math\s*\.\s*random\b/ },
  { label: 'crypto', pattern: /(?<![\w$.])crypto\b/ },
  { label: 'performance', pattern: /(?<![\w$.])performance\b/ },
  {
    label: 'timers (setTimeout, setInterval, setImmediate)',
    pattern: /(?<![\w$.])(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval)\b/,
  },
  { label: 'queueMicrotask', pattern: /(?<![\w$.])queueMicrotask\b/ },
  { label: 'fetch', pattern: /(?<![\w$.])fetch\b/ },
  { label: 'XMLHttpRequest', pattern: /(?<![\w$.])XMLHttpRequest\b/ },
  {
    label: 'storage (localStorage, sessionStorage, indexedDB)',
    pattern: /(?<![\w$.])(?:localStorage|sessionStorage|indexedDB)\b/,
  },
  { label: 'document', pattern: /(?<![\w$.])document\b/ },
  { label: 'window', pattern: /(?<![\w$.])window\b/ },
  { label: 'navigator', pattern: /(?<![\w$.])navigator\b/ },
  { label: 'process', pattern: /(?<![\w$.])process\b/ },
  { label: 'require(', pattern: /(?<![\w$.])require\s*\(/ },
  { label: 'TextEncoder/TextDecoder', pattern: /(?<![\w$.])Text(?:En|De)coder\b/ },
  { label: 'Buffer', pattern: /(?<![\w$.])Buffer\b/ },
];

const NODE_BUILTINS = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'os',
  'path',
  'stream',
  'url',
  'util',
  'worker_threads',
  'zlib',
]);

/** Names found in comment-free code with string contents blanked. */
function findNameViolations(scanned: ScannedSource): string[] {
  return NAME_RULES.filter((rule) => rule.pattern.test(scanned.code)).map((rule) => rule.label);
}

/** Every module specifier in static imports, re-exports and `import()` calls. */
function findImportSpecifiers(scanned: ScannedSource): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /\b(?:import|export)\b[^'"`;]*?\bfrom\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*(['"])([^'"\n]+)\1/g,
    /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of scanned.kept.matchAll(pattern)) {
      const specifier = match[2];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

function isNodeSpecifier(specifier: string): boolean {
  return specifier.startsWith('node:') || NODE_BUILTINS.has(specifier);
}

function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** Layering violations of one file. `strictFormat` applies the engine-only rule on `format/`. */
function findImportViolations(
  scanned: ScannedSource,
  fileUrl: URL,
  strictFormat: boolean,
): string[] {
  const violations: string[] = [];
  for (const specifier of findImportSpecifiers(scanned)) {
    if (isNodeSpecifier(specifier)) {
      violations.push(`imports Node module "${specifier}"`);
    }
    if (/(^|\/)apps\//.test(specifier) || specifier.startsWith('@hypergeist/web')) {
      violations.push(`imports from apps/ ("${specifier}")`);
    }
    if (isRelative(specifier)) {
      const target = new URL(specifier, fileUrl);
      if (target.href.startsWith(APPS_DIR.href)) {
        violations.push(`imports from apps/ ("${specifier}")`);
      }
      if (
        strictFormat &&
        target.href.startsWith(FORMAT_DIR.href) &&
        target.href !== FORMAT_INDEX.href
      ) {
        violations.push(`imports a format/ internal ("${specifier}"), use ../format/index.ts`);
      }
    }
  }
  for (const text of scanned.strings) {
    if (text.startsWith('node:')) violations.push(`contains the string "${text}"`);
  }
  return violations;
}

// --- File discovery -------------------------------------------------------------------------

function isTestFile(name: string): boolean {
  return /\.test\.tsx?$/.test(name);
}

function listSourceFiles(dir: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(new URL(`${entry.name}/`, dir)));
    } else if (/\.tsx?$/.test(entry.name) && !isTestFile(entry.name)) {
      files.push(new URL(entry.name, dir));
    }
  }
  return files;
}

function relativeName(fileUrl: URL): string {
  const marker = '/packages/shared/src/';
  const index = fileUrl.pathname.indexOf(marker);
  return index === -1 ? fileUrl.pathname : fileUrl.pathname.slice(index + marker.length);
}

interface ScannedFile {
  readonly name: string;
  readonly url: URL;
  readonly scanned: ScannedSource;
  readonly strictFormat: boolean;
}

function scanDirectory(dir: URL, strictFormat: boolean): ScannedFile[] {
  return listSourceFiles(dir).map((url) => ({
    name: relativeName(url),
    url,
    scanned: scanSource(readFileSync(url, 'utf8')),
    strictFormat,
  }));
}

// --- Tests ----------------------------------------------------------------------------------

describe('purity source scan: scanner behavior', () => {
  const names = (source: string): string[] => findNameViolations(scanSource(source));

  it('finds each forbidden environment reference in code', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['const t = Date.now();', 'Date'],
      ['const d = new Date(0);', 'Date'],
      ['const r = Math.random();', 'Math.random'],
      ['crypto.randomUUID();', 'crypto'],
      ['performance.now();', 'performance'],
      ['setTimeout(f, 1);', 'timers'],
      ['setInterval(f, 1);', 'timers'],
      ['await fetch(url);', 'fetch'],
      ['new XMLHttpRequest();', 'XMLHttpRequest'],
      ['localStorage.getItem(k);', 'storage'],
      ['sessionStorage.clear();', 'storage'],
      ['indexedDB.open(n);', 'storage'],
      ['document.title;', 'document'],
      ['window.alert(1);', 'window'],
      ['navigator.userAgent;', 'navigator'],
      ['process.env.X;', 'process'],
      ['const fs = require("fs");', 'require('],
      ['new TextEncoder().encode(s);', 'TextEncoder'],
      ['Buffer.from(s);', 'Buffer'],
    ];
    for (const [source, label] of cases) {
      const found = names(source);
      expect(
        found.some((entry) => entry.includes(label)),
        source,
      ).toBe(true);
    }
  });

  it('does not trip on look-alike identifiers, properties, comments or strings', () => {
    const clean = [
      'const updated = 1; const candidate = 2; const dateLabel = "x";',
      'const x = entry.window + entry.process + obj.fetch;',
      '// Date.now() and Math.random() are forbidden here',
      '/* setTimeout(f); window.document; */ const a = 1;',
      'const message = "Date.now and fetch and process are not used";',
      "const url = 'https://example.com/window';",
      'const t = `text with Date and ${a + b} inside`;',
      'const re = /["\']window["\']/; const b = 1;',
      'const half = total / 2; const other = total / count;',
    ];
    for (const source of clean) {
      expect(names(source), source).toEqual([]);
    }
  });

  it('still finds code that follows a string, a template and a regex literal', () => {
    expect(names('const a = "x"; Date.now();')).not.toEqual([]);
    expect(names('const a = `${x}`; Date.now();')).not.toEqual([]);
    expect(names('const a = /ab+c/g; Date.now();')).not.toEqual([]);
    expect(names('const a = `x ${Date.now()} y`;')).not.toEqual([]);
  });

  it('reads import specifiers and flags Node and apps/ imports', () => {
    const url = new URL('./probe.ts', ENGINE_DIR);
    const violations = (source: string, strict = true): string[] =>
      findImportViolations(scanSource(source), url, strict);

    expect(violations("import { readFileSync } from 'node:fs';")).not.toEqual([]);
    expect(violations("import { join } from 'path';")).not.toEqual([]);
    expect(violations("export * from 'node:url';")).not.toEqual([]);
    expect(violations("const m = await import('node:fs');")).not.toEqual([]);
    expect(violations("import { x } from '../../../apps/web/src/x.ts';")).not.toEqual([]);
    expect(violations("import { x } from 'apps/web';")).not.toEqual([]);
    expect(violations("import { x } from '../format/validate.ts';")).not.toEqual([]);
    expect(violations("import { x } from '../format/validate.ts';", false)).toEqual([]);
    expect(violations("import { x } from '../format/index.ts';")).toEqual([]);
    expect(violations("import type { S } from '../format/index.ts';")).toEqual([]);
    expect(violations("import { z } from 'zod';")).toEqual([]);
    expect(violations('// import fs from "node:fs";')).toEqual([]);
  });
});

describe('purity source scan: engine/ and format/ production files', () => {
  const engineFiles = scanDirectory(ENGINE_DIR, true);
  const formatFiles = scanDirectory(FORMAT_DIR, false);
  const allFiles = [...engineFiles, ...formatFiles];

  it('finds the production files and skips test files', () => {
    const names = allFiles.map((file) => file.name);
    expect(names).toContain('engine/execute-handler.ts');
    expect(names).toContain('engine/operations/index.ts');
    expect(names).toContain('format/validate.ts');
    expect(names).toContain('format/text.ts');
    expect(names.filter((name) => /\.test\.tsx?$/.test(name))).toEqual([]);
    expect(engineFiles.length).toBeGreaterThan(10);
    expect(formatFiles.length).toBeGreaterThan(10);
  });

  it('references no environment API (clock, randomness, timers, network, storage, DOM, Node)', () => {
    const violations = allFiles.flatMap((file) =>
      findNameViolations(file.scanned).map((label) => `${file.name}: ${label}`),
    );
    expect(violations).toEqual([]);
  });

  it('imports no Node module and nothing from apps/', () => {
    const violations = allFiles.flatMap((file) =>
      findImportViolations(file.scanned, file.url, file.strictFormat)
        .filter((message) => !message.startsWith('imports a format/ internal'))
        .map((message) => `${file.name}: ${message}`),
    );
    expect(violations).toEqual([]);
  });

  it('engine files import only ../format/index.ts from the format package', () => {
    const violations = engineFiles.flatMap((file) =>
      findImportViolations(file.scanned, file.url, true)
        .filter((message) => message.startsWith('imports a format/ internal'))
        .map((message) => `${file.name}: ${message}`),
    );
    expect(violations).toEqual([]);
  });
});

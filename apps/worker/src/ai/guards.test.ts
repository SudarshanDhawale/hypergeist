/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { AI_WIRE_LIMITS, ChatRequestSchema } from '@hypergeist/shared/ai-wire';
import { describe, expect, it } from 'vitest';
import { readLimitedBody } from '../lib/body';

/*
 * Guard tests for the AI proxy: the CPU budget of request validation, a scan of the repository
 * for key-shaped strings, and the configuration files that keep secrets out of git.
 *
 * Feature: worker-backend. Validates: Requirements 2.6, 6.1, 6.4, 6.5.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../../..');

// ---- CPU budget -------------------------------------------------------------------

const WARM_UPS = 5;
const RUNS = 20;
/** The Workers Free plan allows 10 ms of CPU per request. */
const BUDGET_MS = 10;

/** Deterministic filler text so that the body does not compress into a trivial shape. */
function filler(length: number, seed: number): string {
  const words = ['stack', 'card', 'button', 'field', 'list', 'morning', 'note', 'plan', 'study'];
  let out = '';
  let state = seed;
  while (out.length < length) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    out += `${words[state % words.length] ?? 'x'} `;
  }
  return out.slice(0, length);
}

/** A nested JSON Schema of realistic shape and size (about 3 KB) for one tool. */
function toolParameters(index: number): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let i = 0; i < 8; i += 1) {
    properties[`field_${i}`] = {
      type: 'object',
      description: filler(60, index * 31 + i),
      properties: {
        id: { type: 'string', pattern: '^[a-z0-9][a-z0-9_-]{0,63}$' },
        kind: { type: 'string', enum: ['button', 'field', 'image', 'list', 'ai-field'] },
        label: { type: 'string', maxLength: 200 },
        items: { type: 'array', items: { type: 'string' }, maxItems: 50 },
      },
      required: ['id', 'kind'],
      additionalProperties: false,
    };
  }
  return { type: 'object', properties, required: ['field_0'], additionalProperties: false };
}

function buildMaxRequest(): { text: string; bytes: number } {
  const tools = Array.from({ length: AI_WIRE_LIMITS.maxTools }, (_unused, index) => ({
    type: 'function' as const,
    function: {
      name: `tool_${index}`,
      description: filler(300, index),
      parameters: toolParameters(index),
    },
  }));
  const encoder = new TextEncoder();
  const toolsBytes = encoder.encode(JSON.stringify(tools)).byteLength;
  // Fill about 120,000 bytes with 2,000-character messages after the tools.
  const messageCount = Math.min(
    AI_WIRE_LIMITS.maxMessages,
    Math.max(1, Math.floor((120_000 - toolsBytes) / 2_010)),
  );
  const messages = Array.from({ length: messageCount }, (_unused, index) => ({
    role: index === 0 ? ('system' as const) : ('user' as const),
    content: filler(2_000, index + 100),
  }));
  const base = { model: 'auto', messages, tools, tool_choice: 'auto' as const, max_tokens: 1_024 };
  const bytes = encoder.encode(JSON.stringify(base)).byteLength;
  // Pad the last message so the body ends close to, and under, the limit.
  const room = AI_WIRE_LIMITS.maxBodyBytes - 1_000 - bytes;
  const last = messages[messageCount - 1];
  if (last !== undefined && room > 0) {
    last.content += filler(Math.min(room, AI_WIRE_LIMITS.maxContentChars - last.content.length), 7);
  }
  const text = JSON.stringify(base);
  return { text, bytes: encoder.encode(text).byteLength };
}

function streamRequest(text: string): Request {
  const bytes = new TextEncoder().encode(text);
  const chunkSize = 16_384;
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.byteLength) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  // `duplex: 'half'` is required by Node for a streamed request body; it is not in the Workers types.
  const init = { method: 'POST', body, duplex: 'half' } as RequestInit;
  return new Request('http://localhost/api/ai/chat', init);
}

async function validateOnce(text: string): Promise<number> {
  const request = streamRequest(text);
  const start = performance.now();
  const read = await readLimitedBody(request, AI_WIRE_LIMITS.maxBodyBytes);
  if (!read.ok) {
    throw new Error(`body rejected: ${read.reason}`);
  }
  const parsed: unknown = JSON.parse(read.text);
  const result = ChatRequestSchema.safeParse(parsed);
  const elapsed = performance.now() - start;
  if (!result.success) {
    throw new Error('the maximum-size request failed validation');
  }
  return elapsed;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

describe('CPU budget of request validation', () => {
  it('validates a maximum-size body within the budget (median of 20 runs)', async () => {
    const { text, bytes } = buildMaxRequest();
    expect(bytes).toBeGreaterThanOrEqual(100_000);
    expect(bytes).toBeLessThanOrEqual(AI_WIRE_LIMITS.maxBodyBytes);

    for (let i = 0; i < WARM_UPS; i += 1) {
      await validateOnce(text);
    }
    const samples: number[] = [];
    for (let i = 0; i < RUNS; i += 1) {
      samples.push(await validateOnce(text));
    }
    const measured = median(samples);
    process.stderr.write(
      `[guards] CPU budget: median ${measured.toFixed(2)} ms over ${RUNS} runs, ` +
        `body ${bytes} bytes, max ${Math.max(...samples).toFixed(2)} ms ` +
        `(Node measurement; the real Workers CPU time is in the Cloudflare dashboard)\n`,
    );

    // This is a Node measurement of read + JSON.parse + Zod. It approximates, and does not equal,
    // the Workers CPU limit of 10 ms on the Free plan: the real number is in the Cloudflare
    // dashboard (manual case). The wall time here includes stream scheduling, which the Workers
    // CPU meter does not count.
    expect(measured).toBeLessThan(BUDGET_MS);
  });
});

// ---- Repository scan for key-shaped strings --------------------------------------------

/*
 * The lookbehind keeps ordinary words such as "task-management..." or "disk_..." from matching:
 * a key prefix must not be glued to a preceding letter or digit.
 */
const KEY_PATTERNS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g, // OpenAI style
  /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{20,}/g, // Groq
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,}/g, // Google (Gemini)
  /(?<![A-Za-z0-9])sk_[A-Za-z0-9]{20,}/g, // Sarvam style
];

/** Fake prefixes used by tests: `sk-test-` (web key-leak tests) and `test-secret-` (worker tests). */
const ALLOWED_FAKES: readonly string[] = ['sk-test-', 'test-secret-'];

/** Returns every key-shaped match in `text` that is not a documented fake. */
function findKeyShapes(text: string): string[] {
  const found: string[] = [];
  for (const pattern of KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      if (!ALLOWED_FAKES.some((fake) => value.includes(fake))) {
        found.push(value);
      }
    }
  }
  return found;
}

const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'test-results',
  '.git',
  '.wrangler',
  'coverage',
  'playwright-report',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.icns',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
  '.zip',
  '.gz',
  '.pdf',
  '.wasm',
  '.DS_Store',
]);

const MAX_SCANNED_BYTES = 2_000_000;
const SCANNED_ROOTS = ['apps', 'packages', 'docs', '.kiro', 'scripts', 'e2e'];

function isBinaryName(name: string): boolean {
  const dot = name.lastIndexOf('.');
  return name === '.DS_Store' || (dot >= 0 && BINARY_EXTENSIONS.has(name.slice(dot).toLowerCase()));
}

function collectFiles(directory: string, into: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return; // The directory does not exist in this checkout.
  }
  for (const name of entries.sort()) {
    const full = join(directory, name);
    const info = statSync(full);
    if (info.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(name)) {
        collectFiles(full, into);
      }
    } else if (info.isFile() && !isBinaryName(name) && info.size <= MAX_SCANNED_BYTES) {
      into.push(full);
    }
  }
}

function filesToScan(): string[] {
  const files: string[] = [];
  for (const name of readdirSync(REPO_ROOT).sort()) {
    const full = join(REPO_ROOT, name);
    if (statSync(full).isFile() && !isBinaryName(name)) {
      files.push(full);
    }
  }
  for (const root of SCANNED_ROOTS) {
    collectFiles(join(REPO_ROOT, root), files);
  }
  return files;
}

describe('repository scan for key-shaped strings', () => {
  it('matches the key shapes it must match', () => {
    const body = (length: number, alphabet = 'a1B2'): string =>
      alphabet.repeat(Math.ceil(length / alphabet.length)).slice(0, length);
    expect(findKeyShapes(`key = "${'sk-' + body(24)}"`)).toHaveLength(1);
    expect(findKeyShapes(`${'sk-proj-' + body(40, 'aB3_-')}`)).toHaveLength(1);
    expect(findKeyShapes(`${'gsk_' + body(24)}`)).toHaveLength(1);
    expect(findKeyShapes(`x=${'AIza' + body(35, 'aB3_-')}`)).toHaveLength(1);
    expect(findKeyShapes(`${'sk_' + body(24)}`)).toHaveLength(1);
    expect(findKeyShapes(`Bearer ${'sk-' + body(30)}\nother ${'gsk_' + body(30)}`)).toHaveLength(2);
  });

  it('does not match what it must not match', () => {
    const body = (length: number): string => 'a1B2'.repeat(Math.ceil(length / 4)).slice(0, length);
    // Documented fakes.
    expect(findKeyShapes('sk-test-' + body(30))).toEqual([]);
    expect(findKeyShapes('test-secret-sarvam-0000')).toEqual([]);
    expect(findKeyShapes('sk-test-secret-' + body(30))).toEqual([]);
    // Too short.
    expect(findKeyShapes('sk-' + body(19))).toEqual([]);
    expect(findKeyShapes('gsk_' + body(19))).toEqual([]);
    expect(findKeyShapes('AIza' + body(29))).toEqual([]);
    expect(findKeyShapes('sk_' + body(19))).toEqual([]);
    // Prefix glued to a word (ordinary kebab-case and snake_case text).
    expect(findKeyShapes('task-management-system-design-notes')).toEqual([]);
    expect(findKeyShapes('disk_' + body(30))).toEqual([]);
    expect(findKeyShapes('the risk-' + body(30))).toEqual([]);
    // Plain prose.
    expect(findKeyShapes('SARVAM_API_KEY=\nOPENAI_API_KEY=\nQUOTA_SALT=')).toEqual([]);
  });

  it('finds no key-shaped string in the repository', () => {
    const files = filesToScan();
    expect(files.length).toBeGreaterThan(100);

    const findings: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('\u0000')) {
        continue; // Binary content under a text-like name.
      }
      // Report the path and the length only. A real key must never be printed by a test.
      for (const hit of findKeyShapes(text)) {
        findings.push(`${relative(REPO_ROOT, file)}: ${hit.slice(0, 4)}... (${hit.length} chars)`);
      }
    }
    expect(findings).toEqual([]);
  });
});

// ---- wrangler.jsonc and .gitignore --------------------------------------------------------

/** Removes `//` and `/* *\/` comments outside strings, then trailing commas outside strings. */
function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text.charAt(j) !== '"') {
        j += text.charAt(j) === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && next === '/') {
      while (i < text.length && text.charAt(i) !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (match, closing: string | undefined) =>
    closing === undefined ? match : closing,
  );
}

const DOCUMENTED_VARS: readonly string[] = [
  'AI_ENABLED',
  'AI_ALLOWED_ORIGINS',
  'AI_ALLOWED_MODELS',
  'AI_PROVIDERS',
  'AI_SARVAM_MODEL',
  'AI_OPENAI_MODEL',
  'AI_VISITOR_DAILY_CAP',
  'AI_DAILY_CAP',
  'AI_DAILY_TOKEN_CAP',
  'AI_LIFETIME_CAP',
  'AI_LIFETIME_TOKEN_CAP',
  'AI_MAX_OUTPUT_TOKENS',
  'AI_REASONING_EFFORT',
];

const SECRET_NAMES: readonly string[] = ['SARVAM_API_KEY', 'OPENAI_API_KEY', 'QUOTA_SALT'];

describe('wrangler.jsonc', () => {
  const text = readFileSync(resolve(REPO_ROOT, 'apps/worker/wrangler.jsonc'), 'utf8');
  const config = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
  const vars = config['vars'] as Record<string, unknown>;

  it('has only the documented var names, all with string values', () => {
    expect(Object.keys(vars).sort()).toEqual([...DOCUMENTED_VARS].sort());
    for (const value of Object.values(vars)) {
      expect(typeof value).toBe('string');
    }
  });

  it('has no key-looking value and no secret name with a value', () => {
    expect(findKeyShapes(text)).toEqual([]);
    for (const [name, value] of Object.entries(vars)) {
      expect(findKeyShapes(String(value)), name).toEqual([]);
    }
    for (const secret of SECRET_NAMES) {
      expect(Object.keys(vars)).not.toContain(secret);
      // A secret name may appear in a comment, but never as a JSON key.
      expect(stripJsonc(text)).not.toContain(`"${secret}"`);
    }
    expect(Object.keys(config)).not.toContain('secrets');
  });
});

/** Minimal `.gitignore` evaluation for plain, root-level patterns (no directories, no `**`). */
function isIgnored(name: string, lines: readonly string[]): boolean {
  let ignored = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const negated = line.startsWith('!');
    const pattern = negated ? line.slice(1) : line;
    const source = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    if (new RegExp(`^${source}$`).test(name)) {
      ignored = !negated;
    }
  }
  return ignored;
}

describe('.gitignore', () => {
  const lines = readFileSync(resolve(REPO_ROOT, '.gitignore'), 'utf8').split('\n');

  it('evaluates patterns correctly (non-vacuous check of the helper)', () => {
    const sample = ['.env', '.env.*', '!.env.example', '*.log'];
    expect(isIgnored('.env', sample)).toBe(true);
    expect(isIgnored('.env.local', sample)).toBe(true);
    expect(isIgnored('.env.example', sample)).toBe(false);
    expect(isIgnored('a.log', sample)).toBe(true);
    expect(isIgnored('a.txt', sample)).toBe(false);
  });

  it('ignores .dev.vars and does not ignore .dev.vars.example', () => {
    expect(isIgnored('.dev.vars', lines)).toBe(true);
    expect(isIgnored('.dev.vars.example', lines)).toBe(false);
  });

  it('ignores .env files other than .env.example', () => {
    expect(isIgnored('.env', lines)).toBe(true);
    expect(isIgnored('.env.local', lines)).toBe(true);
    expect(isIgnored('.env.example', lines)).toBe(false);
  });

  // Wrangler reads `.dev.vars.<env>` for `--env <env>`, and such a file can hold real keys.
  it('ignores .dev.vars.<environment> files, except .example', () => {
    expect(isIgnored('.dev.vars.staging', lines)).toBe(true);
    expect(isIgnored('.dev.vars.local', lines)).toBe(true);
    expect(isIgnored('.dev.vars.example', lines)).toBe(false);
  });

  it('keeps .dev.vars.example free of values', () => {
    const example = readFileSync(resolve(REPO_ROOT, 'apps/worker/.dev.vars.example'), 'utf8');
    for (const line of example.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      const [name, ...rest] = trimmed.split('=');
      expect(SECRET_NAMES, `${name ?? ''} must be a secret name`).toContain(name);
      expect(rest.join('='), `${name ?? ''} must have no value`).toBe('');
    }
  });
});

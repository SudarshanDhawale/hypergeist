// @vitest-environment node
import 'fake-indexeddb/auto';

import { readFileSync, readdirSync } from 'node:fs';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';

import {
  AiSettingsSchema,
  BASE_URL_MAX,
  DEFAULT_AI_SETTINGS,
  SETTINGS_DB_NAME,
  SETTINGS_DB_VERSION,
  createKeyHolder,
  createSettingsRepository,
  parseAiSettings,
  validateBaseUrl,
} from './settings.ts';

// --- Helpers ---------------------------------------------------------------------------------

/** Module counter: every database in this file gets its own name, so tests cannot see each other. */
let nextDatabase = 0;

function freshDatabase(): { factory: IDBFactory; name: string } {
  nextDatabase += 1;
  return { factory: new IDBFactory(), name: `settings-test-${String(nextDatabase)}` };
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(new Error('IndexedDB request failed in a test.'));
    };
  });
}

function openRaw(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return request(factory.open(name));
}

/** Writes a record under key `ai`, bypassing validation. The database must exist already. */
async function rawPut(factory: IDBFactory, name: string, value: unknown): Promise<void> {
  const db = await openRaw(factory, name);
  const tx = db.transaction('settings', 'readwrite');
  await request(tx.objectStore('settings').put(value, 'ai'));
  db.close();
}

/** Every record of every store, as one JSON text. */
async function rawDump(factory: IDBFactory, name: string): Promise<string> {
  const db = await openRaw(factory, name);
  const out: Record<string, { keys: IDBValidKey[]; values: unknown[] }> = {};
  for (const storeName of Array.from(db.objectStoreNames)) {
    const store = db.transaction(storeName, 'readonly').objectStore(storeName);
    out[storeName] = {
      keys: await request(store.getAllKeys()),
      values: await request(store.getAll()),
    };
  }
  db.close();
  return JSON.stringify(out);
}

const OWN_SETTINGS = {
  provider: 'own',
  baseUrl: 'https://api.example.com/v1',
  model: 'llama-3.3-70b',
} as const;

// --- Defaults and schema ---------------------------------------------------------------------

describe('AiSettingsSchema and defaults', () => {
  it('defaults to demo mode with nothing configured', () => {
    expect(DEFAULT_AI_SETTINGS).toEqual({ provider: 'demo', baseUrl: '', model: '' });
    expect(AiSettingsSchema.safeParse(DEFAULT_AI_SETTINGS).success).toBe(true);
  });

  it('has exactly three fields and no place for a key', () => {
    expect(Object.keys(AiSettingsSchema.shape).sort()).toEqual(['baseUrl', 'model', 'provider']);
  });

  it('rejects unknown properties instead of stripping them', () => {
    expect(AiSettingsSchema.safeParse({ ...OWN_SETTINGS, key: 'sk-test-123' }).success).toBe(false);
    expect(parseAiSettings({ ...OWN_SETTINGS, apiKey: 'sk-test-123' }).ok).toBe(false);
  });

  it('rejects an unknown provider and wrong types', () => {
    expect(parseAiSettings({ ...OWN_SETTINGS, provider: 'other' }).ok).toBe(false);
    expect(parseAiSettings({ ...OWN_SETTINGS, model: 5 }).ok).toBe(false);
    expect(parseAiSettings(null).ok).toBe(false);
    expect(parseAiSettings('own').ok).toBe(false);
    expect(parseAiSettings({ ...OWN_SETTINGS, model: 'm'.repeat(101) }).ok).toBe(false);
  });

  it('normalizes the base URL and trims the model', () => {
    const parsed = parseAiSettings({
      provider: 'own',
      baseUrl: ' https://API.example.com/v1/ ',
      model: '  gpt-x ',
    });
    expect(parsed).toEqual({
      ok: true,
      settings: { provider: 'own', baseUrl: 'https://api.example.com/v1', model: 'gpt-x' },
    });
  });

  it('refuses settings with an invalid base URL', () => {
    expect(parseAiSettings({ ...OWN_SETTINGS, baseUrl: 'http://example.com' }).ok).toBe(false);
  });

  it('allows own with an empty base URL (completeness is checked where the chain is built)', () => {
    expect(parseAiSettings({ provider: 'own', baseUrl: '', model: '' }).ok).toBe(true);
  });
});

// --- validateBaseUrl -------------------------------------------------------------------------

describe('validateBaseUrl', () => {
  it.each([
    ['https://api.example.com/v1', 'https://api.example.com/v1'],
    ['http://localhost:11434/v1', 'http://localhost:11434/v1'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080/v1'],
    ['https://api.example.com', 'https://api.example.com'],
    ['https://api.example.com/', 'https://api.example.com'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    ['https://api.example.com/v1///', 'https://api.example.com/v1'],
    ['  https://api.example.com/v1  ', 'https://api.example.com/v1'],
    ['HTTPS://API.Example.COM/v1', 'https://api.example.com/v1'],
    ['https://api.example.com:443/v1', 'https://api.example.com/v1'],
    ['https://api.example.com:8443/v1', 'https://api.example.com:8443/v1'],
  ])('accepts %s', (input, expected) => {
    expect(validateBaseUrl(input)).toEqual({ ok: true, url: expected });
  });

  it.each([
    ['plain http to a remote host', 'http://example.com'],
    ['plain http to a look-alike host', 'http://localhost.example.com/v1'],
    ['plain http to another loopback address', 'http://127.0.0.2:8080'],
    ['another scheme', 'ftp://x'],
    ['a scheme-less address', 'api.example.com/v1'],
    ['an empty string', ''],
    ['only white space', '   '],
    ['a user name and password', 'https://user:pw@x.com'],
    ['a user name only', 'https://user@x.com'],
    ['a query', 'https://api.example.com/v1?x=1'],
    ['an empty query', 'https://api.example.com/v1?'],
    ['a fragment', 'https://api.example.com/v1#top'],
    ['an empty host', 'https://'],
    ['an empty host with a path', 'https:///v1'],
    ['an empty host with a port', 'https://:8080/v1'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['a data: URL', 'data:text/plain,hello'],
    ['a line break inside', 'https://exa\nmple.com'],
    ['a space inside', 'https://exa mple.com'],
    ['a tab inside', 'https://exa\tmple.com'],
    ['backslashes', 'https:\\\\api.example.com'],
  ])('rejects %s', (_label, input) => {
    const result = validateBaseUrl(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('rejects 301 characters and accepts 300', () => {
    const prefix = 'https://api.example.com/';
    const at300 = prefix + 'a'.repeat(BASE_URL_MAX - prefix.length);
    const at301 = at300 + 'a';
    expect(at300).toHaveLength(300);
    expect(validateBaseUrl(at300).ok).toBe(true);
    expect(at301).toHaveLength(301);
    const result = validateBaseUrl(at301);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('too long');
    }
  });

  it('never repeats the typed text in a message', () => {
    for (const input of ['http://secret-host.example/sk-test-abc', 'https://u:sk-test-abc@x.com']) {
      const result = validateBaseUrl(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message).not.toContain('sk-test-abc');
        expect(result.message).not.toContain('secret-host');
      }
    }
  });
});

// --- Repository ------------------------------------------------------------------------------

describe('createSettingsRepository', () => {
  it('returns the defaults when nothing is stored', async () => {
    const { factory, name } = freshDatabase();
    const repo = createSettingsRepository(factory, { name });
    expect(await repo.load()).toEqual({ settings: DEFAULT_AI_SETTINGS, status: 'default' });
  });

  it('returns a copy of the defaults, not the frozen object', async () => {
    const { factory, name } = freshDatabase();
    const loaded = await createSettingsRepository(factory, { name }).load();
    expect(loaded.settings).not.toBe(DEFAULT_AI_SETTINGS);
  });

  it('saves and loads settings, also through a second repository on the same database', async () => {
    const { factory, name } = freshDatabase();
    const saved = await createSettingsRepository(factory, { name }).save(OWN_SETTINGS);
    expect(saved).toEqual({ ok: true, settings: OWN_SETTINGS });
    const loaded = await createSettingsRepository(factory, { name }).load();
    expect(loaded).toEqual({ settings: OWN_SETTINGS, status: 'stored' });
  });

  it('stores the normalized form', async () => {
    const { factory, name } = freshDatabase();
    const repo = createSettingsRepository(factory, { name });
    const saved = await repo.save({
      provider: 'own',
      baseUrl: 'https://Api.Example.com/v1/',
      model: ' m ',
    });
    expect(saved.ok).toBe(true);
    expect((await repo.load()).settings).toEqual({
      provider: 'own',
      baseUrl: 'https://api.example.com/v1',
      model: 'm',
    });
  });

  it('overwrites the previous record', async () => {
    const { factory, name } = freshDatabase();
    const repo = createSettingsRepository(factory, { name });
    await repo.save(OWN_SETTINGS);
    await repo.save(DEFAULT_AI_SETTINGS);
    expect(await repo.load()).toEqual({ settings: DEFAULT_AI_SETTINGS, status: 'stored' });
  });

  it('uses the database name and version of the design by default', async () => {
    const factory = new IDBFactory();
    await createSettingsRepository(factory).save(OWN_SETTINGS);
    const db = await openRaw(factory, SETTINGS_DB_NAME);
    expect(SETTINGS_DB_NAME).toBe('hypergeist-settings');
    expect(db.version).toBe(SETTINGS_DB_VERSION);
    expect(Array.from(db.objectStoreNames)).toEqual(['settings']);
    db.close();
  });

  it('keeps the settings apart from the stacks database', async () => {
    const factory = new IDBFactory();
    await createSettingsRepository(factory).save(OWN_SETTINGS);
    const databases = await factory.databases();
    expect(databases.map((entry) => entry.name)).toEqual(['hypergeist-settings']);
  });

  it('ignores invalid stored data and returns the defaults', async () => {
    const { factory, name } = freshDatabase();
    const repo = createSettingsRepository(factory, { name });
    await repo.save(OWN_SETTINGS);
    const bad: unknown[] = [
      { provider: 'own' },
      { ...OWN_SETTINGS, provider: 'hacker' },
      { ...OWN_SETTINGS, baseUrl: 'http://example.com' },
      { ...OWN_SETTINGS, extra: true },
      { ...OWN_SETTINGS, model: 'x'.repeat(101) },
      'own',
      42,
      null,
      [],
    ];
    for (const value of bad) {
      await rawPut(factory, name, value);
      const loaded = await repo.load();
      expect(loaded.status).toBe('invalid');
      expect(loaded.settings).toEqual(DEFAULT_AI_SETTINGS);
      expect(loaded.message).toBeTruthy();
    }
  });

  it('recovers: a good save after a corrupt record loads again', async () => {
    const { factory, name } = freshDatabase();
    const repo = createSettingsRepository(factory, { name });
    await repo.save(OWN_SETTINGS);
    await rawPut(factory, name, { garbage: true });
    expect((await repo.load()).status).toBe('invalid');
    await repo.save(OWN_SETTINGS);
    expect(await repo.load()).toEqual({ settings: OWN_SETTINGS, status: 'stored' });
  });

  it('refuses to save invalid settings and leaves the stored record alone', async () => {
    const { factory, name } = freshDatabase();
    const repo = createSettingsRepository(factory, { name });
    await repo.save(OWN_SETTINGS);
    const rejected = await repo.save({ ...OWN_SETTINGS, baseUrl: 'http://example.com' });
    expect(rejected.ok).toBe(false);
    expect(await repo.save({ nonsense: 1 })).toMatchObject({ ok: false });
    expect(await repo.load()).toEqual({ settings: OWN_SETTINGS, status: 'stored' });
  });

  it('refuses a record that carries a key, and nothing of it reaches the database', async () => {
    const { factory, name } = freshDatabase();
    const repo = createSettingsRepository(factory, { name });
    const key = 'sk-test-SECRET-VALUE-1234';
    expect((await repo.save({ ...OWN_SETTINGS, key })).ok).toBe(false);
    expect((await repo.save({ ...OWN_SETTINGS, apiKey: key })).ok).toBe(false);
    expect(await rawDump(factory, name).catch(() => '')).not.toContain(key);
  });

  it('stores no key after saving settings while a key is held', async () => {
    const { factory, name } = freshDatabase();
    const repo = createSettingsRepository(factory, { name });
    const holder = createKeyHolder();
    const key = 'sk-test-HELD-IN-MEMORY-5678';
    holder.set(key);
    const saved = await repo.save(OWN_SETTINGS);
    expect(saved.ok).toBe(true);
    expect(holder.get()).toBe(key);
    const dump = await rawDump(factory, name);
    expect(dump).not.toContain(key);
    expect(dump).toContain('api.example.com');
    expect(JSON.stringify(await repo.load())).not.toContain(key);
    expect(JSON.stringify(saved)).not.toContain(key);
  });

  it('never throws: no IndexedDB at all', async () => {
    const repo = createSettingsRepository(null);
    const loaded = await repo.load();
    expect(loaded.status).toBe('unavailable');
    expect(loaded.settings).toEqual(DEFAULT_AI_SETTINGS);
    expect(loaded.message).toBeTruthy();
    const saved = await repo.save(OWN_SETTINGS);
    expect(saved.ok).toBe(false);
  });

  it('never throws: opening the database throws, and the exception text is not returned', async () => {
    const broken = {
      open() {
        throw new Error('boom sk-test-LEAK');
      },
    } as unknown as IDBFactory;
    const repo = createSettingsRepository(broken);
    const loaded = await repo.load();
    const saved = await repo.save(OWN_SETTINGS);
    expect(loaded.status).toBe('unavailable');
    expect(saved.ok).toBe(false);
    expect(JSON.stringify([loaded, saved])).not.toContain('boom');
    expect(JSON.stringify([loaded, saved])).not.toContain('sk-test-LEAK');
  });

  it('never throws: the open request fails (a newer database exists)', async () => {
    const { factory, name } = freshDatabase();
    // Version 2 exists, so opening version 1 fails with a VersionError.
    const newer = await request(factory.open(name, 2));
    newer.close();
    const repo = createSettingsRepository(factory, { name });
    const loaded = await repo.load();
    const saved = await repo.save(OWN_SETTINGS);
    expect(loaded.status).toBe('unavailable');
    expect(loaded.settings).toEqual(DEFAULT_AI_SETTINGS);
    expect(saved.ok).toBe(false);
  });

  it('never throws: a factory that returns something that is not a request', async () => {
    const odd = { open: () => ({}) } as unknown as IDBFactory;
    const repo = createSettingsRepository(odd);
    expect((await repo.load()).status).toBe('unavailable');
    expect((await repo.save(OWN_SETTINGS)).ok).toBe(false);
  });

  it('gives up when another tab blocks the open, and closes the late connection', async () => {
    const { factory, name } = freshDatabase();
    // A real `blocked` needs a newer schema version, which does not exist yet. So the real
    // request gets a `blocked` event, and succeeds a moment later, as it would once the other
    // tab let go.
    const blockedFactory = {
      open(dbName: string, version?: number) {
        const real = factory.open(dbName, version);
        const listeners: EventListener[] = [];
        queueMicrotask(() => {
          for (const listener of listeners) {
            listener(new Event('blocked'));
          }
        });
        return new Proxy(real, {
          get(target, prop) {
            if (prop === 'addEventListener') {
              return (type: string, listener: EventListener) => {
                if (type === 'blocked') {
                  listeners.push(listener);
                }
                target.addEventListener(type, listener);
              };
            }
            return Reflect.get(target, prop) as unknown;
          },
        });
      },
    } as unknown as IDBFactory;
    const loaded = await createSettingsRepository(blockedFactory, { name }).load();
    expect(loaded.status).toBe('unavailable');
    // Deleting the database waits for open connections. It only finishes if the late
    // connection was closed.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await request(factory.deleteDatabase(name));
  });
});

// --- Key holder ------------------------------------------------------------------------------

describe('createKeyHolder', () => {
  it('has no key at first', () => {
    expect(createKeyHolder().get()).toBeUndefined();
  });

  it('keeps a key in memory', () => {
    const holder = createKeyHolder();
    holder.set('sk-test-abc');
    expect(holder.get()).toBe('sk-test-abc');
    expect(holder.get()).toBe('sk-test-abc');
  });

  it('replaces the key on a second set', () => {
    const holder = createKeyHolder();
    holder.set('sk-test-one');
    holder.set('sk-test-two');
    expect(holder.get()).toBe('sk-test-two');
  });

  it('removes the key on clear', () => {
    const holder = createKeyHolder();
    holder.set('sk-test-abc');
    holder.clear();
    expect(holder.get()).toBeUndefined();
    holder.clear();
    expect(holder.get()).toBeUndefined();
  });

  it('trims pasted white space, and a blank key counts as no key', () => {
    const holder = createKeyHolder();
    holder.set('  sk-test-abc\n');
    expect(holder.get()).toBe('sk-test-abc');
    holder.set('   ');
    expect(holder.get()).toBeUndefined();
  });

  it('keeps holders independent of each other', () => {
    const a = createKeyHolder();
    const b = createKeyHolder();
    a.set('sk-test-a');
    expect(b.get()).toBeUndefined();
  });

  it('does not expose the key through serialization or enumeration', () => {
    const holder = createKeyHolder();
    holder.set('sk-test-SECRET-9999');
    expect(JSON.stringify(holder)).toBe('{}');
    expect(Object.keys(holder).sort()).toEqual(['clear', 'get', 'set']);
    expect(String(Object.values(holder).map(String))).not.toContain('sk-test-SECRET-9999');
    expect(structuredCloneSafe(holder)).toBe(false);
  });
});

/** True when `structuredClone` copied the object. Holders hold functions, so they cannot be copied. */
function structuredCloneSafe(value: unknown): boolean {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

// --- Source scan -----------------------------------------------------------------------------

const AI_DIR = new URL('./', import.meta.url);

type SourceFile = { readonly name: string; readonly text: string };

/**
 * Reads the non-test `*.ts` files directly in `ai/`. Other tasks write files here at the same
 * time, so a file that vanishes or cannot be read is skipped, and a half-written file is
 * scanned as far as it goes.
 */
function readAiSources(): readonly SourceFile[] {
  let names: string[];
  try {
    names = readdirSync(AI_DIR);
  } catch {
    return [];
  }
  const files: SourceFile[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name.endsWith('.d.ts')) {
      continue;
    }
    try {
      files.push({ name, text: readFileSync(new URL(name, AI_DIR), 'utf8') });
    } catch {
      // Being written or removed right now. The next run sees it.
    }
  }
  return files;
}

/**
 * Removes comments and empties string and template contents (quotes stay), so prose cannot
 * trip the scan and a name inside a string is not mistaken for code. Not a full tokenizer:
 * regular-expression literals are not recognized, which is fine for this scan.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source.charAt(i);
    const next = source.charAt(i + 1);
    if (ch === '/' && next === '/') {
      while (i < source.length && source.charAt(i) !== '\n') {
        i += 1;
      }
    } else if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      out += ch;
      i += 1;
      while (i < source.length && source.charAt(i) !== ch) {
        i += source.charAt(i) === '\\' ? 2 : 1;
      }
      out += ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Text between the parenthesis that opens at `openIndex` and its match. */
function callArguments(code: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return code.slice(openIndex + 1, i);
      }
    }
  }
  return code.slice(openIndex + 1);
}

const BANNED_STORAGE = [
  /\blocalStorage\b/u,
  /\bsessionStorage\b/u,
  /\bdocument\s*\.\s*cookie\b/u,
  /\bcookieStore\b/u,
];

/** Calls that write somewhere durable. */
const WRITE_CALL = /\.\s*(put|add|setItem|putRawStack)\s*\(/gu;

/** Names that would carry a secret. */
const SECRET_NAME = /key|secret|token|authorization|bearer|password/iu;

/** Problems found in one source file. Empty means clean. */
function scanForKeyStorage(file: SourceFile): string[] {
  const code = stripCommentsAndStrings(file.text);
  const problems: string[] = [];
  for (const banned of BANNED_STORAGE) {
    if (banned.test(code)) {
      problems.push(`${file.name}: uses ${banned.source}`);
    }
  }
  for (const match of code.matchAll(WRITE_CALL)) {
    const open = (match.index ?? 0) + match[0].length - 1;
    const args = callArguments(code, open);
    if (SECRET_NAME.test(args)) {
      problems.push(
        `${file.name}: a ${match[1] ?? 'write'} call has a secret-looking argument: ${args}`,
      );
    }
  }
  return problems;
}

describe('source scan: the key is never stored', () => {
  it('detects what it is meant to detect (the scan is not vacuous)', () => {
    const bad = (text: string) => scanForKeyStorage({ name: 'x.ts', text }).length > 0;
    expect(bad("localStorage.setItem('k', key)")).toBe(true);
    expect(bad('window.sessionStorage.x')).toBe(true);
    expect(bad("document.cookie = 'k=' + key")).toBe(true);
    expect(bad('await db.put(STORE, { apiKey }, ID)')).toBe(true);
    expect(bad('await db.put(STORE, holder.get(), ID)')).toBe(false); // caught by the next case
    expect(bad('store.add(getKey())')).toBe(true);
    expect(bad("db.put('settings', settings, ID)")).toBe(false);
    expect(bad('// localStorage is not used\n/* document.cookie */ const a = 1;')).toBe(false);
    expect(bad("const m = 'localStorage';")).toBe(false);
    expect(bad('await db.put(STORE, settings, RECORD_ID)')).toBe(false);
  });

  it('reads the sources of ai/, including settings.ts', () => {
    const names = readAiSources().map((file) => file.name);
    expect(names).toContain('settings.ts');
    expect(names.some((name) => name.endsWith('.test.ts'))).toBe(false);
  });

  it('finds no localStorage, sessionStorage, cookie or secret-carrying write in ai/', () => {
    const problems = readAiSources().flatMap(scanForKeyStorage);
    expect(problems).toEqual([]);
  });

  it('opens IndexedDB in settings.ts only', () => {
    const offenders = readAiSources()
      .filter((file) => file.name !== 'settings.ts')
      .filter((file) =>
        /\b(indexedDB|openDB|IDBFactory)\b/u.test(stripCommentsAndStrings(file.text)),
      )
      .map((file) => file.name);
    expect(offenders).toEqual([]);
  });

  it('does not let settings.ts pass the key holder to anything but its own closure', () => {
    const settings = readAiSources().find((file) => file.name === 'settings.ts');
    expect(settings).toBeDefined();
    const code = stripCommentsAndStrings(settings?.text ?? '');
    // The repository takes no key: nothing in its factory mentions a key or the holder.
    const start = code.indexOf('export function createSettingsRepository');
    const end = code.indexOf('export type KeyHolder');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(code.slice(start, end)).not.toMatch(/key|holder|getKey/iu);
  });
});

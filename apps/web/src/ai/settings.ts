import { wrap } from 'idb';
import type { DBSchema, IDBPDatabase } from 'idb';
import { z } from 'zod';

/**
 * Provider settings (which provider, base URL, model) and the memory-only key holder.
 *
 * The key is NOT part of the settings: `AiSettingsSchema` is strict and has no key field, so a
 * key cannot be saved by accident, and the repository never receives one. The key lives only in
 * the closure of `createKeyHolder` for the current page session (Requirement 2.3).
 */

/** Name of the settings database. Not the stacks database, so exports and restores never touch it. */
export const SETTINGS_DB_NAME = 'hypergeist-settings';

/** Schema version of the settings database. */
export const SETTINGS_DB_VERSION = 1;

/** Longest base URL accepted, in characters. */
export const BASE_URL_MAX = 300;

/** Longest model name accepted, in characters. */
export const MODEL_MAX = 100;

const STORE = 'settings';
/** The one record in the store. */
const RECORD_ID = 'ai';

export const AiSettingsSchema = z.strictObject({
  provider: z.enum(['demo', 'own']),
  baseUrl: z.string().max(BASE_URL_MAX),
  model: z.string().max(MODEL_MAX),
});

export type AiSettings = z.infer<typeof AiSettingsSchema>;

/** Demo mode, nothing configured. */
export const DEFAULT_AI_SETTINGS: Readonly<AiSettings> = Object.freeze({
  provider: 'demo',
  baseUrl: '',
  model: '',
});

// --- Base URL --------------------------------------------------------------------------------

export type BaseUrlResult =
  { readonly ok: true; readonly url: string } | { readonly ok: false; readonly message: string };

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True for white space and control characters (written as a loop: a control range trips `no-control-regex`). */
function hasWhitespaceOrControl(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code === 0x7f || /\s/u.test(ch)) {
      return true;
    }
  }
  return false;
}

function rejectUrl(message: string): BaseUrlResult {
  return { ok: false, message };
}

/**
 * Checks a base URL typed by the user. Accepts `https:`, and `http:` only for `localhost`,
 * `127.0.0.1` and `[::1]`, so a key is never sent over plain HTTP to a remote host. Rejects
 * user name or password, query, fragment, empty host, white space and over 300 characters.
 * On success `url` is trimmed, has a lower-case host and has no trailing slash.
 * Messages are fixed text; they never repeat what was typed.
 */
export function validateBaseUrl(text: string): BaseUrlResult {
  const trimmed = text.trim();
  if (trimmed === '') {
    return rejectUrl('Enter the web address of the provider.');
  }
  if (trimmed.length > BASE_URL_MAX) {
    return rejectUrl(
      `That web address is too long. Use at most ${String(BASE_URL_MAX)} characters.`,
    );
  }
  // `URL` silently drops tabs and line breaks, so look for them first.
  if (hasWhitespaceOrControl(trimmed)) {
    return rejectUrl('The web address cannot contain spaces or line breaks.');
  }
  const scheme = /^([a-z][a-z0-9+.-]*):/iu.exec(trimmed)?.[1]?.toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') {
    return rejectUrl('The web address must start with https://');
  }
  // `new URL('https:///x')` reads `x` as the host, so require a host right after `//`.
  if (!/^https?:\/\/[^/\\]/iu.test(trimmed)) {
    return rejectUrl('The web address needs a host name, for example https://api.example.com/v1');
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    return rejectUrl('The web address cannot contain a query (?) or a fragment (#).');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return rejectUrl('That is not a valid web address.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return rejectUrl('The web address cannot contain a user name or password. Use the key field.');
  }
  if (parsed.hostname === '') {
    return rejectUrl('The web address needs a host name, for example https://api.example.com/v1');
  }
  if (parsed.protocol === 'http:' && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    return rejectUrl(
      'Plain http:// is only allowed for localhost and 127.0.0.1. Use an https:// address.',
    );
  }
  const url = parsed.origin + parsed.pathname.replace(/\/+$/u, '');
  if (url.length > BASE_URL_MAX) {
    return rejectUrl(
      `That web address is too long. Use at most ${String(BASE_URL_MAX)} characters.`,
    );
  }
  return { ok: true, url };
}

// --- Parsing settings ------------------------------------------------------------------------

export type ParseSettingsResult =
  | { readonly ok: true; readonly settings: AiSettings }
  | { readonly ok: false; readonly message: string };

const INVALID_SETTINGS = 'The AI settings are not valid.';

/**
 * The single gate for settings, used for both reading and writing. Strict schema first (unknown
 * properties, such as a key, are rejected, never stripped), then the base URL: empty, or valid
 * and normalized. `model` is trimmed. The `own` provider with an empty base URL is allowed here;
 * whether the settings are complete enough to use is decided where the provider chain is built.
 */
export function parseAiSettings(value: unknown): ParseSettingsResult {
  const result = AiSettingsSchema.safeParse(value);
  if (!result.success) {
    return { ok: false, message: INVALID_SETTINGS };
  }
  const raw = result.data;
  let baseUrl = '';
  if (raw.baseUrl.trim() !== '') {
    const checked = validateBaseUrl(raw.baseUrl);
    if (!checked.ok) {
      return { ok: false, message: checked.message };
    }
    baseUrl = checked.url;
  }
  return { ok: true, settings: { provider: raw.provider, baseUrl, model: raw.model.trim() } };
}

// --- Repository ------------------------------------------------------------------------------

/** Out-of-line key `ai`. The value is `unknown` on purpose: stored data is untrusted. */
interface SettingsDB extends DBSchema {
  settings: { key: string; value: unknown };
}

export type LoadStatus =
  /** A valid record was read. */
  | 'stored'
  /** Nothing is stored yet. */
  | 'default'
  /** A record exists but is not valid, so it was ignored. */
  | 'invalid'
  /** The browser would not give access to storage. */
  | 'unavailable';

export type LoadSettingsResult = {
  /** Always valid. The defaults for every status except `stored`. */
  readonly settings: AiSettings;
  readonly status: LoadStatus;
  /** Plain-language note for `invalid` and `unavailable`. Never contains exception text. */
  readonly message?: string;
};

export type SaveSettingsResult =
  | { readonly ok: true; readonly settings: AiSettings }
  | { readonly ok: false; readonly message: string };

export type SettingsRepository = {
  /** Reads and validates the settings. Never rejects. */
  load(): Promise<LoadSettingsResult>;
  /**
   * Validates, normalizes and stores the settings. `value` is untyped on purpose, so a record
   * with extra properties (a key) is refused. Never rejects.
   */
  save(value: unknown): Promise<SaveSettingsResult>;
};

export type SettingsRepositoryOptions = {
  /** Database name. Tests pass a unique one. Defaults to `SETTINGS_DB_NAME`. */
  readonly name?: string;
};

const UNAVAILABLE_MESSAGE = 'This browser would not open its storage for the AI settings.';
const SAVE_FAILED_MESSAGE = 'The AI settings could not be stored in this browser.';
const IGNORED_MESSAGE = 'The stored AI settings were not valid, so the defaults are used.';

function resolveFactory(option: IDBFactory | null | undefined): IDBFactory | null {
  if (option === null) {
    return null;
  }
  if (option !== undefined) {
    return option;
  }
  return typeof globalThis.indexedDB === 'undefined' ? null : globalThis.indexedDB;
}

/**
 * Opens the database with the given factory (`idb`'s `openDB` only uses the global one).
 * Resolves `undefined` when it cannot be opened, or when another tab blocks an upgrade.
 */
function openDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBPDatabase<SettingsDB> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    // One `try` around everything that touches the factory or its request, so a factory that
    // throws, or returns something that is not a request, ends as `undefined`, not a rejection.
    try {
      const request = factory.open(name, SETTINGS_DB_VERSION);
      request.addEventListener('upgradeneeded', (event) => {
        const db = wrap(request.result) as IDBPDatabase<SettingsDB>;
        if (event.oldVersion < 1) {
          db.createObjectStore(STORE);
        }
      });
      request.addEventListener('blocked', () => {
        settled = true;
        resolve(undefined);
      });
      (wrap(request) as Promise<IDBPDatabase<SettingsDB>>).then(
        (db) => {
          if (settled) {
            // The open finished after we gave up: do not keep blocking other tabs.
            db.close();
            return;
          }
          settled = true;
          resolve(db);
        },
        () => {
          if (!settled) {
            settled = true;
            resolve(undefined);
          }
        },
      );
    } catch {
      settled = true;
      resolve(undefined);
    }
  });
}

/**
 * Settings repository over IndexedDB (database `hypergeist-settings`, store `settings`,
 * record `ai`). `indexedDB`: `undefined` uses the global one if there is one, `null` means
 * unavailable, an `IDBFactory` is used as given (tests pass one from `fake-indexeddb`).
 *
 * Each call opens and closes its own connection, so nothing stays open to block another tab.
 * Nothing here throws: failures come back as values with fixed plain-language messages. The
 * key is not an input of any method, so it cannot reach storage through this module.
 */
export function createSettingsRepository(
  indexedDB?: IDBFactory | null,
  options: SettingsRepositoryOptions = {},
): SettingsRepository {
  const factory = resolveFactory(indexedDB);
  const name = options.name ?? SETTINGS_DB_NAME;

  function defaults(status: LoadStatus, message?: string): LoadSettingsResult {
    const settings: AiSettings = { ...DEFAULT_AI_SETTINGS };
    return message === undefined ? { settings, status } : { settings, status, message };
  }

  return {
    async load() {
      if (factory === null) {
        return defaults('unavailable', UNAVAILABLE_MESSAGE);
      }
      const db = await openDatabase(factory, name);
      if (db === undefined) {
        return defaults('unavailable', UNAVAILABLE_MESSAGE);
      }
      try {
        const record: unknown = await db.get(STORE, RECORD_ID);
        if (record === undefined) {
          return defaults('default');
        }
        const parsed = parseAiSettings(record);
        return parsed.ok
          ? { settings: parsed.settings, status: 'stored' }
          : defaults('invalid', IGNORED_MESSAGE);
      } catch {
        return defaults('unavailable', UNAVAILABLE_MESSAGE);
      } finally {
        db.close();
      }
    },

    async save(value) {
      const parsed = parseAiSettings(value);
      if (!parsed.ok) {
        return { ok: false, message: parsed.message };
      }
      if (factory === null) {
        return { ok: false, message: UNAVAILABLE_MESSAGE };
      }
      const db = await openDatabase(factory, name);
      if (db === undefined) {
        return { ok: false, message: UNAVAILABLE_MESSAGE };
      }
      try {
        await db.put(STORE, parsed.settings, RECORD_ID);
        return { ok: true, settings: parsed.settings };
      } catch {
        return { ok: false, message: SAVE_FAILED_MESSAGE };
      } finally {
        db.close();
      }
    },
  };
}

// --- Key holder ------------------------------------------------------------------------------

export type KeyHolder = {
  /** The key, or `undefined` when none is set. Pass this function as `getKey`. */
  get(): string | undefined;
  /** Keeps the key (trimmed) in memory. An empty or blank key clears it. */
  set(key: string): void;
  /** Removes the key from memory. */
  clear(): void;
};

/**
 * A memory-only holder. The key sits in a closure variable: it is not a property of the
 * returned object, so serializing or logging the holder shows nothing, and it is never given
 * to the settings repository, a cookie, `localStorage` or a log. A reload loses it on purpose.
 */
export function createKeyHolder(): KeyHolder {
  let held: string | undefined;
  return {
    get() {
      return held;
    },
    set(key) {
      const trimmed = key.trim();
      held = trimmed === '' ? undefined : trimmed;
    },
    clear() {
      held = undefined;
    },
  };
}

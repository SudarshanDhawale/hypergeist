import { ReminderSchema } from './types.ts';
import type { Reminder, ReminderErrorCode, ReminderRepository, ReminderResult } from './types.ts';

/** Most reminders stored at once, valid or not. A `put` with a new id over this is rejected. */
export const MAX_STORED_REMINDERS = 200;

export const REMINDER_INVALID_MESSAGE = 'This reminder is not valid, so it was not saved.';
export const REMINDER_QUOTA_MESSAGE = `Only ${String(MAX_STORED_REMINDERS)} reminders can be stored. Cancel some and try again.`;
export const REMINDER_FAILED_MESSAGE = 'Your reminders could not be stored in this browser.';
export const REMINDER_CLOSED_MESSAGE = 'Reminder storage is closed. Reload the page.';

/**
 * Test-only hooks. Production code must not use them: they bypass validation on purpose so a
 * test can place bad data in the store. Both repositories offer the same hooks; they are async
 * in the IndexedDB one, so callers always `await` them.
 */
export type ReminderRepositoryTesting = {
  /** Stores `record` exactly as given, with no validation. It needs a string `id` to be keyed. */
  putRaw(record: unknown): Promise<void> | void;
  /** Ids (keys) of every stored record, valid or not, sorted. */
  rawIds(): Promise<readonly string[]> | readonly string[];
};

/** A repository that can be closed. After `close()` every call returns `STORAGE_FAILED`. */
export type ClosableReminderRepository = ReminderRepository & {
  close(): Promise<void>;
};

export type MemoryReminderRepository = ClosableReminderRepository & {
  readonly testing: ReminderRepositoryTesting;
};

export function reminderOk<T>(value: T): ReminderResult<T> {
  return { ok: true, value };
}

export function reminderFail(code: ReminderErrorCode, message: string): ReminderResult<never> {
  return { ok: false, errors: [{ code, message }] };
}

/** Order used by `list`: due time first, then id. Plain code-unit comparison, so it never depends on the locale. */
export function compareReminders(a: Reminder, b: Reminder): number {
  if (a.dueAt !== b.dueAt) {
    return a.dueAt - b.dueAt;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? -1 : 1;
}

/**
 * Reminders held in memory. Used when IndexedDB is not available (Memory_Mode): reminders then
 * last only until the page closes. Never throws.
 */
export function createMemoryReminderRepository(): MemoryReminderRepository {
  const records = new Map<string, unknown>();
  let closed = false;

  return {
    list() {
      if (closed) {
        return Promise.resolve(reminderFail('STORAGE_FAILED', REMINDER_CLOSED_MESSAGE));
      }
      const valid: Reminder[] = [];
      for (const [key, raw] of [...records.entries()]) {
        const parsed = ReminderSchema.safeParse(raw);
        if (parsed.success && parsed.data.id === key) {
          valid.push(parsed.data);
        } else {
          records.delete(key);
        }
      }
      valid.sort(compareReminders);
      return Promise.resolve(reminderOk<readonly Reminder[]>(valid));
    },

    put(reminder) {
      if (closed) {
        return Promise.resolve(reminderFail('STORAGE_FAILED', REMINDER_CLOSED_MESSAGE));
      }
      const parsed = ReminderSchema.safeParse(reminder);
      if (!parsed.success) {
        return Promise.resolve(reminderFail('INVALID_REMINDER', REMINDER_INVALID_MESSAGE));
      }
      if (!records.has(parsed.data.id) && records.size >= MAX_STORED_REMINDERS) {
        return Promise.resolve(reminderFail('QUOTA_EXCEEDED', REMINDER_QUOTA_MESSAGE));
      }
      records.set(parsed.data.id, parsed.data);
      return Promise.resolve(reminderOk(undefined));
    },

    remove(id) {
      if (closed) {
        return Promise.resolve(reminderFail('STORAGE_FAILED', REMINDER_CLOSED_MESSAGE));
      }
      records.delete(id);
      return Promise.resolve(reminderOk(undefined));
    },

    close() {
      closed = true;
      return Promise.resolve();
    },

    testing: {
      putRaw(record) {
        const id: unknown =
          typeof record === 'object' && record !== null && 'id' in record ? record.id : undefined;
        if (typeof id !== 'string') {
          throw new Error('A raw reminder needs a string id.');
        }
        records.set(id, structuredClone(record));
      },
      rawIds() {
        return [...records.keys()].sort();
      },
    },
  };
}

import { ENTITY_ID_PATTERN } from '@hypergeist/shared/format';
import { z } from 'zod';

/** Longest reminder message, in characters. */
export const MAX_REMINDER_MESSAGE_LENGTH = 500;

export const REMINDER_STATES = ['pending', 'fired', 'missed'] as const;

export const ReminderStateSchema = z.enum(REMINDER_STATES);

const NonNegativeSafeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/**
 * One reminder. `dueAt` and `createdAt` are milliseconds since the epoch, supplied by the caller.
 * A reminder is stored in its own database and never inside a stack, an export or a share link.
 *
 * - `pending`: waiting for its due time.
 * - `fired`: became due while the app was open.
 * - `missed`: found already past due when the app opened.
 */
export const ReminderSchema = z.strictObject({
  id: z.string().regex(ENTITY_ID_PATTERN),
  stackId: z.string().regex(ENTITY_ID_PATTERN),
  message: z.string().min(1).max(MAX_REMINDER_MESSAGE_LENGTH),
  dueAt: NonNegativeSafeInteger,
  createdAt: NonNegativeSafeInteger,
  state: ReminderStateSchema,
});

export type Reminder = z.infer<typeof ReminderSchema>;
export type ReminderState = z.infer<typeof ReminderStateSchema>;

export type ReminderErrorCode = 'INVALID_REMINDER' | 'QUOTA_EXCEEDED' | 'STORAGE_FAILED';

export type ReminderError = {
  readonly code: ReminderErrorCode;
  /** Plain-language message, safe to show to the user. */
  readonly message: string;
};

/** Result value for expected failures. Repositories never throw for these. */
export type ReminderResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly ReminderError[] };

export type ReminderRepository = {
  /** Every valid stored reminder. A corrupt record is dropped (and deleted), never thrown. */
  list(): Promise<ReminderResult<readonly Reminder[]>>;
  /** Validates, then adds the reminder or replaces the one with the same id. */
  put(reminder: Reminder): Promise<ReminderResult<void>>;
  /** Removes a reminder. An unknown id is ok. */
  remove(id: string): Promise<ReminderResult<void>>;
};

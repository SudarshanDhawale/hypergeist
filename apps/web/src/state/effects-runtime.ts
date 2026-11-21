import { applyOperation } from '@hypergeist/shared/engine';
import type {
  EffectInput,
  EffectRequest,
  RunAiFieldEffect,
  ScheduleNotificationEffect,
} from '@hypergeist/shared/engine';
import { LIMITS } from '@hypergeist/shared/format';
import type { Stack } from '@hypergeist/shared/format';
import { chooseProviderChain, completeTextWithFallback, demoNote } from '../ai/index.ts';
import type { CompleteTextFallbackResult, ProviderError, Provider, Scenario } from '../ai/index.ts';
import { parseDueTime } from '../reminders/due-time.ts';
import {
  canSchedule,
  dueNow,
  markFired,
  markMissed,
  newReminderId,
  nextDue,
} from '../reminders/reminder-logic.ts';
import type { Reminder, ReminderRepository } from '../reminders/types.ts';
import type { KeyHolder } from './ai-controller.ts';
import type { AiStoreApi } from './ai-store.ts';
import type { EffectsStoreApi } from './effects-store.ts';
import type { StackStoreApi } from './stack-store.ts';

/*
 * The effects runtime carries out the two effect requests the browser can answer on its own:
 * `run_ai_field` (an AI field fills itself) and `schedule_notification` (a reminder that fires
 * while the app is open or installed). It has no React in it, reads no global at import time and
 * never throws or rejects: every failure becomes a fixed status message built from an error code
 * or a fixed sentence, never from a response body or an exception text.
 *
 * The effects store is the one list of reminders. The runtime changes it and mirrors every change
 * into the reminder repository, so the in-app list never waits for storage.
 */

/** A field run stops after this long. */
export const FIELD_TIMEOUT_MS = 60_000;

/** At most this many field runs go at once. Further runs wait. */
export const MAX_CONCURRENT_RUNS = 3;

/** The longest delay `setTimeout` accepts (a signed 32-bit number of milliseconds). */
export const MAX_TIMER_MS = 2_147_483_647;

type ProviderErrorCode = ProviderError['code'];

/** What the runtime needs from the browser's notifications. Absent when the browser has none. */
export type NotificationPort = {
  permission(): 'default' | 'granted' | 'denied';
  requestPermission(): Promise<unknown>;
  show(title: string, body: string): void;
};

export type EffectsListenerType = 'visibilitychange' | 'focus';

export type EffectsRuntimeDeps = {
  readonly stackStore: StackStoreApi;
  readonly effectsStore: EffectsStoreApi;
  readonly aiStore: AiStoreApi;
  /** Replaces `chooseProviderChain`, for tests. */
  readonly chooseChain?: typeof chooseProviderChain;
  readonly keyHolder: KeyHolder;
  readonly scenarios: readonly Scenario[];
  readonly fetch: typeof fetch;
  readonly reminderRepo: ReminderRepository;
  readonly now: () => number;
  readonly setTimeout: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly notification?: NotificationPort;
  /** Refreshes the demo counter after a field run. */
  readonly refreshQuota: () => Promise<void>;
  /** Adds a window or document listener and returns the function that removes it. */
  readonly addListener?: (type: EffectsListenerType, listener: () => void) => () => void;
  /**
   * A counter for reminder ids. It must not repeat across sessions (a time based number works);
   * the runtime also draws again when an id is already in use.
   */
  readonly makeId: () => number;
};

export type EffectsRuntime = {
  /** Carries out the `run_ai_field` and `schedule_notification` effects. Ignores the others. */
  handle(effects: readonly EffectRequest[], snapshot: Stack): void;
  /** Loads the stored reminders, marks overdue ones `missed`, arms the timer, adds listeners. */
  init(): Promise<void>;
  /** Removes a pending reminder. */
  cancelReminder(id: string): void;
  /** Removes a fired or missed reminder. */
  dismissReminder(id: string): void;
  /** Stops the timer, the listeners and every field run. `init` may start the runtime again. */
  dispose(): void;
};

/* ---------- fixed text ---------- */

const FIELD_ERROR_TEXT: Readonly<Record<ProviderErrorCode, string>> = {
  NETWORK: 'The AI field could not be filled because of a network problem.',
  CORS_OR_OFFLINE: 'The AI could not be reached. You may be offline.',
  AUTH: 'The provider did not accept the key. Check it in the AI settings.',
  RATE_LIMITED: 'The AI is busy right now. Try again in a minute.',
  QUOTA: 'The AI usage limit has been reached. Try again later.',
  MODEL_NOT_FOUND: 'The provider does not know this model. Check the AI settings.',
  BAD_REQUEST: 'The provider rejected the request.',
  SERVER: 'The AI had a problem on its side. Try again in a moment.',
  TIMEOUT: 'The AI field took too long.',
  ABORTED: 'The AI field was stopped.',
  BAD_REPLY: 'The AI sent a reply the app could not use.',
  DEMO_ONLY: 'In demo mode this field only answers its recorded example.',
};

const DROPPED_TEXT = 'The stack changed while the field was working, so the answer was dropped.';
const REJECTED_TEXT = 'The answer could not be put into the field, so nothing was changed.';
const UNEXPECTED_FIELD_TEXT = 'Something went wrong. The field was not changed.';
const TOO_LONG_TEXT = `The answer was cut to ${formatThousands(LIMITS.aiFieldValue.max)} characters.`;

const LIMIT_SENTENCE = 'It fires only while HyperGeist is open or installed.';
const BLOCKED_SENTENCE = 'Notifications are blocked, so the reminder shows inside HyperGeist only.';
const UNSUPPORTED_SENTENCE =
  'This browser cannot show notifications, so the reminder shows inside HyperGeist only.';
const NOT_SAVED_TEXT = 'The reminder could not be saved.';
const UNEXPECTED_REMINDER_TEXT = 'Something went wrong. The reminder was not set.';

const NOTIFICATION_TITLE = 'HyperGeist reminder';

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/* ---------- pure helpers ---------- */

function formatThousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * The "Today" input of an AI field: local date, weekday and time zone, like
 * `2026-11-18, Wednesday, UTC+05:30`. The weekday name does not depend on the browser's locale.
 * Depends on the host time zone only. Never throws.
 */
export function todayText(nowMs: number): string {
  const date = new Date(nowMs);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  const offset = -date.getTimezoneOffset();
  const sign = offset < 0 ? '-' : '+';
  const absolute = Math.abs(offset);
  const zone = `UTC${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day}, ${WEEKDAYS[date.getDay()] ?? ''}, ${zone}`;
}

/** A local time like `2026-11-18 17:00`, for the "Reminder set" text. */
export function formatLocalTime(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return 'an unknown time';
  const day = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function hasAiField(stack: Stack, objectId: string): boolean {
  return stack.cards.some((card) =>
    card.objects.some((object) => object.id === objectId && object.type === 'ai-field'),
  );
}

type FieldJob = {
  readonly effect: RunAiFieldEffect;
  readonly snapshot: Stack;
  readonly key: string;
  readonly chain: readonly Provider[];
};

/** Marks that a run was stopped from outside (timeout or dispose) while a provider was working. */
const STOPPED = { stopped: true } as const;

/**
 * Creates the runtime. Nothing starts until `handle` or `init` is called. `handle` is meant to be
 * attached to the stack store with `attachEffects`, so it runs synchronously inside the click.
 */
export function createEffectsRuntime(deps: EffectsRuntimeDeps): EffectsRuntime {
  const { stackStore, effectsStore, aiStore, keyHolder, reminderRepo, notification } = deps;
  const choose = deps.chooseChain ?? chooseProviderChain;

  let generation = 0;
  let disposed = false;
  let initPromise: Promise<void> | null = null;
  let timer: unknown = null;
  let timerArmed = false;
  let removeListeners: (() => void)[] = [];
  let permissionPending = false;

  /** Keys of runs that are queued or running. */
  const busyKeys = new Set<string>();
  const queue: FieldJob[] = [];
  const controllers = new Set<AbortController>();
  let active = 0;

  /** Reminders that are being stored. They count against the limit of 50 pending. */
  const inFlight: Reminder[] = [];

  function say(text: string): void {
    try {
      stackStore.getState().setStatus(text);
    } catch {
      // A status message is not worth a failure.
    }
  }

  /* ---------- AI fields ---------- */

  function enqueueField(effect: RunAiFieldEffect, snapshot: Stack): void {
    const key = `${snapshot.id}/${effect.targetObjectId}`;
    if (busyKeys.has(key)) return;
    const chosen = choose({
      settings: aiStore.getState().settings,
      getKey: () => keyHolder.get(),
      fetch: deps.fetch,
      scenarios: deps.scenarios,
    });
    if (!chosen.ok) {
      say(chosen.message);
      return;
    }
    busyKeys.add(key);
    effectsStore.getState().setRunning(key, true);
    queue.push({ effect, snapshot, key, chain: chosen.chain });
    startQueued();
  }

  function startQueued(): void {
    while (active < MAX_CONCURRENT_RUNS) {
      const job = queue.shift();
      if (job === undefined) return;
      active += 1;
      void runField(job);
    }
  }

  async function runField(job: FieldJob): Promise<void> {
    const { effect, snapshot, key } = job;
    const runGeneration = generation;
    const abort = new AbortController();
    controllers.add(abort);
    const run = { timedOut: false };
    let handle: unknown = null;
    try {
      handle = deps.setTimeout(() => {
        run.timedOut = true;
        abort.abort();
      }, FIELD_TIMEOUT_MS);

      const inputs: EffectInput[] = [
        ...effect.inputs,
        { objectId: '', name: 'Today', text: todayText(deps.now()) },
      ];
      // The race frees the slot at the timeout even when a provider ignores the signal.
      const stopped = new Promise<typeof STOPPED>((resolve) => {
        if (abort.signal.aborted) resolve(STOPPED);
        else abort.signal.addEventListener('abort', () => resolve(STOPPED), { once: true });
      });
      const outcome = await Promise.race([
        completeTextWithFallback(job.chain, {
          prompt: effect.prompt,
          inputs,
          signal: abort.signal,
        }),
        stopped,
      ]);

      if (runGeneration !== generation) return;
      if ('stopped' in outcome) {
        say(FIELD_ERROR_TEXT[run.timedOut ? 'TIMEOUT' : 'ABORTED']);
        return;
      }
      finishField(outcome, effect.targetObjectId, snapshot, run.timedOut);
    } catch {
      if (runGeneration === generation) say(UNEXPECTED_FIELD_TEXT);
    } finally {
      try {
        if (handle !== null) deps.clearTimeout(handle);
      } catch {
        // Nothing to do.
      }
      controllers.delete(abort);
      busyKeys.delete(key);
      effectsStore.getState().setRunning(key, false);
      active -= 1;
      refreshQuota();
      startQueued();
    }
  }

  function finishField(
    outcome: CompleteTextFallbackResult,
    objectId: string,
    snapshot: Stack,
    timedOut: boolean,
  ): void {
    const { result } = outcome;
    if (!result.ok) {
      const code: ProviderErrorCode =
        result.error.code === 'ABORTED' && timedOut ? 'TIMEOUT' : result.error.code;
      say(FIELD_ERROR_TEXT[code]);
      return;
    }

    // Write to the stack that is open now, never to the snapshot.
    const current = stackStore.getState().stack;
    if (current.id !== snapshot.id || !hasAiField(current, objectId)) {
      say(DROPPED_TEXT);
      return;
    }
    const applied = applyOperation(current, 'update_object', {
      objectId,
      changes: { value: result.text },
    });
    if (!applied.ok) {
      say(REJECTED_TEXT);
      return;
    }
    stackStore.getState().applyStack(applied.stack);

    // `applyStack` clears the status, so the notes are set after it.
    const notes: string[] = [];
    if (result.truncated) notes.push(TOO_LONG_TEXT);
    const note = demoNote(outcome);
    if (note !== null) notes.push(note);
    if (notes.length > 0) say(notes.join(' '));
  }

  function refreshQuota(): void {
    try {
      deps.refreshQuota().catch(() => undefined);
    } catch {
      // A failed counter refresh never matters to the field.
    }
  }

  /* ---------- reminders: timer ---------- */

  function clearTimer(): void {
    if (!timerArmed) return;
    timerArmed = false;
    try {
      deps.clearTimeout(timer);
    } catch {
      // Nothing to do.
    }
    timer = null;
  }

  function rearm(): void {
    clearTimer();
    if (disposed) return;
    try {
      const next = nextDue(effectsStore.getState().reminders);
      if (next === undefined) return;
      const delay = Math.min(Math.max(next.dueAt - deps.now(), 0), MAX_TIMER_MS);
      timer = deps.setTimeout(onTimer, delay);
      timerArmed = true;
    } catch {
      // No timer: the focus and visibility checks still catch due reminders.
    }
  }

  function onTimer(): void {
    timerArmed = false;
    timer = null;
    check();
  }

  /** Fires every reminder that is due now, then arms the timer for the next one. */
  function check(): void {
    try {
      const current = effectsStore.getState().reminders;
      const due = dueNow(current, deps.now());
      if (due.length > 0) {
        const { reminders, changed } = markFired(
          current,
          due.map((reminder) => reminder.id),
        );
        effectsStore.getState().setReminders(reminders);
        for (const reminder of changed) {
          announce(reminder);
          persist(reminder);
        }
      }
    } catch {
      // Fall through to re-arming.
    }
    rearm();
  }

  function announce(reminder: Reminder): void {
    try {
      effectsStore.getState().addNotice({
        id: `reminder-${reminder.id}`,
        text: `Reminder: ${reminder.message}`,
      });
    } catch {
      // Nothing to do.
    }
    try {
      if (notification !== undefined && notification.permission() === 'granted') {
        notification.show(NOTIFICATION_TITLE, reminder.message);
      }
    } catch {
      // The in-app notice is the guaranteed one.
    }
  }

  /** Writes one reminder. A failure is swallowed: the in-app list is already right. */
  function persist(reminder: Reminder): Promise<void> {
    try {
      return reminderRepo.put(reminder).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      return Promise.resolve();
    }
  }

  function forget(id: string): void {
    try {
      void reminderRepo.remove(id).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      // The reminder is gone from the list either way.
    }
  }

  /* ---------- reminders: scheduling ---------- */

  function readPermission(): 'default' | 'granted' | 'denied' | 'unsupported' {
    if (notification === undefined) return 'unsupported';
    try {
      return notification.permission();
    } catch {
      return 'unsupported';
    }
  }

  /** Asks once per prompt. Called inside the click, before any `await`. */
  function requestPermissionOnce(): void {
    if (notification === undefined || permissionPending) return;
    permissionPending = true;
    try {
      void Promise.resolve(notification.requestPermission())
        .then(
          () => undefined,
          () => undefined,
        )
        .then(() => {
          permissionPending = false;
        });
    } catch {
      permissionPending = false;
    }
  }

  function freshId(): string | null {
    const taken = new Set([
      ...effectsStore.getState().reminders.map((reminder) => reminder.id),
      ...inFlight.map((reminder) => reminder.id),
    ]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const id = newReminderId(deps.makeId());
      if (!taken.has(id)) return id;
    }
    return null;
  }

  function schedule(effect: ScheduleNotificationEffect, snapshot: Stack): void {
    const nowMs = deps.now();
    const parsed = parseDueTime(effect.at, nowMs);
    if (!parsed.ok) {
      say(parsed.message);
      return;
    }
    const allowed = canSchedule(
      [...effectsStore.getState().reminders, ...inFlight],
      parsed.dueAt,
      nowMs,
    );
    if (!allowed.ok) {
      say(allowed.message);
      return;
    }

    // Still inside the click: nothing above awaited.
    if (readPermission() === 'default') requestPermissionOnce();

    const id = freshId();
    if (id === null) {
      say(UNEXPECTED_REMINDER_TEXT);
      return;
    }
    const reminder: Reminder = {
      id,
      stackId: snapshot.id,
      message: effect.message,
      dueAt: parsed.dueAt,
      createdAt: nowMs,
      state: 'pending',
    };
    inFlight.push(reminder);
    void storeReminder(reminder, generation);
  }

  async function storeReminder(reminder: Reminder, runGeneration: number): Promise<void> {
    try {
      const saved = await reminderRepo.put(reminder);
      if (!saved.ok) {
        say(NOT_SAVED_TEXT);
        return;
      }
      if (runGeneration !== generation) return;
      const current = effectsStore.getState().reminders;
      if (!current.some((existing) => existing.id === reminder.id)) {
        effectsStore.getState().setReminders([...current, reminder]);
      }
      rearm();
      const permission = readPermission();
      const parts = [
        `Reminder set for ${formatLocalTime(reminder.dueAt)}. ${LIMIT_SENTENCE}`,
        ...(permission === 'denied' ? [BLOCKED_SENTENCE] : []),
        ...(permission === 'unsupported' ? [UNSUPPORTED_SENTENCE] : []),
      ];
      say(parts.join(' '));
    } catch {
      say(NOT_SAVED_TEXT);
    } finally {
      const index = inFlight.indexOf(reminder);
      if (index >= 0) inFlight.splice(index, 1);
    }
  }

  /* ---------- public API ---------- */

  function handle(effects: readonly EffectRequest[], snapshot: Stack): void {
    if (disposed) return;
    for (const effect of effects) {
      try {
        if (effect.kind === 'run_ai_field') enqueueField(effect, snapshot);
        else if (effect.kind === 'schedule_notification') schedule(effect, snapshot);
      } catch {
        say(effect.kind === 'run_ai_field' ? UNEXPECTED_FIELD_TEXT : UNEXPECTED_REMINDER_TEXT);
      }
    }
  }

  async function load(): Promise<void> {
    disposed = false;
    const loadGeneration = generation;
    try {
      const listed = await reminderRepo.list();
      if (loadGeneration !== generation) return;
      if (listed.ok) {
        const { reminders, changed } = markMissed(listed.value, deps.now());
        effectsStore.getState().setReminders(reminders);
        await Promise.all(changed.map((reminder) => persist(reminder)));
      }
    } catch {
      // The list stays as it was.
    }
    if (loadGeneration !== generation) return;
    rearm();
    if (deps.addListener !== undefined) {
      for (const type of ['visibilitychange', 'focus'] as const) {
        try {
          removeListeners.push(deps.addListener(type, check));
        } catch {
          // Without the listener only the timer fires reminders.
        }
      }
    }
  }

  function init(): Promise<void> {
    if (initPromise === null) {
      disposed = false;
      initPromise = load();
    }
    return initPromise;
  }

  function cancelReminder(id: string): void {
    removeReminder(id, (reminder) => reminder.state === 'pending');
  }

  function dismissReminder(id: string): void {
    removeReminder(id, (reminder) => reminder.state !== 'pending');
  }

  function removeReminder(id: string, allowed: (reminder: Reminder) => boolean): void {
    try {
      const current = effectsStore.getState().reminders;
      const found = current.find((reminder) => reminder.id === id);
      if (found === undefined || !allowed(found)) return;
      effectsStore.getState().setReminders(current.filter((reminder) => reminder.id !== id));
      forget(id);
      rearm();
    } catch {
      // Nothing to do.
    }
  }

  function dispose(): void {
    generation += 1;
    disposed = true;
    initPromise = null;
    clearTimer();
    for (const remove of removeListeners) {
      try {
        remove();
      } catch {
        // Nothing to do.
      }
    }
    removeListeners = [];
    for (const abort of controllers) abort.abort();
    for (const job of queue.splice(0)) {
      busyKeys.delete(job.key);
      effectsStore.getState().setRunning(job.key, false);
    }
  }

  return { handle, init, cancelReminder, dismissReminder, dispose };
}

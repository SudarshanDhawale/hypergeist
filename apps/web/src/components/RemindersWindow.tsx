import { useId } from 'react';
import type { JSX } from 'react';
import type { Reminder, ReminderState } from '../reminders/types.ts';
import { useEffects, useEffectsStore } from '../state/EffectsContext.tsx';
import { Modal } from './Modal.tsx';

export const REMINDERS_LIMIT_TEXT =
  'Reminders fire only while HyperGeist is open or installed. If the browser or system blocks notifications, they show inside HyperGeist only.';
export const NO_REMINDERS_TEXT = 'No reminders.';

const STATE_TEXT: Readonly<Record<ReminderState, string>> = {
  pending: 'Pending',
  fired: 'Fired',
  missed: 'Missed while HyperGeist was closed',
};

/** The due time in the user's locale and time zone. */
export function formatDueTime(dueAt: number): string {
  const date = new Date(dueAt);
  return Number.isNaN(date.getTime()) ? 'unknown time' : date.toLocaleString();
}

/** Pending and missed reminders: the ones that still need the user's attention. */
export function countOpenReminders(reminders: readonly Reminder[]): number {
  return reminders.filter((reminder) => reminder.state !== 'fired').length;
}

type Props = { readonly onClose: () => void };

function Row({ reminder }: { readonly reminder: Reminder }): JSX.Element {
  const effects = useEffects();
  const runtime = effects === null ? null : effects.runtime;
  const messageId = useId();
  const pending = reminder.state === 'pending';
  return (
    <li className="reminders-item">
      <p id={messageId} className="reminders-message">
        {reminder.message}
      </p>
      <p className="reminders-meta">
        <span>Due </span>
        <time dateTime={new Date(reminder.dueAt).toISOString()}>
          {formatDueTime(reminder.dueAt)}
        </time>
      </p>
      <p className="reminders-meta">
        <span className="reminders-state">{STATE_TEXT[reminder.state]}</span>
      </p>
      <div className="reminders-actions">
        <button
          type="button"
          aria-describedby={messageId}
          disabled={runtime === null}
          onClick={() => {
            if (runtime === null) return;
            if (pending) runtime.cancelReminder(reminder.id);
            else runtime.dismissReminder(reminder.id);
          }}
        >
          {pending ? 'Cancel' : 'Dismiss'}
        </button>
      </div>
    </li>
  );
}

function sortedByDueTime(reminders: readonly Reminder[]): readonly Reminder[] {
  return [...reminders].sort((a, b) => a.dueAt - b.dueAt || a.createdAt - b.createdAt);
}

function Window({ onClose }: Props): JSX.Element {
  const reminders = useEffectsStore((state) => state.reminders);
  const limitId = useId();
  const sorted = sortedByDueTime(reminders);
  return (
    <Modal title="Reminders" onClose={onClose} className="reminders-window" describedBy={limitId}>
      <div className="dialog-body">
        {sorted.length === 0 ? (
          <p>{NO_REMINDERS_TEXT}</p>
        ) : (
          <ul aria-label="Reminders" className="reminders-list">
            {sorted.map((reminder) => (
              <Row key={reminder.id} reminder={reminder} />
            ))}
          </ul>
        )}
        <p id={limitId} className="reminders-limit">
          {REMINDERS_LIMIT_TEXT}
        </p>
      </div>
      <div className="dialog-actions">
        <button type="button" data-autofocus onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}

/** Lists the reminders with Cancel and Dismiss. Renders nothing without an EffectsProvider. */
export function RemindersWindow({ onClose }: Props): JSX.Element | null {
  return useEffects() === null ? null : <Window onClose={onClose} />;
}

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { deepFreeze } from '../../../../packages/shared/test-support/freeze.ts';
import { assertProperty } from '../../../../packages/shared/test-support/seed.ts';
import {
  MAX_AHEAD_MS,
  MAX_PENDING_REMINDERS,
  canSchedule,
  dueNow,
  markFired,
  markMissed,
  newReminderId,
  nextDue,
} from './reminder-logic.ts';
import { ReminderSchema } from './types.ts';
import type { Reminder, ReminderState } from './types.ts';

/*
 * Property: across random sequences of schedule, time passing (app open), reload (app was
 * closed) and cancel, no reminder fires twice and none is lost.
 *
 * The model below drives the pure functions the way the runtime will, and checks them against
 * a small independent oracle (a map of id to due time and expected state). Inputs are deep
 * frozen, so any mutation inside the logic throws and fails the property. The seed comes from
 * HYPERGEIST_TEST_SEED and is printed on failure.
 */

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

type Command =
  | { readonly kind: 'schedule'; readonly deltaMs: number; readonly message: string }
  | { readonly kind: 'advance'; readonly ms: number }
  | { readonly kind: 'reload'; readonly ms: number }
  | { readonly kind: 'cancel'; readonly pick: number };

const arbCommand: fc.Arbitrary<Command> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant('schedule' as const),
      deltaMs: fc.oneof(
        { weight: 6, arbitrary: fc.integer({ min: 1, max: 3 * DAY }) },
        { weight: 1, arbitrary: fc.integer({ min: -5 * MINUTE, max: 0 }) },
        { weight: 1, arbitrary: fc.integer({ min: 366 * DAY - 2, max: 366 * DAY + 2 }) },
        { weight: 1, arbitrary: fc.integer({ min: 0, max: 800 * DAY }) },
      ),
      message: fc.string({ minLength: 1, maxLength: 30 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('advance' as const),
      ms: fc.oneof(fc.integer({ min: 0, max: 3 * MINUTE }), fc.integer({ min: 0, max: 3 * DAY })),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('reload' as const),
      ms: fc.oneof(fc.integer({ min: 0, max: 3 * MINUTE }), fc.integer({ min: 0, max: 3 * DAY })),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant('cancel' as const),
      pick: fc.nat({ max: 1000 }),
    }),
  },
);

type Expected = {
  readonly dueAt: number;
  readonly createdAt: number;
  readonly message: string;
  state: ReminderState;
};

type Run = {
  readonly startMs: number;
  readonly counterStart: number;
  readonly stackId: string;
  readonly commands: readonly Command[];
};

const arbRun: fc.Arbitrary<Run> = fc.record({
  startMs: fc.integer({ min: 1_000_000_000_000, max: 2_000_000_000_000 }),
  counterStart: fc.integer({ min: 0, max: 1_000_000 }),
  stackId: fc.constantFrom('smart-todo', 'study-deck', 'a'),
  commands: fc.array(arbCommand, { minLength: 0, maxLength: 140 }),
});

const ALLOWED_NEXT: Record<ReminderState, readonly ReminderState[]> = {
  pending: ['pending', 'fired', 'missed'],
  fired: ['fired'],
  missed: ['missed'],
};

function pendingIds(expected: ReadonlyMap<string, Expected>): string[] {
  return [...expected.entries()].filter(([, e]) => e.state === 'pending').map(([id]) => id);
}

function checkInvariants(
  list: readonly Reminder[],
  expected: ReadonlyMap<string, Expected>,
  now: number,
  firedLog: readonly string[],
): void {
  // Nothing lost, nothing invented: the list holds exactly the scheduled, not cancelled ids.
  expect(list.map((r) => r.id).sort()).toEqual([...expected.keys()].sort());

  for (const r of list) {
    const e = expected.get(r.id);
    expect(e).toBeDefined();
    if (e === undefined) {
      continue;
    }
    expect(ReminderSchema.safeParse(r).success).toBe(true);
    expect(r.state).toBe(e.state);
    expect(r.dueAt).toBe(e.dueAt);
    expect(r.createdAt).toBe(e.createdAt);
    expect(r.message).toBe(e.message);
    // After any time step every due reminder has been resolved one way or the other.
    if (r.state === 'pending') {
      expect(r.dueAt).toBeGreaterThan(now);
    }
    // `fired` exactly when the reminder is in the fire log; `missed` never is.
    expect(firedLog.includes(r.id)).toBe(r.state === 'fired');
  }

  const pending = list.filter((r) => r.state === 'pending');
  expect(pending.length).toBeLessThanOrEqual(MAX_PENDING_REMINDERS);

  // nextDue is the earliest pending reminder, and is in the future.
  const next = nextDue(list);
  if (pending.length === 0) {
    expect(next).toBeUndefined();
  } else {
    const earliest = Math.min(...pending.map((r) => r.dueAt));
    expect(next?.dueAt).toBe(earliest);
    expect(next?.state).toBe('pending');
    expect(next?.dueAt).toBeGreaterThan(now);
  }
}

function runModel(run: Run): void {
  let now = run.startMs;
  let counter = run.counterStart;
  let list: readonly Reminder[] = [];
  const expected = new Map<string, Expected>();
  const firedLog: string[] = [];
  const previous = new Map<string, ReminderState>();

  function step(): void {
    checkInvariants(list, expected, now, firedLog);
    // The state of each reminder only moves forward.
    for (const r of list) {
      const before = previous.get(r.id);
      if (before !== undefined) {
        expect(ALLOWED_NEXT[before]).toContain(r.state);
      }
      previous.set(r.id, r.state);
    }
    for (const id of [...previous.keys()]) {
      if (!expected.has(id)) {
        previous.delete(id);
      }
    }
  }

  function openTimeStep(): void {
    const due = dueNow(list, now);
    const shouldFire = pendingIds(expected).filter(
      (id) => (expected.get(id)?.dueAt ?? Infinity) <= now,
    );
    // The due set is exactly the pending reminders whose time has come: none lost.
    expect(due.map((r) => r.id).sort()).toEqual([...shouldFire].sort());
    // Earliest first.
    for (let i = 1; i < due.length; i += 1) {
      expect((due[i - 1]?.dueAt ?? 0) <= (due[i]?.dueAt ?? 0)).toBe(true);
    }
    for (const r of due) {
      // A reminder that already fired or was missed is never returned again: none fires twice.
      expect(firedLog.includes(r.id)).toBe(false);
      expect(expected.get(r.id)?.state).toBe('pending');
      firedLog.push(r.id);
      const e = expected.get(r.id);
      if (e !== undefined) {
        e.state = 'fired';
      }
    }
    const change = markFired(
      list,
      due.map((r) => r.id),
    );
    expect(change.changed.map((r) => r.id).sort()).toEqual(due.map((r) => r.id).sort());
    list = deepFreeze(change.reminders);
    // The runtime asks again right away (a timer firing twice): nothing more is due.
    expect(dueNow(list, now)).toEqual([]);
  }

  step();
  for (const command of run.commands) {
    switch (command.kind) {
      case 'schedule': {
        const dueAt = now + command.deltaMs;
        const result = canSchedule(list, dueAt, now);
        const pendingCount = pendingIds(expected).length;
        const shouldAccept =
          command.deltaMs > 0 &&
          command.deltaMs <= MAX_AHEAD_MS &&
          pendingCount < MAX_PENDING_REMINDERS;
        expect(result.ok).toBe(shouldAccept);
        if (result.ok) {
          const id = newReminderId(counter);
          counter += 1;
          const created: Reminder = {
            id,
            stackId: run.stackId,
            message: command.message,
            dueAt,
            createdAt: now,
            state: 'pending',
          };
          expect(expected.has(id)).toBe(false);
          expected.set(id, { dueAt, createdAt: now, message: command.message, state: 'pending' });
          list = deepFreeze([...list, created]);
        } else {
          expect(result.message.length).toBeGreaterThan(0);
        }
        break;
      }
      case 'advance': {
        now += command.ms;
        openTimeStep();
        break;
      }
      case 'reload': {
        // The app was closed while time passed: nothing fired. On opening, overdue ones are missed.
        now += command.ms;
        const shouldMiss = pendingIds(expected).filter(
          (id) => (expected.get(id)?.dueAt ?? Infinity) <= now,
        );
        const change = markMissed(list, now);
        expect(change.changed.map((r) => r.id).sort()).toEqual([...shouldMiss].sort());
        for (const id of shouldMiss) {
          const e = expected.get(id);
          if (e !== undefined) {
            e.state = 'missed';
          }
        }
        list = deepFreeze(change.reminders);
        // After the reload sweep the timer path finds nothing left to fire.
        expect(dueNow(list, now)).toEqual([]);
        // Opening again changes nothing.
        expect(markMissed(list, now).changed).toEqual([]);
        break;
      }
      case 'cancel': {
        if (list.length > 0) {
          const target = list[command.pick % list.length];
          if (target !== undefined) {
            list = deepFreeze(list.filter((r) => r.id !== target.id));
            expected.delete(target.id);
          }
        }
        break;
      }
    }
    step();
  }

  // Final: let every remaining pending reminder come due while the app is open.
  const latest = Math.max(now, ...[...expected.values()].map((e) => e.dueAt));
  now = latest + 1;
  openTimeStep();
  step();
  for (const r of list) {
    expect(r.state === 'fired' || r.state === 'missed').toBe(true);
  }
  // Each fired id appears once, and only ids that were scheduled.
  expect(new Set(firedLog).size).toBe(firedLog.length);
}

describe('reminder logic properties', () => {
  it('no reminder fires twice and none is lost across schedule, time, reload and cancel', () => {
    assertProperty(
      fc.property(arbRun, (run) => {
        runModel(run);
      }),
      { numRuns: 200 },
    );
  });

  it('the model holds when 60 reminders are scheduled against the limit of 50', () => {
    // A fixed run that schedules 60 reminders far apart: the limit must stop the 51st.
    const commands: Command[] = Array.from({ length: 60 }, (_, i) => ({
      kind: 'schedule' as const,
      deltaMs: (i + 1) * DAY,
      message: `m${i}`,
    }));
    expect(() =>
      runModel({ startMs: 1_700_000_000_000, counterStart: 0, stackId: 'a', commands }),
    ).not.toThrow();
  });
});

const arbReminderList: fc.Arbitrary<Reminder[]> = fc
  .array(
    fc.record({
      dueAt: fc.integer({ min: 0, max: 1000 }),
      state: fc.constantFrom<ReminderState>('pending', 'fired', 'missed'),
    }),
    { maxLength: 40 },
  )
  .map((items) =>
    items.map((item, i) => ({
      id: newReminderId(i),
      stackId: 'a',
      message: `m${i}`,
      dueAt: item.dueAt,
      createdAt: 0,
      state: item.state,
    })),
  );

describe('reminder logic: single-step properties', () => {
  it('dueNow, markFired and markMissed never mutate their input', () => {
    assertProperty(
      fc.property(arbReminderList, fc.integer({ min: 0, max: 1000 }), (list, now) => {
        const frozen = deepFreeze(list);
        const snapshot = JSON.stringify(frozen);
        const due = dueNow(frozen, now);
        markFired(
          frozen,
          due.map((r) => r.id),
        );
        markMissed(frozen, now);
        nextDue(frozen);
        canSchedule(frozen, now + 1, now);
        expect(JSON.stringify(frozen)).toBe(snapshot);
      }),
    );
  });

  it('markMissed leaves nothing pending that is due, and a second call changes nothing', () => {
    assertProperty(
      fc.property(arbReminderList, fc.integer({ min: 0, max: 1000 }), (list, now) => {
        const once = markMissed(list, now);
        expect(dueNow(once.reminders, now)).toEqual([]);
        expect(markMissed(once.reminders, now).changed).toEqual([]);
        expect(once.reminders).toHaveLength(list.length);
      }),
    );
  });

  it('fired and missed reminders are never due again', () => {
    assertProperty(
      fc.property(arbReminderList, fc.integer({ min: 0, max: 2000 }), (list, now) => {
        for (const r of dueNow(list, now)) {
          expect(r.state).toBe('pending');
        }
      }),
    );
  });
});

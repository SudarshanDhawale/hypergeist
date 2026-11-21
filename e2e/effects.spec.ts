import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * End-to-end tests for the effects runtime (Requirement 7.4 of the effects-runtime spec):
 * AI fields that fill themselves and reminders. They run against the Worker that serves the
 * built web app. The Worker has no model configured in e2e, so `/api/ai/chat` answers 503 and
 * the app falls back to the recorded examples, adding the demo note. Nothing here needs a live
 * model or a key.
 *
 * `Notification` is replaced before the page loads by a stub whose permission is `denied`, so no
 * real permission prompt can appear and no real notification can show. The stub counts calls.
 *
 * Every Playwright test gets a fresh browser context, so each one starts with an empty
 * IndexedDB (no reminders) and the seeded demo stacks. The thin-slice to-do opens first.
 *
 * Accessible names: a button's accessible name is the Object's `name`, not its visible label.
 * The visible labels ("1. Read my task") are not accessible names.
 */

// A fixed zone, so the browser never meets a daylight saving gap or repeated hour while a test
// types a local time. The time itself is still computed in the page.
test.use({ timezoneId: 'UTC' });

const FIRST_STACK_NAME = 'Thin slice to-do';
const SMART_TODO = 'Smart To-Do with Reminders';
const STUDY_DECK = 'Study Deck';

const DEMO_NOTE = 'The demo model could not be reached, so this answer is a recorded example.';
/** The message of the "3. Remind me" button, copied from smart-todo.json. */
const REMINDER_MESSAGE = 'Your task is due now. Open the To-Do stack.';
/** Copied from effects-runtime.ts. */
const LIMIT_SENTENCE = 'It fires only while HyperGeist is open or installed.';
const BLOCKED_SENTENCE = 'Notifications are blocked, so the reminder shows inside HyperGeist only.';
/** Copied from reminder-logic.ts. */
const PAST_MESSAGE = 'That time has already passed';
/** The recorded answer of the Smart To-Do time guess, copied from its scenario file. */
const RECORDED_TIME_GUESS = 'Type a time like 2026-12-01T09:00';

type StubCounts = { constructed: number; requested: number };

function stackWindow(page: Page, name: string): Locator {
  return page.getByRole('region', { name, exact: true });
}

function modeRadio(page: Page, label: 'Interact' | 'Edit' | 'AI edit'): Locator {
  return page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', {
    name: label,
    exact: true,
  });
}

/** The status bar of one stack window. It is the only `role="status"` in the window. */
function statusBar(win: Locator): Locator {
  return win.getByRole('status');
}

function textbox(win: Locator, name: string): Locator {
  return win.getByRole('textbox', { name, exact: true });
}

function pressButton(win: Locator, name: string): Promise<void> {
  return win.getByRole('button', { name, exact: true }).click();
}

/** The menu bar button. Its name carries the count of pending and missed reminders. */
function remindersButton(page: Page, count: number): Locator {
  return page.getByRole('button', { name: `Reminders (${String(count)})`, exact: true });
}

function remindersDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Reminders', exact: true });
}

/**
 * Replaces `Notification` before any page script runs. Permission is `denied`, so the runtime
 * never asks and never shows one. The counts are read back with `notificationCounts`.
 */
async function stubNotification(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts: StubCounts = { constructed: 0, requested: 0 };
    class StubNotification {
      static permission = 'denied';
      static requestPermission(): Promise<string> {
        counts.requested += 1;
        return Promise.resolve('denied');
      }
      constructor() {
        counts.constructed += 1;
      }
    }
    Object.defineProperty(window, 'Notification', {
      value: StubNotification,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, '__notificationCounts', { value: counts });
  });
}

function notificationCounts(page: Page): Promise<StubCounts> {
  return page.evaluate(() => {
    const holder = window as unknown as { __notificationCounts: StubCounts };
    return { ...holder.__notificationCounts };
  });
}

/**
 * The local time `minutes` from now as `YYYY-MM-DDTHH:mm`, computed in the browser so the
 * format and the zone are the ones the app parses with.
 */
function localTimeFromNow(page: Page, minutes: number): Promise<string> {
  return page.evaluate((offset) => {
    const pad = (value: number): string => String(value).padStart(2, '0');
    const date = new Date(Date.now() + offset * 60_000);
    const day = `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }, minutes);
}

/** Waits until React has rendered the desktop and the first stack, in Interact mode. */
async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'HyperGeist', exact: true })).toBeVisible();
  await expect(stackWindow(page, FIRST_STACK_NAME)).toBeVisible();
  await expect(modeRadio(page, 'Interact')).toBeChecked();
}

/** Opens a stack from the Stacks window by its name and waits until it is on the desktop. */
async function openStackByName(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Stacks', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stacks', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Loading stacks.', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: `Open ${name}`, exact: true }).click();
  await expect(dialog).toBeHidden();
  const win = stackWindow(page, name);
  await expect(win).toBeVisible();
  return win;
}

/** Opens the Smart To-Do stack, with `Notification` stubbed, and types the task. */
async function openSmartTodo(page: Page, task: string): Promise<Locator> {
  await stubNotification(page);
  await page.goto('/');
  await waitForAppReady(page);
  const win = await openStackByName(page, SMART_TODO);
  await textbox(win, 'Task').fill(task);
  return win;
}

/** Types a time into the When field and presses "3. Remind me". */
async function remindAt(win: Locator, when: string): Promise<void> {
  await textbox(win, 'When').fill(when);
  await pressButton(win, 'Remind me');
}

test('Study Deck: "Make flashcards" fills the Flashcards field with the recorded example', async ({
  page,
}) => {
  await stubNotification(page);
  await page.goto('/');
  await waitForAppReady(page);
  const win = await openStackByName(page, STUDY_DECK);

  const notes = 'The water cycle: evaporation, condensation, precipitation.';
  await textbox(win, 'Notes').fill(notes);
  await pressButton(win, 'Make flashcards');

  // The button copies the notes, starts the field and moves to the Flashcards card.
  await expect(textbox(win, 'Notes (copied from the Notes card)')).toHaveValue(notes);

  // The Worker has no model in e2e, so the recorded example answers. It never claims to be
  // read from the notes.
  const flashcards = textbox(win, 'Flashcards');
  await expect(flashcards).toHaveValue(/^Recorded example \(not from your notes\):/);
  await expect(flashcards).toHaveValue(/\nQ: .+ A: .+/);
  await expect(flashcards).not.toHaveAttribute('aria-busy', 'true');
  await expect(statusBar(win)).toHaveText(DEMO_NOTE);
});

test('Smart To-Do: read, use and remind sets a reminder from a time the user types', async ({
  page,
}) => {
  const win = await openSmartTodo(page, 'dentist Thursday 5pm');
  const guess = textbox(win, 'When (AI guess)');
  await expect(guess).toHaveValue('');

  // Step 1: the recorded example answers in the AI guess field.
  await pressButton(win, 'Read my task');
  await expect(guess).toHaveValue(new RegExp(RECORDED_TIME_GUESS));
  await expect(statusBar(win)).toHaveText(DEMO_NOTE);

  // Step 2: the guess is copied into the When field.
  await pressButton(win, 'Use this time');
  await expect(textbox(win, 'When')).toHaveValue(await guess.inputValue());

  // The recorded text is not a time, so the user types one a few minutes ahead.
  const when = await localTimeFromNow(page, 10);
  await expect(remindersButton(page, 0)).toBeVisible();
  await remindAt(win, when);

  // Step 3: the reminder is set, with the honest limit. The stubbed permission is `denied`.
  const status = statusBar(win);
  await expect(status).toContainText(`Reminder set for ${when.replace('T', ' ')}.`);
  await expect(status).toContainText(LIMIT_SENTENCE);
  await expect(status).toContainText(BLOCKED_SENTENCE);
  await expect(remindersButton(page, 1)).toBeVisible();

  // The permission was already denied, so the app neither asked nor showed a notification.
  expect(await notificationCounts(page)).toEqual({ constructed: 0, requested: 0 });

  // "3. Remind me" sets the reminder only. It does not add the task to the list.
  await expect(
    win.getByRole('list', { name: 'Tasks', exact: true }).getByRole('listitem'),
  ).toHaveCount(0);
});

test('Smart To-Do: a time in the past is refused and the reminder count does not change', async ({
  page,
}) => {
  const win = await openSmartTodo(page, 'dentist Thursday 5pm');
  await expect(remindersButton(page, 0)).toBeVisible();

  await remindAt(win, '2020-01-01T09:00');

  await expect(statusBar(win)).toContainText(PAST_MESSAGE);
  await expect(remindersButton(page, 0)).toBeVisible();
  expect(await notificationCounts(page)).toEqual({ constructed: 0, requested: 0 });

  // Nothing was stored: the window says so.
  await page.getByRole('button', { name: 'Reminders (0)', exact: true }).click();
  const dialog = remindersDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('No reminders.', { exact: true })).toBeVisible();
});

test('the Reminders window lists a reminder, Cancel removes it, and Escape returns focus to the button', async ({
  page,
}) => {
  const win = await openSmartTodo(page, 'dentist Thursday 5pm');
  const when = await localTimeFromNow(page, 10);
  await remindAt(win, when);
  await expect(statusBar(win)).toContainText('Reminder set for');
  await expect(remindersButton(page, 1)).toBeVisible();

  await remindersButton(page, 1).click();
  const dialog = remindersDialog(page);
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('Reminders fire only while HyperGeist is open or installed.'),
  ).toBeVisible();

  const items = dialog.getByRole('list', { name: 'Reminders', exact: true }).getByRole('listitem');
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText(REMINDER_MESSAGE);
  await expect(items.first().getByText('Pending', { exact: true })).toBeVisible();

  // Cancel removes it from the list and the count returns to 0.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog.getByText('No reminders.', { exact: true })).toBeVisible();
  await expect(items).toHaveCount(0);
  await expect(remindersButton(page, 0)).toBeVisible();

  // Escape closes the window and focus goes back to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(remindersButton(page, 0)).toBeFocused();

  // The cancelled reminder is gone for good: it is not back after a reload.
  await page.reload();
  await waitForAppReady(page);
  await expect(remindersButton(page, 0)).toBeVisible();
});

test('Smart To-Do: "Add to my list" appends the task text to the list', async ({ page }) => {
  const win = await openSmartTodo(page, 'Buy milk');
  const items = win.getByRole('list', { name: 'Tasks', exact: true }).getByRole('listitem');
  await expect(items).toHaveCount(0);

  await pressButton(win, 'Add to my list');

  await expect(items).toHaveText(['Buy milk']);
  // No reminder is created by this button.
  await expect(remindersButton(page, 0)).toBeVisible();
});

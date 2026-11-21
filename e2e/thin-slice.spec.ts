import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * End-to-end tests for the thin slice (Requirements 22.9 to 22.13).
 * They run against the Worker that serves the built web app. No live model is involved,
 * and these tests never send a message to the Ghost.
 */

const STACK_NAME = 'Thin slice to-do';

function stackWindow(page: Page) {
  return page.getByRole('region', { name: STACK_NAME });
}

/** Waits until React has rendered the desktop: Mode control, stack window, Interact checked. */
async function waitForAppReady(page: Page): Promise<void> {
  const modeGroup = page.getByRole('radiogroup', { name: 'Mode' });
  await expect(modeGroup).toBeVisible();
  await expect(stackWindow(page)).toBeVisible();
  await expect(modeGroup.getByRole('radio', { name: 'Interact' })).toBeChecked();
}

/**
 * Presses Alt+M until the named Mode radio is checked. The key press is skipped when the
 * radio is already checked, so a retry never toggles the Mode back. The final
 * `toBeChecked` assertion is the real check and still fails the test if Alt+M never works.
 */
async function pressAltMUntilModeIs(page: Page, label: 'Interact' | 'Edit'): Promise<void> {
  const radio = page
    .getByRole('radiogroup', { name: 'Mode' })
    .getByRole('radio', { name: label, exact: true });
  await expect(async () => {
    if (!(await radio.isChecked())) {
      await page.keyboard.press('Alt+KeyM');
    }
    await expect(radio).toBeChecked({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

test('the retro desktop loads with the shell and contacts only the app origin', async ({
  page,
  baseURL,
}) => {
  expect(baseURL).toBeTruthy();
  const appOrigin = new URL(baseURL ?? '').origin;

  const requestUrls: string[] = [];
  page.on('request', (request) => {
    requestUrls.push(request.url());
  });

  await page.goto('/');

  // Menu bar: heading and the Mode control.
  await expect(page.getByRole('heading', { name: 'HyperGeist', exact: true })).toBeVisible();
  const modeGroup = page.getByRole('radiogroup', { name: 'Mode' });
  await expect(modeGroup).toBeVisible();
  await expect(modeGroup.getByRole('radio', { name: 'Interact' })).toBeChecked();
  await expect(modeGroup.getByRole('radio', { name: 'Edit', exact: true })).not.toBeChecked();

  // Stack window and its status bar.
  await expect(stackWindow(page)).toBeVisible();
  await expect(stackWindow(page).getByText('Mode: Interact', { exact: true })).toBeVisible();
  await expect(stackWindow(page).getByText('Card 1 of 3', { exact: true })).toBeVisible();

  // Ghost window is the chat panel and states the real limits of the AI.
  const ghost = page.getByRole('complementary', { name: 'Ghost chat', exact: true });
  await expect(ghost).toBeVisible();
  await expect(
    ghost.getByText(
      'Demo answers come from a shared model or recorded examples. The AI can make mistakes. Undo restores the stack as it was.',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(ghost.getByRole('textbox', { name: 'Tell the Ghost what to do' })).toBeVisible();

  // Every request, fonts included, goes to the app origin.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForLoadState('networkidle');
  expect(requestUrls.length).toBeGreaterThan(0);
  const origins = requestUrls.map((url) => new URL(url).origin);
  expect(origins.filter((origin) => origin !== appOrigin)).toEqual([]);
});

test('Add appends the item, clears the field and shows the status message', async ({ page }) => {
  await page.goto('/');
  const win = stackWindow(page);
  const field = win.getByRole('textbox', { name: 'New item' });
  const list = win.getByRole('list', { name: 'To-do items' });

  await expect(list.getByRole('listitem')).toHaveCount(0);

  await field.fill('Buy milk');
  await win.getByRole('button', { name: 'Add item', exact: true }).click();

  // The status message lasts 4 seconds, so assert it first and without delay.
  await expect(win.getByRole('status')).toHaveText('Item added.');
  await expect(list.getByRole('listitem')).toHaveText(['Buy milk']);
  await expect(field).toHaveValue('');
});

test('links and Back buttons navigate across the three cards', async ({ page }) => {
  await page.goto('/');
  const win = stackWindow(page);

  await expect(win.getByText('Card 1 of 3', { exact: true })).toBeVisible();

  await win.getByRole('button', { name: 'About this stack', exact: true }).click();
  await expect(win.getByText('Card 2 of 3', { exact: true })).toBeVisible();
  await expect(win.getByRole('textbox', { name: 'About', exact: true })).toBeVisible();

  await win.getByRole('button', { name: 'Limits', exact: true }).click();
  await expect(win.getByText('Card 3 of 3', { exact: true })).toBeVisible();
  await expect(win.getByRole('textbox', { name: 'Limits', exact: true })).toBeVisible();

  await win.getByRole('button', { name: 'Back to about', exact: true }).click();
  await expect(win.getByText('Card 2 of 3', { exact: true })).toBeVisible();

  await win.getByRole('button', { name: 'Back to to-do', exact: true }).click();
  await expect(win.getByText('Card 1 of 3', { exact: true })).toBeVisible();
  await expect(win.getByRole('textbox', { name: 'New item' })).toBeVisible();
});

test('Alt+M toggles Edit mode, selection shows handles and properties, Escape clears', async ({
  page,
}) => {
  await page.goto('/');
  // Wait for React to commit and register the global keydown listener before pressing keys.
  await waitForAppReady(page);
  const win = stackWindow(page);
  const handles = page.locator('.selection-handle');
  const readout = win.getByRole('region', { name: 'Properties' });

  // Alt+M switches to Edit mode.
  await pressAltMUntilModeIs(page, 'Edit');
  await expect(page.getByRole('radio', { name: 'Edit', exact: true })).toBeChecked();
  await expect(win.getByText('Mode: Edit', { exact: true })).toBeVisible();
  await expect(readout.getByText('Select an object to see its properties.')).toBeVisible();
  await expect(handles).toHaveCount(0);

  // In Edit mode each Object is a selectable button named "<name> (<type>)".
  const addButton = win.getByRole('button', { name: 'Add item (button)', exact: true });
  await addButton.click();
  await expect(addButton).toHaveAttribute('aria-pressed', 'true');
  await expect(handles).toHaveCount(8);

  // Property_Readout values for the Button (rows: id, type, name, x, y, width, height, label, onClick).
  const values = readout.getByRole('definition');
  await expect(values.nth(0)).toHaveText('todo-add');
  await expect(values.nth(1)).toHaveText('button');
  await expect(values.nth(2)).toHaveText('Add item');
  await expect(values.nth(7)).toHaveText('Add');

  // Activating the selected Button again runs no Handler.
  await addButton.press('Enter');
  await expect(win.getByRole('status')).not.toHaveText('Item added.');

  // Escape clears the selection.
  await page.keyboard.press('Escape');
  await expect(handles).toHaveCount(0);
  await expect(addButton).toHaveAttribute('aria-pressed', 'false');
  await expect(readout.getByText('Select an object to see its properties.')).toBeVisible();

  // Back in Interact mode the List is still empty, so no Handler ran in Edit mode.
  await pressAltMUntilModeIs(page, 'Interact');
  await expect(page.getByRole('radio', { name: 'Interact' })).toBeChecked();
  await expect(readout).toHaveCount(0);
  await expect(win.getByRole('list', { name: 'To-do items' }).getByRole('listitem')).toHaveCount(0);
});

test('a reload keeps the added item', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  const win = stackWindow(page);
  const list = win.getByRole('list', { name: 'To-do items' });

  await win.getByRole('textbox', { name: 'New item' }).fill('Walk the dog');
  await win.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveText(['Walk the dog']);

  // The save indicator is a live region without a role. It reads "Saving" right after the
  // change and "Saved" once the write finished, which is when a reload is safe.
  await expect(win.getByText('Saved', { exact: true })).toBeVisible();

  await page.reload();
  await waitForAppReady(page);

  const reloaded = stackWindow(page);
  await expect(
    reloaded.getByRole('list', { name: 'To-do items' }).getByRole('listitem'),
  ).toHaveText(['Walk the dog']);
  await expect(reloaded.getByText('Saved', { exact: true })).toBeVisible();

  // The old thin-slice notice is gone, and the Memory_Mode banner (role "note") is not shown.
  await expect(reloaded.getByRole('note')).toHaveCount(0);
  await expect(page.getByText('Changes are not saved')).toHaveCount(0);
});

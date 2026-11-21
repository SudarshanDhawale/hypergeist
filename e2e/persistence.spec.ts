import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page, TestInfo } from '@playwright/test';

/**
 * End-to-end tests for local persistence (Requirement 9.3): first run, edits that survive a
 * reload, delete and restore, restore demo stacks, export then import, refused imports, and
 * the Stacks window's focus handling. They run against the Worker that serves the built web
 * app. No AI call is involved and nothing leaves the app origin.
 *
 * Every Playwright test gets a fresh browser context, so each one starts with an empty
 * IndexedDB and the seeded demo stacks. The thin-slice to-do is the first one and the stack
 * that opens.
 */

const DEMO_NAME = 'Thin slice to-do';
const DEMO_ID = 'thin-slice-todo';
/** The bundled demo stacks seeded on first run: thin-slice-todo, smart-todo, study-deck. */
const SEEDED_COUNT = 3;
/** The stack that opens after the open demo stack is deleted: the next one in the list. */
const NEXT_STACK_NAME = 'Smart To-Do with Reminders';
/** `<slug>-<id>.hypergeist.json`, as built by `exportFilename`. */
const DEMO_EXPORT_FILENAME = 'thin-slice-to-do-thin-slice-todo.hypergeist.json';
const SEED_FILE = 'apps/web/src/stacks/thin-slice-todo.json';

function stackWindow(page: Page, name: string = DEMO_NAME): Locator {
  return page.getByRole('region', { name, exact: true });
}

function stacksButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Stacks', exact: true });
}

function stacksDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Stacks', exact: true });
}

function stacksList(page: Page): Locator {
  return stacksDialog(page).getByRole('list', { name: 'Stacks', exact: true });
}

function trashList(page: Page): Locator {
  return stacksDialog(page).getByRole('list', { name: 'Trash', exact: true });
}

/** Waits until the app has booted and the named stack is on the desktop. */
async function waitForStack(page: Page, name: string = DEMO_NAME): Promise<void> {
  await expect(page.getByRole('heading', { name: 'HyperGeist', exact: true })).toBeVisible();
  await expect(stackWindow(page, name)).toBeVisible();
}

/** Opens the Stacks window and waits until both lists have been read. */
async function openStacksWindow(page: Page): Promise<void> {
  await stacksButton(page).click();
  const dialog = stacksDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Loading stacks.', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Loading trash.', { exact: true })).toHaveCount(0);
}

async function closeStacksWindow(page: Page): Promise<void> {
  const dialog = stacksDialog(page);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(stacksButton(page)).toBeFocused();
}

/** Adds one item to the open to-do stack and waits until it is written to IndexedDB. */
async function addItemAndWaitForSave(page: Page, text: string): Promise<void> {
  const win = stackWindow(page);
  await win.getByRole('textbox', { name: 'New item' }).fill(text);
  await win.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(win.getByRole('list', { name: 'To-do items' }).getByRole('listitem')).toHaveText([
    text,
  ]);
  // The indicator reads "Saving" right after the change and "Saved" when the write finished.
  await expect(win.getByText('Saved', { exact: true })).toBeVisible();
}

function todoItems(page: Page, name: string = DEMO_NAME): Locator {
  return stackWindow(page, name).getByRole('list', { name: 'To-do items' }).getByRole('listitem');
}

/** The text of the bundled demo stack, a valid file whose id is already in use after first run. */
function readSeedText(testInfo: TestInfo): string {
  // `rootDir` is the Playwright test directory (`e2e`), so the repo root is one level up.
  return readFileSync(path.resolve(testInfo.config.rootDir, '..', SEED_FILE), 'utf8');
}

function writeTempFile(testInfo: TestInfo, name: string, text: string): string {
  const file = testInfo.outputPath(name);
  writeFileSync(file, text, 'utf8');
  return file;
}

/** Clicks Export on the demo row and returns the file the browser downloaded. */
async function exportDemoStack(page: Page, testInfo: TestInfo, savedAs: string): Promise<string> {
  const exportButton = stacksDialog(page).getByRole('button', {
    name: `Export ${DEMO_NAME}`,
    exact: true,
  });
  const [download] = await Promise.all([page.waitForEvent('download'), exportButton.click()]);
  expect(download.suggestedFilename()).toBe(DEMO_EXPORT_FILENAME);
  const target = testInfo.outputPath(savedAs);
  await download.saveAs(target);
  return readFileSync(target, 'utf8');
}

test('first run opens the seeded to-do stack and the Stacks window lists every demo stack, with this one as Demo and open', async ({
  page,
}) => {
  await page.goto('/');
  await waitForStack(page);
  await expect(todoItems(page)).toHaveCount(0);

  await openStacksWindow(page);
  const rows = stacksList(page).getByRole('listitem');
  await expect(rows).toHaveCount(SEEDED_COUNT);
  const row = rows.filter({ hasText: DEMO_NAME });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('Demo', { exact: true })).toBeVisible();
  await expect(row.getByText('Open', { exact: true })).toBeVisible();
  // The open stack has no Open button.
  await expect(
    stacksDialog(page).getByRole('button', { name: `Open ${DEMO_NAME}`, exact: true }),
  ).toHaveCount(0);

  await expect(trashList(page).getByText('The trash is empty.', { exact: true })).toBeVisible();
});

test('delete the open demo stack, the next stack opens, and restoring from the trash brings the content back', async ({
  page,
}) => {
  await page.goto('/');
  await waitForStack(page);
  await addItemAndWaitForSave(page, 'Buy milk');

  await openStacksWindow(page);
  const dialog = stacksDialog(page);
  await dialog.getByRole('button', { name: `Delete ${DEMO_NAME}`, exact: true }).click();
  await expect(
    dialog.getByText(`Moved "${DEMO_NAME}" to the trash.`, { exact: true }),
  ).toBeVisible();

  // The next stack in the list replaces the deleted open one, so the app always has a stack.
  const rows = stacksList(page).getByRole('listitem');
  await expect(rows).toHaveCount(SEEDED_COUNT - 1);
  await expect(rows.filter({ hasText: DEMO_NAME })).toHaveCount(0);
  await expect(rows.filter({ hasText: NEXT_STACK_NAME })).toHaveCount(1);
  const trashRows = trashList(page).getByRole('listitem');
  await expect(trashRows).toHaveCount(1);
  await expect(trashRows.filter({ hasText: DEMO_NAME })).toHaveCount(1);

  await closeStacksWindow(page);
  await expect(stackWindow(page, NEXT_STACK_NAME)).toBeVisible();
  await expect(stackWindow(page)).toHaveCount(0);

  // The deleted demo stack is not seeded again after a reload.
  await page.reload();
  await waitForStack(page, NEXT_STACK_NAME);
  await openStacksWindow(page);
  await expect(stacksList(page).getByRole('listitem')).toHaveCount(SEEDED_COUNT - 1);
  await expect(trashList(page).getByRole('listitem').filter({ hasText: DEMO_NAME })).toHaveCount(1);

  // Restore from the trash, then open it: the item added before the delete is back.
  await dialog.getByRole('button', { name: `Restore ${DEMO_NAME}`, exact: true }).click();
  await expect(dialog.getByText(`Restored "${DEMO_NAME}".`, { exact: true })).toBeVisible();
  await expect(stacksList(page).getByRole('listitem')).toHaveCount(SEEDED_COUNT);
  await expect(trashList(page).getByText('The trash is empty.', { exact: true })).toBeVisible();

  await dialog.getByRole('button', { name: `Open ${DEMO_NAME}`, exact: true }).click();
  await expect(dialog).toBeHidden();
  await waitForStack(page);
  await expect(todoItems(page)).toHaveText(['Buy milk']);
});

test('Restore demo stacks puts the originals back and keeps the replaced copies in the trash', async ({
  page,
}) => {
  await page.goto('/');
  await waitForStack(page);
  await addItemAndWaitForSave(page, 'Edited item');

  await openStacksWindow(page);
  const dialog = stacksDialog(page);
  await dialog.getByRole('button', { name: 'Restore demo stacks', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Restore demo stacks', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Restore demo stacks', exact: true }).click();
  await expect(confirm).toBeHidden();

  await expect(
    dialog.getByText(
      `Restored ${SEEDED_COUNT} demo stacks. The versions you had are in the trash.`,
      { exact: true },
    ),
  ).toBeVisible();
  await expect(stacksList(page).getByRole('listitem')).toHaveCount(SEEDED_COUNT);
  // Every demo stack that was replaced goes to the trash, edited or not.
  const trashRows = trashList(page).getByRole('listitem');
  await expect(trashRows).toHaveCount(SEEDED_COUNT);
  await expect(trashRows.filter({ hasText: DEMO_NAME })).toHaveCount(1);

  // The open stack was reloaded from storage: the original content, without the edit.
  await closeStacksWindow(page);
  await waitForStack(page);
  await expect(todoItems(page)).toHaveCount(0);
});

test('cancelling Restore demo stacks changes nothing', async ({ page }) => {
  await page.goto('/');
  await waitForStack(page);
  await addItemAndWaitForSave(page, 'Keep me');

  await openStacksWindow(page);
  const dialog = stacksDialog(page);
  await dialog.getByRole('button', { name: 'Restore demo stacks', exact: true }).click();

  const confirm = page.getByRole('dialog', { name: 'Restore demo stacks', exact: true });
  await expect(confirm).toBeVisible();
  // Cancel is the default button of the confirm dialog.
  await expect(confirm.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeVisible();

  await closeStacksWindow(page);
  await expect(todoItems(page)).toHaveText(['Keep me']);

  // Read the storage again: still every demo stack, an empty trash.
  await openStacksWindow(page);
  await expect(stacksList(page).getByRole('listitem')).toHaveCount(SEEDED_COUNT);
  await expect(trashList(page).getByText('The trash is empty.', { exact: true })).toBeVisible();
});

test('export then import the same file gives back an identical stack', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  await waitForStack(page);
  await addItemAndWaitForSave(page, 'Export me');

  // Export the demo stack and keep the file.
  await openStacksWindow(page);
  const dialog = stacksDialog(page);
  const firstText = await exportDemoStack(page, testInfo, 'first-export.hypergeist.json');
  await expect(
    dialog.getByText(`Exported ${DEMO_EXPORT_FILENAME}.`, { exact: true }),
  ).toBeVisible();
  const exported: unknown = JSON.parse(firstText);
  expect(exported).toMatchObject({ id: DEMO_ID, name: DEMO_NAME });
  expect(firstText).toContain('Export me');

  // Delete it for good: to the trash, then out of the trash.
  await dialog.getByRole('button', { name: `Delete ${DEMO_NAME}`, exact: true }).click();
  await expect(
    dialog.getByText(`Moved "${DEMO_NAME}" to the trash.`, { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole('button', { name: `Delete ${DEMO_NAME} permanently`, exact: true })
    .click();
  const confirm = page.getByRole('dialog', { name: 'Delete permanently', exact: true });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(confirm).toBeHidden();
  await expect(
    dialog.getByText(`Deleted "${DEMO_NAME}" permanently.`, { exact: true }),
  ).toBeVisible();
  await expect(trashList(page).getByText('The trash is empty.', { exact: true })).toBeVisible();
  await expect(stacksList(page).getByRole('listitem').filter({ hasText: DEMO_NAME })).toHaveCount(
    0,
  );

  // Import the saved file through the hidden file input. The stack opens and the window closes.
  await dialog
    .getByLabel('Stack file to import', { exact: true })
    .setInputFiles(testInfo.outputPath('first-export.hypergeist.json'));
  await expect(dialog).toBeHidden();
  await waitForStack(page);
  await expect(todoItems(page)).toHaveText(['Export me']);

  // The imported stack and the other demo stacks are stored, and exporting again gives the same bytes.
  await openStacksWindow(page);
  await expect(stacksList(page).getByRole('listitem')).toHaveCount(SEEDED_COUNT);
  const secondText = await exportDemoStack(page, testInfo, 'second-export.hypergeist.json');
  expect(secondText).toBe(firstText);
});

test('an invalid import shows the errors and stores nothing', async ({ page }, testInfo) => {
  const notJson = writeTempFile(testInfo, 'not-json.json', 'not json');
  const wrongProperty = writeTempFile(
    testInfo,
    'wrong-property.json',
    JSON.stringify({
      ...(JSON.parse(readSeedText(testInfo)) as object),
      id: 'other-stack',
      bogus: 1,
    }),
  );

  await page.goto('/');
  await waitForStack(page);

  // Each bad file gets a freshly opened window, so a notice cannot be left over from the
  // previous file. Then the window is opened again to read both lists from storage.
  for (const badFile of [notJson, wrongProperty]) {
    await openStacksWindow(page);
    const dialog = stacksDialog(page);
    await dialog.getByLabel('Stack file to import', { exact: true }).setInputFiles(badFile);
    await expect(
      dialog.getByText('This file was not imported, and nothing was stored.', { exact: true }),
    ).toBeVisible();
    await expect(
      dialog
        .getByRole('list', { name: 'Import problems', exact: true })
        .getByRole('listitem')
        .first(),
    ).toBeVisible();
    await expect(dialog).toBeVisible();
    await closeStacksWindow(page);
    await expect(stackWindow(page)).toBeVisible();

    await openStacksWindow(page);
    const rows = stacksList(page).getByRole('listitem');
    await expect(rows).toHaveCount(SEEDED_COUNT);
    await expect(rows.filter({ hasText: DEMO_NAME })).toHaveCount(1);
    await expect(trashList(page).getByText('The trash is empty.', { exact: true })).toBeVisible();
    await closeStacksWindow(page);
  }
});

test('importing a stack whose id is in use offers a copy, and Cancel changes nothing', async ({
  page,
}, testInfo) => {
  const sameId = writeTempFile(testInfo, 'same-id.hypergeist.json', readSeedText(testInfo));

  await page.goto('/');
  await waitForStack(page);
  await openStacksWindow(page);
  const dialog = stacksDialog(page);
  const fileInput = dialog.getByLabel('Stack file to import', { exact: true });
  const conflict = page.getByRole('dialog', { name: 'This stack id is in use', exact: true });

  // Cancel: no new stack, the existing one is untouched.
  await fileInput.setInputFiles(sameId);
  await expect(conflict).toBeVisible();
  await expect(conflict).toContainText(`"${DEMO_ID}"`);
  await expect(conflict).toContainText(`"${DEMO_ID}-copy"`);
  await conflict.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(conflict).toBeHidden();
  await expect(dialog).toBeVisible();
  await closeStacksWindow(page);
  await expect(stackWindow(page)).toBeVisible();
  await openStacksWindow(page);
  await expect(stacksList(page).getByRole('listitem')).toHaveCount(SEEDED_COUNT);

  // Import as a copy: one more stack is stored and opened, and the window closes.
  await fileInput.setInputFiles(sameId);
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: 'Import as a copy', exact: true }).click();
  await expect(conflict).toBeHidden();
  await expect(dialog).toBeHidden();

  await openStacksWindow(page);
  const rows = stacksList(page).getByRole('listitem');
  await expect(rows).toHaveCount(SEEDED_COUNT + 1);
  await expect(rows.filter({ hasText: DEMO_NAME })).toHaveCount(2);
  await expect(trashList(page).getByText('The trash is empty.', { exact: true })).toBeVisible();
});

test('Escape closes the Stacks window and focus returns to the Stacks button', async ({ page }) => {
  await page.goto('/');
  await waitForStack(page);

  await stacksButton(page).click();
  const dialog = stacksDialog(page);
  await expect(dialog).toBeVisible();
  // The window takes focus when it opens, so the key press reaches it.
  await expect(dialog).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(stacksButton(page)).toBeFocused();
});

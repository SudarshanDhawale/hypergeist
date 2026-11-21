import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * End-to-end tests for the Ghost (Requirement 7.3 of the AI assistant UI spec). They run
 * against the Worker that serves the built web app. The Worker has no model configured in
 * e2e, so `/api/ai/chat` answers an error and the controller falls back to the recorded
 * examples, adding the demo note. Nothing here needs a live model or a key.
 */

const STACK_NAME = 'Thin slice to-do';
const NEW_STACK_NAME = 'To-do';
const DEMO_NOTE = 'The demo model could not be reached, so this answer is a recorded example.';

function stackWindow(page: Page, name: string = STACK_NAME): Locator {
  return page.getByRole('region', { name, exact: true });
}

function ghostPanel(page: Page): Locator {
  return page.getByRole('complementary', { name: 'Ghost chat', exact: true });
}

function modeRadio(page: Page, label: 'Interact' | 'Edit' | 'AI edit'): Locator {
  return page.getByRole('radiogroup', { name: 'Mode' }).getByRole('radio', {
    name: label,
    exact: true,
  });
}

/** Waits until React has rendered the desktop, the Ghost chat and the checked Interact mode. */
async function waitForAppReady(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'HyperGeist', exact: true })).toBeVisible();
  await expect(stackWindow(page)).toBeVisible();
  await expect(modeRadio(page, 'Interact')).toBeChecked();
  await expect(ghostPanel(page)).toBeVisible();
}

/** Clicks an example button of the Ghost chat, then Send, and waits for the answer. */
async function askGhostWithExample(page: Page, example: string): Promise<void> {
  const ghost = ghostPanel(page);
  await ghost.getByRole('button', { name: example, exact: true }).click();
  await expect(ghost.getByRole('textbox', { name: 'Tell the Ghost what to do' })).toHaveValue(
    example,
  );
  await ghost.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(ghost.getByText(DEMO_NOTE, { exact: true })).toBeVisible();
}

test('the Ghost chat answers an example prompt with the recorded example and the demo note', async ({
  page,
}) => {
  await page.goto('/');
  await waitForAppReady(page);
  const ghost = ghostPanel(page);

  await askGhostWithExample(page, 'Add a button');

  // The user's line, the recorded answer and the note about the fallback.
  await expect(ghost.getByText('You: Add a button', { exact: true })).toBeVisible();
  await expect(ghost.getByText('I added a button.', { exact: true })).toBeVisible();
  await expect(ghost.getByText('Done.', { exact: true })).toBeVisible();

  // The input was cleared and the chat is idle again, with an Undo available.
  await expect(ghost.getByRole('textbox', { name: 'Tell the Ghost what to do' })).toHaveValue('');
  await expect(ghost.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
  await expect(ghost.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
});

test('Undo restores the stack as it was before the AI change', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  const win = stackWindow(page);
  const ghost = ghostPanel(page);
  const buttons = win.getByRole('button');

  const before = await buttons.count();
  await expect(ghost.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();

  await askGhostWithExample(page, 'Add a button');
  await expect(buttons).toHaveCount(before + 1);

  await ghost.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(buttons).toHaveCount(before);
  await expect(ghost.getByText(/^Undid: /)).toBeVisible();
  await expect(ghost.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
});

test('AI edit mode selects an object and the Ghost shows what is selected', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  const win = stackWindow(page);
  const ghost = ghostPanel(page);

  await modeRadio(page, 'AI edit').check();
  await expect(modeRadio(page, 'AI edit')).toBeChecked();
  await expect(win.getByText('Mode: AI edit', { exact: true })).toBeVisible();
  await expect(ghost.getByText(/^Selected: /)).toHaveCount(0);

  // In AI edit mode each Object is a selectable button named "<name> (<type>)".
  const addButton = win.getByRole('button', { name: 'Add item (button)', exact: true });
  await addButton.click();
  await expect(addButton).toHaveAttribute('aria-pressed', 'true');
  await expect(ghost.getByText('Selected: Add item (button)', { exact: true })).toBeVisible();

  // Escape clears the selection and the chip.
  await page.keyboard.press('Escape');
  await expect(addButton).toHaveAttribute('aria-pressed', 'false');
  await expect(ghost.getByText(/^Selected: /)).toHaveCount(0);
});

test('"Make a stack with the Ghost" creates and opens a to-do stack that then works', async ({
  page,
}) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByRole('button', { name: 'Stacks', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stacks', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Make a stack with the Ghost' })).toBeVisible();

  await dialog.getByRole('textbox', { name: 'Describe the stack' }).fill('Make me a to-do list');
  await dialog.getByRole('button', { name: 'Make it', exact: true }).click();

  // The made stack is stored and opened, and the window closes.
  await expect(dialog).toBeHidden();
  const win = stackWindow(page, NEW_STACK_NAME);
  await expect(win).toBeVisible();
  await expect(stackWindow(page)).toHaveCount(0);

  // The recorded to-do list works: type a task, press Add, the item appears.
  const list = win.getByRole('list', { name: 'To-do items' });
  await expect(list.getByRole('listitem')).toHaveCount(0);
  await win.getByRole('textbox', { name: 'New item' }).fill('Buy milk');
  await win.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(list.getByRole('listitem')).toHaveText(['Buy milk']);
  await expect(win.getByRole('textbox', { name: 'New item' })).toHaveValue('');
});

test('the AI settings dialog rejects a base URL that does not start with https', async ({
  page,
}) => {
  await page.goto('/');
  await waitForAppReady(page);

  await page.getByRole('button', { name: 'AI settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'AI settings', exact: true });
  await expect(dialog).toBeVisible();

  // Demo mode has no URL field.
  await expect(dialog.getByRole('textbox', { name: 'Base URL' })).toHaveCount(0);

  await dialog.getByRole('radio', { name: 'My own model', exact: true }).check();
  const url = dialog.getByRole('textbox', { name: 'Base URL', exact: true });
  await expect(url).toBeVisible();

  await url.fill('ftp://example.com');
  await expect(dialog.getByText('The web address must start with https://')).toBeVisible();
  await expect(url).toHaveAttribute('aria-invalid', 'true');

  // Save refuses to store it: no "Saved." notice.
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog.getByText('Saved.', { exact: true })).toHaveCount(0);

  // A valid address clears the message.
  await url.fill('https://api.example.com/v1');
  await expect(dialog.getByText('The web address must start with https://')).toHaveCount(0);
  await expect(url).toHaveAttribute('aria-invalid', 'false');
});

test('the demo counter stays hidden when the quota route answers an error', async ({ page }) => {
  await page.route('**/api/ai/quota', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'AI_DISABLED', message: 'AI is not configured.' } }),
    });
  });

  await page.goto('/');
  await waitForAppReady(page);

  // A Turn refreshes the quota when it ends, so the route is asked at least once.
  const quotaAnswered = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith('/api/ai/quota'),
  );
  await askGhostWithExample(page, 'Add a button');
  const response = await quotaAnswered;
  expect(response.ok()).toBe(false);

  await expect(page.getByText(/^Demo: \d+ left today$/)).toHaveCount(0);
  await expect(page.getByText('Demo limit reached: examples only', { exact: true })).toHaveCount(0);
});

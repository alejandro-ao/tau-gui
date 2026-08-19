import { expect, test } from '@playwright/test';
import { launchApp, submitPrompt, transcript, waitForSettled, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  // A per-chunk delay keeps the streaming phase observable without flakiness.
  handle = await launchApp({ env: { FAKE_RUNTIME_DELAY_MS: '40' } });
});

test.afterEach(async () => {
  await handle.close();
});

test('a prompt streams assistant text and then finalizes', async () => {
  const { page } = handle;
  await submitPrompt(page, 'hello there');

  await expect(page.locator('.block-user')).toContainText('hello there');

  // Streaming phase: caret marker plus CLI-style running spinner.
  await expect(page.locator('.streaming-caret')).toBeVisible();
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'running');
  const spinner = page.getByTestId('composer').getByRole('status', { name: 'Model working' });
  await expect(spinner).toBeVisible();
  await expect(page.locator('.prompt-slot .activity-spinner')).toHaveCount(0);

  await waitForSettled(page);
  await expect(page.locator('.streaming-caret')).toHaveCount(0);
  await expect(page.locator('.block-assistant')).toContainText('Hello from the tau fake runtime.');
  await expect(page.getByLabel('composer')).toHaveValue('');
});

test('a thinking run renders a thinking block before the answer', async () => {
  const { page } = handle;
  await submitPrompt(page, 'show thinking please');
  await waitForSettled(page);

  await expect(page.locator('.block-thinking')).toContainText('Considering the request carefully.');
  await expect(page.locator('.block-assistant')).toContainText('Here is the answer.');
  expect(await transcript(page).innerText()).toContain('thinking');
});

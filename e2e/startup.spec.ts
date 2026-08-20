import { expect, test } from '@playwright/test';
import { launchApp, waitForSettled, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeAll(async () => {
  handle = await launchApp();
});

test.afterAll(async () => {
  await handle.close();
});

test('window opens, connects to the runtime, and reports session context', async () => {
  const { page } = handle;

  expect(page.url()).toContain('index.html');
  await expect(page.locator('.app')).toBeVisible();
  await waitForSettled(page);

  // Sidebar follows the TUI structure: title, activity, version mark.
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('.sidebar-title')).toContainText('untitled session');
  await expect(sidebar).toContainText('activity');
  await expect(sidebar.locator('.version-mark')).toContainText('τ = 2π');
  await expect(sidebar.locator('.version-mark')).toContainText('pi');

  // Status row reports the working directory and the active model.
  const status = page.getByTestId('status-row');
  await expect(status).toContainText(handle.projectDir);
  await expect(status.getByRole('button', { name: /fake-large/ })).toBeVisible();

  await expect(page.getByTestId('composer')).toHaveAttribute('data-status', 'idle');
  await expect(page.getByRole('log', { name: 'transcript' })).toContainText('No messages yet');
});

test('the runtime is idle and the composer is focused for typing', async () => {
  const { page } = handle;
  await page.getByLabel('composer').click();
  await expect(page.getByLabel('composer')).toBeFocused();
  await expect(page.getByTestId('prompt-slot')).toContainText('idle');
});

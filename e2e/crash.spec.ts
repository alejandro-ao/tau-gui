import { expect, test } from '@playwright/test';
import {
  composer,
  killRuntime,
  launchApp,
  submitPrompt,
  transcript,
  typeDraft,
  waitForConnected,
  waitForSettled,
  type AppHandle,
} from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test('a killed runtime shows the disconnected state and restarts cleanly', async () => {
  const { page, marker } = handle;
  await submitPrompt(page, 'before the crash');
  await waitForSettled(page);
  await typeDraft(page, 'draft to keep across the crash');

  await killRuntime(marker);

  const notice = page.getByTestId('connection-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-state', 'disconnected');
  await expect(notice).toContainText('Runtime disconnected');
  await expect(notice).toContainText('Runtime exited unexpectedly');
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'disconnected');

  // The local draft is never lost by a runtime failure.
  await expect(composer(page)).toHaveValue('draft to keep across the crash');

  await notice.getByRole('button', { name: 'restart' }).click();

  await waitForConnected(page);
  await expect(notice).toHaveCount(0);
  await expect(composer(page)).toHaveValue('draft to keep across the crash');
  await expect(transcript(page)).toContainText('No messages yet');

  // The restarted runtime accepts prompts again.
  await composer(page).press('Enter');
  await waitForSettled(page);
  await expect(page.locator('.block-assistant')).toContainText('Hello from the tau fake runtime.');
});

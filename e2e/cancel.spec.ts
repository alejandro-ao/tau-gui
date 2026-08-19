import { expect, test } from '@playwright/test';
import {
  composer,
  launchApp,
  submitPrompt,
  typeDraft,
  waitForSettled,
  type AppHandle,
} from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  handle = await launchApp({ env: { FAKE_RUNTIME_DELAY_MS: '60' } });
});

test.afterEach(async () => {
  await handle.close();
});

test('Esc aborts the running turn and the composer stays usable', async () => {
  const { page } = handle;
  await submitPrompt(page, 'slow run please');

  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'running');
  await expect(page.getByRole('button', { name: 'esc abort' })).toBeVisible();

  await composer(page).press('Escape');

  await waitForSettled(page);
  await expect(page.locator('.block-assistant .block-label')).toContainText('aborted');
  await expect(page.getByRole('button', { name: 'esc abort' })).toHaveCount(0);

  // The composer keeps working straight after an abort.
  await typeDraft(page, 'after abort');
  await composer(page).press('Enter');
  await waitForSettled(page);
  await expect(page.locator('.block-user').last()).toContainText('after abort');
});

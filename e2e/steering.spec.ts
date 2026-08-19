import { expect, test } from '@playwright/test';
import {
  composer,
  launchApp,
  submitPrompt,
  transcript,
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

test('Enter steers the active run and Alt+Enter queues a follow-up', async () => {
  const { page } = handle;
  await submitPrompt(page, 'slow run so it can be steered');
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'running');

  // Enter while running steers instead of starting a second run.
  await typeDraft(page, 'steer me');
  await composer(page).press('Enter');
  await expect(
    page.getByTestId('prompt-slot').locator('.queued-message[data-kind="steering"]'),
  ).toContainText('steer me');

  // Alt+Enter queues a follow-up for after the current run.
  await typeDraft(page, 'follow me');
  await composer(page).press('Alt+Enter');
  await expect(
    page.getByTestId('prompt-slot').locator('.queued-message[data-kind="follow-up"]'),
  ).toContainText('follow me');

  await expect(page.locator('.block-user', { hasText: 'steer me' })).toBeVisible();
  await expect(
    page.getByTestId('prompt-slot').locator('.queued-message[data-kind="steering"]'),
  ).toHaveCount(0);

  await expect(page.locator('.block-user', { hasText: 'follow me' })).toBeVisible();
  await expect(page.getByTestId('prompt-slot').locator('.queued-message')).toHaveCount(0);
  await waitForSettled(page);

  const text = await transcript(page).innerText();
  expect(text).toContain('Acknowledged: steer me');
  expect(text).toContain('Acknowledged: follow me');

  // Everything drained and the run settled exactly once.
  await expect(page.getByTestId('prompt-slot').locator('.queued-message')).toHaveCount(0);
  await expect(page.locator('.block-user')).toHaveCount(3);
  await expect(page.getByLabel('composer')).toHaveValue('');

  // No further activity after settling.
  await page.waitForTimeout(500);
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
  await expect(page.locator('.block-user')).toHaveCount(3);
});

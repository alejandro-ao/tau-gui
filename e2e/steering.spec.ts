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

test('popped follow-up is removed and edited text runs only after explicit resubmission', async () => {
  const { page } = handle;
  await submitPrompt(page, 'slow run for editable queue');
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'running');

  await typeDraft(page, 'priority first');
  await composer(page).press('Enter');
  await typeDraft(page, 'remove this follow-up');
  await composer(page).press('Alt+Enter');
  await expect(
    page.getByTestId('prompt-slot').locator('.queued-message[data-kind="follow-up"]'),
  ).toContainText('remove this follow-up');

  // Empty-composer Up performs an atomic main-process pop, not a visual copy.
  await composer(page).press('ArrowUp');
  await expect(composer(page)).toHaveValue('remove this follow-up');
  await expect(
    page.getByTestId('prompt-slot').locator('.queued-message[data-kind="follow-up"]'),
  ).toHaveCount(0);
  await expect(page.locator('.block-user', { hasText: 'remove this follow-up' })).toHaveCount(0);

  await composer(page).fill('edited and requeued');
  await expect(page.locator('.block-user', { hasText: 'edited and requeued' })).toHaveCount(0);
  await composer(page).press('Enter');

  // Steering-priority FIFO drains as fresh prompts after each settled turn.
  await expect(page.locator('.block-user', { hasText: 'priority first' })).toBeVisible();
  await expect(page.locator('.block-user', { hasText: 'edited and requeued' })).toBeVisible();
  await waitForSettled(page);

  const text = await transcript(page).innerText();
  expect(text).not.toContain('remove this follow-up');
  await expect(page.locator('.block-user')).toHaveCount(3);
  await expect(page.getByTestId('prompt-slot').locator('.queued-message')).toHaveCount(0);
});

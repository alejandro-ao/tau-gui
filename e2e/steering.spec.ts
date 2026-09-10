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
  await typeDraft(page, 'priority second\nhidden preview detail');
  await composer(page).press('Enter');
  await typeDraft(page, 'remove this follow-up');
  await composer(page).press('Alt+Enter');

  const queue = page.getByTestId('prompt-slot').locator('.queued-messages');
  await expect(queue.locator('.queued-message')).toHaveCount(3);
  await expect(queue.locator('.queued-message-preview')).toHaveText([
    'priority first',
    'priority second',
    'remove this follow-up',
  ]);
  await expect(queue.locator('.queued-message-label')).toHaveText([
    'steering',
    'steering',
    'follow up',
  ]);
  await expect(queue).not.toContainText('hidden preview detail');
  await expect(queue.locator('.queued-message[data-latest="true"]')).toContainText(
    'remove this follow-up',
  );
  const rows = queue.locator('.queued-message');
  const rowBounds = await Promise.all([0, 1, 2].map((index) => rows.nth(index).boundingBox()));
  expect(rowBounds.every((bounds) => bounds?.height === rowBounds[0]?.height)).toBe(true);
  const queueBounds = await queue.boundingBox();
  const composerBounds = await page.locator('.composer').boundingBox();
  expect(queueBounds).not.toBeNull();
  expect(composerBounds).not.toBeNull();
  expect(queueBounds!.y + queueBounds!.height).toBeLessThanOrEqual(composerBounds!.y);

  const removable = rows.nth(1);
  const removeButton = removable.locator('.queued-message-remove');
  await expect(removeButton).toHaveCSS('opacity', '0');
  await removable.hover();
  await expect(removeButton).toHaveCSS('opacity', '1');
  await removeButton.click();
  await expect(queue.locator('.queued-message-preview')).toHaveText([
    'priority first',
    'remove this follow-up',
  ]);

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
  expect(text).not.toContain('priority second');
  await expect(page.locator('.block-user')).toHaveCount(3);
  await expect(page.getByTestId('prompt-slot').locator('.queued-message')).toHaveCount(0);
});

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
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test('Ctrl+N starts a new session, clearing the transcript but keeping the draft', async () => {
  const { page } = handle;
  await submitPrompt(page, 'first session prompt');
  await waitForSettled(page);
  await expect(page.locator('.block-assistant')).toHaveCount(1);

  await typeDraft(page, 'draft that must survive');
  await page.keyboard.press('Control+n');

  await expect(transcript(page)).toContainText('No messages yet');
  await expect(page.locator('.block-user')).toHaveCount(0);
  await expect(composer(page)).toHaveValue('draft that must survive');
  await waitForSettled(page);
});

test('/new from the composer clears the transcript too', async () => {
  const { page } = handle;
  await submitPrompt(page, 'another prompt');
  await waitForSettled(page);

  await typeDraft(page, '/new');
  // Slash completion is open; Enter runs the highlighted command.
  await expect(page.getByTestId('completion-slash')).toBeVisible();
  await composer(page).press('Enter');

  await expect(transcript(page)).toContainText('No messages yet');
  await expect(composer(page)).toHaveValue('');
});

test('the recent-session picker lists the session remembered by the app', async () => {
  const { page } = handle;
  await composer(page).fill('/resume');
  await composer(page).press('Enter');

  const picker = page.getByTestId('modal-session');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('option')).toHaveCount(1);
  await expect(picker.getByRole('option').first()).toContainText('fake-session-1');
  await expect(picker).toContainText('recent sessions remembered by this app');

  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
});

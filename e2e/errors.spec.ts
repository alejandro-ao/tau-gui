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
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test('a runtime error renders an error block and leaves the composer usable', async () => {
  const { page } = handle;
  await submitPrompt(page, 'trigger an error please');
  await waitForSettled(page);

  const error = page.locator('.block-error');
  await expect(error).toHaveCount(1);
  await expect(error).toContainText('provider unavailable (503)');
  await expect(error.locator('.block-label')).toContainText('error');

  // The partial answer is still shown next to the failure.
  await expect(page.locator('.block-assistant')).toContainText('I could not reach the provider.');

  await typeDraft(page, 'recovered prompt');
  await composer(page).press('Enter');
  await waitForSettled(page);
  await expect(page.locator('.block-assistant').last()).toContainText('Hello from the tau');
});

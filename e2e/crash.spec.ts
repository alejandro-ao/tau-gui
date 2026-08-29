import { expect, test } from '@playwright/test';
import {
  composer,
  launchApp,
  submitPrompt,
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

test('stops every Pi owner and restarts cleanly without losing the draft', async () => {
  const { page } = handle;
  await submitPrompt(page, 'before restart');
  await waitForSettled(page);
  await typeDraft(page, 'draft to keep across restart');

  await page.evaluate(`window.tau.invoke('runtime.stop')`);
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'stopped');
  await page.evaluate(`window.tau.invoke('runtime.restart')`);
  await waitForConnected(page);
  await expect(composer(page)).toHaveValue('draft to keep across restart');
  await composer(page).press('Enter');
  await waitForSettled(page);
  await expect(page.locator('.block-assistant')).toContainText('embedded fake Pi');
});

import { expect, test } from '@playwright/test';
import { composer, launchApp, typeDraft, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test('shell mode runs !echo hi and shows the output in the transcript', async () => {
  const { page } = handle;
  await typeDraft(page, '!echo hi');

  // Shell mode is signalled before submission.
  await expect(page.getByTestId('composer')).toHaveAttribute('data-shell', 'true');
  await expect(page.locator('.composer-prefix')).toHaveText('$');

  await composer(page).press('Enter');

  const shell = page.locator('.block-shell');
  await expect(shell).toHaveCount(1);
  await expect(shell.locator('.shell-command')).toHaveText('$ echo hi');
  await expect(shell.locator('.tool-output')).toContainText('fake output for: echo hi');
  await expect(shell.locator('.shell-exit')).toContainText('exit 0');
  await expect(composer(page)).toHaveValue('');
});

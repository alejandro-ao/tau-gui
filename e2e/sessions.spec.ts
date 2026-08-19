import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

test('Shift+Ctrl+N chooses and persists a working directory before starting', async () => {
  const { app, page, userDataDir } = handle;
  const chosen = join(userDataDir, 'chosen-project');
  mkdirSync(chosen);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [directory] });
  }, chosen);

  await page.keyboard.press('Control+Shift+n');
  await waitForSettled(page);
  await expect(page.getByTestId('sessions-rail')).toContainText('chosen-project');

  const persisted = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as {
    cwd: string;
    workingDirectories: string[];
  };
  expect(persisted.cwd).toBe(chosen);
  expect(persisted.workingDirectories[0]).toBe(chosen);
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
  await page.getByTestId('sidebar').getByRole('button', { name: 'sessions' }).click();

  const picker = page.getByTestId('modal-session');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('option')).toHaveCount(1);
  await expect(picker.getByRole('option').first()).toContainText('fake-session-1');
  await expect(picker).toContainText('recent sessions remembered by this app');

  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
});

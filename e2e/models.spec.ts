import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from '../src/shared/domain.js';
import { modelKey } from '../src/shared/scoped-models.js';
import { launchApp, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test('the status row opens the model picker and reflects the new model', async () => {
  const { page } = handle;
  const status = page.getByTestId('status-row');

  await status.getByRole('button', { name: /fake-large/ }).click();
  const picker = page.getByTestId('modal-model');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('option', { name: /Fake Large/ })).toHaveAttribute(
    'data-current',
    'true',
  );

  await picker.getByRole('option', { name: /Fake Small/ }).click();

  await expect(picker).toHaveCount(0);
  await expect(status.getByRole('button', { name: /fake:fake-small/ })).toBeVisible();
});

test('/scoped-models scopes models and constrains Ctrl+P cycling', async () => {
  const { page } = handle;
  const status = page.getByTestId('status-row');

  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('modal-palette');
  await palette.getByRole('combobox').fill('scoped-models');
  await palette.getByRole('option', { name: '/scoped-models' }).first().click();

  const scoped = page.getByTestId('modal-scoped');
  await expect(scoped).toBeVisible();

  // Keyboard parity: Enter toggles scope on the highlighted row.
  await scoped.getByRole('combobox').fill('Fake Small');
  await page.keyboard.press('Enter');
  await expect(scoped.getByRole('option', { name: /Fake Small/ })).toContainText('scoped');
  // Scoping must not switch the active model.
  await expect(status.getByRole('button', { name: /fake:fake-large/ })).toBeVisible();

  await scoped.getByRole('combobox').fill('Fake Large');
  await scoped.getByRole('option', { name: /Fake Large/ }).click();
  await expect(scoped).toContainText('2 scoped');

  await page.keyboard.press('Escape');
  await expect(scoped).toHaveCount(0);

  await page.keyboard.press('Control+p');
  await expect(status.getByRole('button', { name: /fake:fake-small/ })).toBeVisible();
  await page.keyboard.press('Control+p');
  await expect(status.getByRole('button', { name: /fake:fake-large/ })).toBeVisible();

  // The selection is owned by the main process, not by renderer storage.
  const persisted = JSON.parse(
    readFileSync(join(handle.userDataDir, 'settings.json'), 'utf8'),
  ) as AppSettings;
  expect(persisted.scopedModels).toEqual({
    tau: [
      modelKey({ provider: 'fake', modelId: 'fake-small' }),
      modelKey({ provider: 'fake', modelId: 'fake-large' }),
    ],
    pi: [],
  });
});

test('the palette also reaches the model picker', async () => {
  const { page } = handle;
  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('modal-palette');
  await expect(palette).toBeVisible();

  await palette.getByRole('combobox').fill('model');
  await palette.getByRole('option', { name: '/model' }).first().click();

  await expect(page.getByTestId('modal-model')).toBeVisible();
});

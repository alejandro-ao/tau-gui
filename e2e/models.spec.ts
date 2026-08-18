import { expect, test } from '@playwright/test';
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
  await expect(page.getByTestId('sidebar')).toContainText('fake:fake-small');
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

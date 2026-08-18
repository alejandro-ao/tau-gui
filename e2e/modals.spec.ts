import { expect, test } from '@playwright/test';
import { composer, launchApp, typeDraft, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test('the palette traps focus, closes on Escape, and preserves the draft', async () => {
  const { page } = handle;
  await typeDraft(page, 'draft behind the modal');

  await page.keyboard.press('Control+k');
  const palette = page.getByTestId('modal-palette');
  await expect(palette).toBeVisible();

  // The filter input is auto-focused so typing lands in the picker.
  await expect(palette.getByRole('combobox')).toBeFocused();

  // Tab cycles only inside the dialog.
  for (let index = 0; index < 6; index += 1) {
    await page.keyboard.press('Tab');
    const insideModal = await page.evaluate(
      "Boolean(document.activeElement && document.activeElement.closest('.modal'))",
    );
    expect(insideModal).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(
      "Boolean(document.activeElement && document.activeElement.closest('.modal'))",
    ),
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);
  await expect(composer(page)).toHaveValue('draft behind the modal');

  // Focus returns to the composer on its own: no click required.
  await expect(composer(page)).toBeFocused();
});

test('the hotkeys modal closes with its explicit close button', async () => {
  const { page } = handle;
  await page.getByTestId('sidebar').getByRole('button', { name: 'keys' }).click();
  const modal = page.getByTestId('modal-hotkeys');
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('dialog')).toHaveAttribute('aria-modal', 'true');

  await modal.getByRole('button', { name: 'close dialog' }).click();
  await expect(modal).toHaveCount(0);
});

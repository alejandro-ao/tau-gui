import { expect, test } from '@playwright/test';
import { launchApp, submitPrompt, waitForSettled, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test('usage remains accessible and stacked at a narrow window width', async () => {
  const { page } = handle;
  await page.setViewportSize({ width: 760, height: 700 });
  await submitPrompt(page, 'hello usage');
  await waitForSettled(page);

  const usageTab = page.getByRole('tab', { name: 'Session usage' });
  await usageTab.click();
  await expect(usageTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', { name: 'Session usage' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Visible requests' })).toBeVisible();
  await expect(page.getByText(/Showing 1–\d+ of \d+ visible requests/)).toBeVisible();

  const panels = page.locator('.usage-details > .usage-panel');
  const requestsBox = await panels.nth(0).boundingBox();
  const toolsBox = await panels.nth(1).boundingBox();
  expect(requestsBox).not.toBeNull();
  expect(toolsBox).not.toBeNull();
  expect(toolsBox!.y).toBeGreaterThan(requestsBox!.y + requestsBox!.height - 1);
});

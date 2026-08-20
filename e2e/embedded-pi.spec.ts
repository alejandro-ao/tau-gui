import { expect, test } from '@playwright/test';
import { launchApp, runtimePids } from './helpers.js';

test('starts with bundled Pi and no external runtime executable', async () => {
  const handle = await launchApp({ embeddedPi: true });
  try {
    await expect(handle.page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
    await expect(handle.page.getByTestId('sidebar').locator('.version-mark')).toContainText('pi');
    expect(runtimePids(handle.marker)).toEqual([]);
  } finally {
    await handle.close();
  }
});

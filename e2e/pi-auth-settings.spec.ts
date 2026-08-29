import { expect, test } from '@playwright/test';
import { composer, launchApp } from './helpers.js';

test('restores sanitized Pi auth status and preferences without credentials', async () => {
  const handle = await launchApp({ embeddedPi: true });
  try {
    await expect(handle.page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
    const preferences = await handle.page.evaluate(`window.tau.invoke('pi.preferences.get')`);
    expect(preferences).toMatchObject({
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      retryEnabled: true,
      autoCompactionEnabled: true,
    });
    const providers = await handle.page.evaluate<Array<Record<string, unknown>>>(
      `window.tau.invoke('auth.providers')`,
    );
    expect(providers.length).toBeGreaterThan(0);
    expect(
      providers.every(
        (provider) =>
          !('key' in provider) &&
          !('env' in provider) &&
          !('access' in provider) &&
          !('refresh' in provider),
      ),
    ).toBe(true);

    await composer(handle.page).fill('/settings');
    await handle.page.keyboard.press('Enter');
    await expect(handle.page.getByText('steering delivery')).toBeVisible();
    await expect(handle.page.getByText(/3 retries · 2000ms base/)).toBeVisible();
  } finally {
    await handle.close();
  }
});

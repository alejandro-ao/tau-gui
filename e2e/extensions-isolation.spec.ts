import { expect, test } from '@playwright/test';
import { composer, launchApp } from './helpers.js';

test('keeps third-party extensions blocked behind a healthy utility boundary', async () => {
  const handle = await launchApp({ embeddedPi: true });
  try {
    const status = await handle.page.evaluate(`window.tau.invoke('extensions.host.probe')`);
    expect(status).toMatchObject({ status: 'ready', crashes: 0 });
    const policy = await handle.page.evaluate(`window.tau.invoke('extensions.policy.get')`);
    expect(policy).toMatchObject({
      userEnabled: false,
      projectEnabled: false,
      executionAvailable: false,
    });

    await composer(handle.page).fill('/extensions');
    await handle.page.keyboard.press('Enter');
    await expect(handle.page.getByTestId('extensions-policy')).toBeVisible();
    await expect(handle.page.getByText(/third-party execution remains fail-closed/)).toBeVisible();
    await expect(
      handle.page.getByText(/no public serializable extension-host adapter/),
    ).toBeVisible();
  } finally {
    await handle.close();
  }
});

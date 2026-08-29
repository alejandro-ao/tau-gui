import { expect, test, type Page } from '@playwright/test';
import { composer, launchApp } from './helpers.js';

async function runCommand(page: Page, command: string): Promise<void> {
  await composer(page).fill(command);
  await composer(page).press('Enter');
}

test('starts with bundled Pi and no external runtime executable', async () => {
  const handle = await launchApp({ embeddedPi: true });
  try {
    await expect(handle.page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
    await expect(handle.page.getByTestId('sidebar').locator('.version-mark')).toContainText('pi');
  } finally {
    await handle.close();
  }
});

test('keeps /system and /tools local and reloads Pi resources in place', async () => {
  const handle = await launchApp({ embeddedPi: true });
  try {
    const { page } = handle;
    await runCommand(page, '/system');
    const system = page.getByTestId('modal-system');
    await expect(system).toBeVisible();
    await expect(system).toContainText('never sent to the model');
    await expect(page.locator('.block-user')).toHaveCount(0);
    await system.getByRole('button', { name: 'close dialog' }).click();

    await runCommand(page, '/tools');
    const tools = page.getByTestId('modal-tools');
    await expect(tools).toBeVisible();
    await expect(tools).toContainText('read');
    await expect(tools).toContainText('builtin');
    await expect(page.locator('.block-user')).toHaveCount(0);
    await tools.getByRole('button', { name: 'close dialog' }).click();

    await runCommand(page, '/reload');
    const reload = page.getByTestId('modal-reload');
    await expect(reload).toBeVisible();
    await expect(reload).toContainText('skills');
    await expect(reload).toContainText('context files');
    await expect(page.locator('.block-user')).toHaveCount(0);
  } finally {
    await handle.close();
  }
});

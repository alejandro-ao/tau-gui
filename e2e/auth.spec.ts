import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composer, launchApp, type AppHandle } from './helpers.js';

let handle: AppHandle | undefined;

test.beforeEach(async () => {
  handle = await launchApp({ embeddedPi: true });
});

test.afterEach(async () => {
  await handle?.close();
});

test('login and logout use Pi native credential storage through desktop pickers', async () => {
  if (!handle) throw new Error('App did not launch');
  const { page, userDataDir } = handle;
  const authPath = join(userDataDir, 'pi-agent', 'auth.json');

  await composer(page).fill('/login');
  await composer(page).press('Enter');
  const login = page.getByTestId('modal-login');
  await expect(login).toBeVisible();

  const anthropicApiKey = login
    .locator('.picker-option')
    .filter({ hasText: 'Anthropic' })
    .filter({ hasText: 'API key' });
  await expect(anthropicApiKey).toBeVisible();
  await anthropicApiKey.click();

  const secretInput = login.locator('input[type="password"]');
  await expect(secretInput).toBeVisible();
  await secretInput.press('ControlOrMeta+k');
  const palette = page.getByTestId('modal-palette');
  await expect(palette).toBeVisible();
  await palette.locator('input').fill('/login');
  await palette.locator('.picker-option').filter({ hasText: '/login' }).click();
  await expect(secretInput).toBeVisible();
  await secretInput.fill('e2e-native-pi-key');
  await login.getByRole('button', { name: 'submit' }).click();
  await expect(login).toContainText('Saved API key for Anthropic');
  expect(readFileSync(authPath, 'utf8')).toContain('e2e-native-pi-key');
  await login.getByRole('button', { name: 'done' }).click();

  await composer(page).fill('/logout');
  await composer(page).press('Enter');
  const logout = page.getByTestId('modal-logout');
  await expect(logout).toBeVisible();
  const storedAnthropic = logout.locator('.picker-option').filter({ hasText: 'Anthropic' });
  await expect(storedAnthropic).toContainText('stored');
  await storedAnthropic.click();
  await expect(logout).toContainText('no stored credentials to remove');
  expect(readFileSync(authPath, 'utf8')).not.toContain('e2e-native-pi-key');
});

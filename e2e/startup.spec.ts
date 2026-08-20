import { expect, test } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import { FAKE_RUNTIME, launchApp, waitForSettled, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeAll(async () => {
  // Exercise hidden mode even in Linux CI, where the rest of the suite uses
  // its isolated Xvfb display to avoid hidden-renderer timer throttling.
  handle = await launchApp({ env: { TAU_GUI_E2E_HIDDEN: '1' } });
});

test.afterAll(async () => {
  await handle.close();
});

test('hidden window loads, connects to the runtime, and reports session context', async () => {
  const { app, page } = handle;

  expect(
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()),
  ).toBe(false);
  expect(page.url()).toContain('index.html');
  await expect(page.locator('.app')).toBeVisible();
  await waitForSettled(page);

  // Sidebar follows the TUI structure: title, activity, version mark.
  const sidebar = page.getByTestId('sidebar');
  await expect(sidebar).toBeVisible();
  await expect(sidebar.locator('.sidebar-title')).toContainText('untitled session');
  await expect(sidebar).toContainText('activity');
  await expect(sidebar.locator('.version-mark')).toContainText('τ = 2π');
  await expect(sidebar.locator('.version-mark')).toContainText('pi');

  // Status row reports the working directory and the active model.
  const status = page.getByTestId('status-row');
  await expect(status).toContainText(handle.projectDir);
  await expect(status.getByRole('button', { name: /fake-large/ })).toBeVisible();

  await expect(page.getByTestId('composer')).toHaveAttribute('data-status', 'idle');
  await expect(page.getByRole('log', { name: 'transcript' })).toContainText('No messages yet');
});

test('startup migrates a legacy settings file into the AO user-data directory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ao-startup-migration-'));
  const userDataDir = join(root, 'AO');
  const projectDir = join(root, 'project');
  const appDataDir = join(root, 'app-data');
  const legacyDir = join(appDataDir, 'Tau GUI');
  mkdirSync(legacyDir, { recursive: true });
  const legacySettings = {
    ...DEFAULT_SETTINGS,
    agentRuntime: 'pi' as const,
    cwd: projectDir,
    runtime: {
      ...DEFAULT_SETTINGS.runtime,
      pi: { ...DEFAULT_SETTINGS.runtime.pi, binary: FAKE_RUNTIME },
    },
  };
  writeFileSync(join(legacyDir, 'settings.json'), `${JSON.stringify(legacySettings)}\n`);

  const migrated = await launchApp({
    userDataDir,
    projectDir,
    seedSettings: false,
    env: { AO_TEST_APP_DATA_DIR: appDataDir },
  });
  try {
    await waitForSettled(migrated.page);
    const persisted = JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as {
      cwd: string;
    };
    expect(persisted.cwd).toBe(projectDir);
  } finally {
    await migrated.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the runtime is idle and the composer is focused for typing', async () => {
  const { page } = handle;
  await page.getByLabel('composer').click();
  await expect(page.getByLabel('composer')).toBeFocused();
  await expect(page.getByTestId('prompt-slot')).toContainText('idle');
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  launchApp,
  submitPrompt,
  waitForConnected,
  waitForSettled,
  type AppHandle,
} from './helpers.js';

test.describe('sessions rail', () => {
  let handle: AppHandle;
  test.afterEach(async () => {
    await handle?.close();
  });

  test('lists app metadata and activates Pi sessions without a subprocess', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'tau-gui-project-'));
    handle = await launchApp({
      projectDir,
      settings: {
        recentSessions: [
          {
            id: 'older-session',
            name: 'earlier work',
            firstMessage: 'Continue the earlier work',
            messageCount: 2,
            path: null,
            cwd: projectDir,
            runtime: 'pi',
            lastSeen: Date.now() - 3_600_000,
          },
        ],
      },
    });
    const rail = handle.page.getByTestId('sessions-rail');
    await expect(rail).toContainText('earlier work');
    await rail.getByRole('button', { name: /earlier work/ }).click();
    await expect(handle.page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
  });

  test('keeps fresh Pi sessions independently addressable', async () => {
    handle = await launchApp();
    await submitPrompt(handle.page, 'first session');
    await waitForSettled(handle.page);
    await handle.page.getByLabel('composer').fill('/new');
    await handle.page.getByLabel('composer').press('Enter');
    await waitForConnected(handle.page);
    await submitPrompt(handle.page, 'second session');
    await waitForSettled(handle.page);
    const rail = handle.page.getByTestId('sessions-rail');
    await expect(rail).toContainText('first session');
    await expect(rail).toContainText('second session');
  });
});

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  launchApp,
  submitPrompt,
  transcript,
  waitForConnected,
  waitForSettled,
  type AppHandle,
} from './helpers.js';

test.describe('sessions rail', () => {
  let handle: AppHandle;

  test.afterEach(async () => {
    await handle?.close();
  });

  test('lists directory sessions, marks the active one, and resumes on click', async () => {
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
            runtime: 'tau',
            lastSeen: Date.now() - 3_600_000,
          },
          {
            id: 'other-directory',
            name: 'elsewhere',
            path: null,
            cwd: '/somewhere/else',
            runtime: 'tau',
            lastSeen: Date.now(),
          },
        ],
      },
    });
    const { page } = handle;
    await waitForConnected(page);

    const rail = page.getByTestId('sessions-rail');
    await expect(rail).toBeVisible();
    // The seeded directory session is listed; the empty live session and the
    // session from another directory are not.
    await expect(rail).toContainText('earlier work');
    await expect(rail).not.toContainText('fake-session');
    await expect(rail).not.toContainText('elsewhere');

    // Clicking the older session resumes it through the runtime. The fake
    // reports no messages for switched sessions, so it is then hidden as empty.
    await rail.getByRole('button', { name: /earlier work/ }).click();
    await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
    await expect(rail).not.toContainText('earlier work');
  });

  test('keeps background tool work isolated while switching sessions', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'tau-gui-concurrent-'));
    handle = await launchApp({
      projectDir,
      env: { FAKE_RUNTIME_DELAY_MS: '120' },
      settings: {
        recentSessions: [
          {
            id: 'other-session',
            name: 'Other session',
            firstMessage: 'Existing work',
            messageCount: 1,
            path: null,
            cwd: projectDir,
            runtime: 'tau',
            lastSeen: Date.now() - 1_000,
          },
        ],
      },
    });
    const { page } = handle;
    await waitForConnected(page);

    await submitPrompt(page, 'tool work in background');
    await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'running');
    const rail = page.getByTestId('sessions-rail');
    const other = rail.locator('.sessions-rail-item').filter({ hasText: 'Other session' });
    await other.click();
    await expect(other).toHaveCount(0);
    await expect(page.getByLabel('composer')).toBeEnabled();
    await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');

    // Let the first runtime enter and finish its tool calls while hidden.
    await page.waitForTimeout(1_000);
    await expect(transcript(page)).not.toContainText('src/index.ts');
    await expect(page.locator('.block-tool')).toHaveCount(0);

    const background = rail
      .locator('.sessions-rail-item')
      .filter({ hasText: 'tool work in background' });
    await background.click();
    await expect(background).toHaveAttribute('aria-busy', 'false');
    await expect(background).toHaveAttribute('aria-current', 'true');
    await waitForSettled(page, 10_000);
  });

  test('does not list an empty live session once connected', async () => {
    handle = await launchApp();
    const { page } = handle;
    await waitForConnected(page);
    const rail = page.getByTestId('sessions-rail');
    await expect(rail).toContainText('sessions · 0');
    await expect(rail).not.toContainText('fake-session');
  });
});

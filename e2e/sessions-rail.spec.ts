import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, waitForConnected, type AppHandle } from './helpers.js';

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
    // The seeded directory session and the live session are listed; the
    // session from another directory is not.
    await expect(rail).toContainText('earlier work');
    await expect(rail).toContainText('fake-session');
    await expect(rail).not.toContainText('elsewhere');

    // The live session is highlighted as active.
    const active = rail.locator('.sessions-rail-item[data-active="true"]');
    await expect(active).toContainText('fake-session');

    // Clicking the older session resumes it through the runtime.
    await rail.getByRole('button', { name: /earlier work/ }).click();
    await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
    // After switching, the runtime's (nameless) session state is authoritative,
    // so the label falls back to the truncated session id.
    await expect(rail.locator('.sessions-rail-item[data-active="true"]')).toContainText(
      'older-sessio',
    );
  });

  test('tracks the live session once connected', async () => {
    handle = await launchApp();
    const { page } = handle;
    await waitForConnected(page);
    // Connecting records the current session, so the rail appears even for a
    // directory with no prior history.
    await expect(page.getByTestId('sessions-rail')).toContainText('fake-session');
  });
});

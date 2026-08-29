import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  launchApp,
  runtimePids,
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

  test('lists directory session metadata and keeps activation disabled', async () => {
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
    // Sessions from both seeded working directories are grouped; the empty
    // live session remains hidden.
    await expect(rail).toContainText('earlier work');
    await expect(rail).toContainText('elsewhere');
    await expect(rail.locator('.sessions-directory')).toHaveCount(2);
    await expect(rail).not.toContainText('fake-session');

    const earlier = rail.getByRole('button', { name: /earlier work/ });
    await expect(earlier).toBeDisabled();
    await expect(earlier).toHaveAttribute(
      'title',
      /public Pi SDK cannot activate an exact manager/,
    );
    await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
  });

  test('keeps a streaming process alive when the picker opens another directory', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'tau-gui-picker-source-'));
    const chosenDir = mkdtempSync(join(tmpdir(), 'tau-gui-picker-target-'));
    handle = await launchApp({
      projectDir,
      env: {
        FAKE_RUNTIME_DELAY_MS: '250',
        FAKE_RUNTIME_UNIQUE_SESSION: '1',
      },
    });
    const { app, page } = handle;
    await waitForConnected(page);

    await submitPrompt(page, 'tool work via picker that must survive');
    await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'running');
    const streamingPid = runtimePids(handle.marker)[0];
    expect(streamingPid).toBeDefined();
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [directory] });
    }, chosenDir);

    await page.getByRole('button', { name: 'new session in directory' }).click();
    await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
    await expect
      .poll(() => runtimePids(handle.marker), { timeout: 10_000 })
      .toEqual(expect.arrayContaining([streamingPid!]));
    await expect.poll(() => runtimePids(handle.marker).length).toBe(2);

    const background = page
      .getByTestId('sessions-rail')
      .locator('.sessions-rail-item')
      .filter({ hasText: 'tool work via picker that must survive' });
    await expect(background).toBeDisabled();
    await expect(background).toHaveAttribute(
      'title',
      /public Pi SDK cannot activate an exact manager/,
    );
    await expect.poll(() => runtimePids(handle.marker).length).toBe(2);
  });

  test('keeps a streaming session on its own process when a new session opens', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'tau-gui-new-session-'));
    handle = await launchApp({
      projectDir,
      env: {
        FAKE_RUNTIME_DELAY_MS: '120',
        // Model real runtimes: every launch mints its own session id.
        FAKE_RUNTIME_UNIQUE_SESSION: '1',
      },
    });
    const { page } = handle;
    await waitForConnected(page);

    await submitPrompt(page, 'tool work that must survive');
    await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'running');

    // Opening an empty session must not swap the session under the live agent:
    // the rest of that turn would be written into the new transcript.
    await page.getByLabel('composer').fill('/new');
    await page.getByLabel('composer').press('Enter');
    await expect(transcript(page)).not.toContainText('src/index.ts');
    await expect(page.locator('.block-tool')).toHaveCount(0);
    await expect.poll(() => runtimePids(handle.marker).length).toBe(2);

    await submitPrompt(page, 'hello in the empty session');
    await waitForSettled(page, 10_000);
    await expect(transcript(page)).toContainText('hello in the empty session');
    await expect(transcript(page)).not.toContainText('tool work that must survive');
    await expect(page.locator('.block-tool')).toHaveCount(0);

    // The background manager remains alive, but persisted metadata is not an
    // activation route until Pi supplies generation-bound public activation.
    const rail = page.getByTestId('sessions-rail');
    const background = rail
      .locator('.sessions-rail-item')
      .filter({ hasText: 'tool work that must survive' });
    await expect(background).toBeDisabled();
    await expect.poll(() => runtimePids(handle.marker).length).toBe(2);
    await expect(transcript(page)).toContainText('hello in the empty session');
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

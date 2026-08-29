import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, test } from '@playwright/test';
import { composer, launchApp, type AppHandle } from './helpers.js';

let handle: AppHandle;
let root: string;
let seededId: string;

function sessionDirectory(cwd: string, agentDir: string): string {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
  return join(agentDir, 'sessions', safePath);
}

async function runCommand(command: string): Promise<void> {
  await composer(handle.page).fill(command);
  await composer(handle.page).press('Enter');
}

test.beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'tau-gui-native-sessions-'));
  const userDataDir = join(root, 'user-data');
  const projectDir = join(root, 'project');
  const agentDir = join(userDataDir, 'pi-agent');
  mkdirSync(projectDir, { recursive: true });

  // Public SessionManager APIs seed a deterministic persisted Pi session. The
  // test never reads or constructs Pi JSONL itself.
  const manager = SessionManager.create(projectDir, sessionDirectory(projectDir, agentDir));
  seededId = manager.getSessionId();
  manager.appendSessionInfo('Native E2E session');
  manager.appendMessage({ role: 'user', content: 'Test native sessions', timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'Ready' }],
    api: 'test',
    provider: 'test',
    model: 'test',
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: Date.now(),
  });

  handle = await launchApp({ userDataDir, projectDir, embeddedPi: true });
});

test.afterEach(async () => {
  await handle.close();
  rmSync(root, { recursive: true, force: true });
});

test('fails import closed while preserving native list, resume, clone, and export', async () => {
  const { app, page } = handle;
  const portable = join(root, 'portable.jsonl');

  await runCommand('/resume');
  const picker = page.getByTestId('modal-session');
  const seeded = picker.getByRole('option').filter({ hasText: 'Native E2E session' });
  await expect(seeded).toHaveCount(1);
  await expect(seeded).toContainText('2 messages');
  await expect(seeded).not.toContainText('.jsonl');

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
  }, portable);
  await seeded.getByRole('button', { name: 'export' }).click();
  await expect.poll(() => existsSync(portable)).toBe(true);

  await seeded.click();
  await expect(page.getByRole('log', { name: 'transcript' })).toContainText('Test native sessions');

  await runCommand('/clone');
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
  await runCommand('/resume');
  await expect
    .poll(() => page.getByTestId('modal-session').getByRole('option').count())
    .toBeGreaterThanOrEqual(2);
  await page.keyboard.press('Escape');

  const portableBefore = readFileSync(portable);
  await app.evaluate(({ dialog }) => {
    const testGlobal = globalThis as typeof globalThis & { __importPickerCalls: number };
    testGlobal.__importPickerCalls = 0;
    dialog.showOpenDialog = () => {
      testGlobal.__importPickerCalls += 1;
      return Promise.resolve({ canceled: true, filePaths: [] });
    };
  });
  const importError = await page.evaluate(
    `window.tau.invoke('session.importJsonl').then(() => 'resolved', (error) => String(error.message))`,
  );
  expect(importError).toContain('public Pi SDK has no handle- or bytes-based no-follow validator');
  expect(
    await app.evaluate(
      () => (globalThis as typeof globalThis & { __importPickerCalls: number }).__importPickerCalls,
    ),
  ).toBe(0);
  expect(readFileSync(portable)).toEqual(portableBefore);

  await runCommand('/import');
  await expect(
    page
      .getByRole('log', { name: 'transcript' })
      .getByText(/public Pi SDK has no handle- or bytes-based no-follow validator/),
  ).toBeVisible();
  await runCommand('/resume');
  const preserved = page
    .getByTestId('modal-session')
    .getByRole('option')
    .filter({ hasText: 'Native E2E session' });
  await expect(preserved).toHaveCount(2);
  await preserved.first().click();
  await expect(page.getByRole('log', { name: 'transcript' })).toContainText('Test native sessions');

  const html = join(root, 'session.html');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: path });
  }, html);
  await runCommand('/export');
  await expect.poll(() => existsSync(html)).toBe(true);
  expect(readFileSync(html, 'utf8')).toContain('<!DOCTYPE html>');
  expect(seededId).not.toBe('');
});

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, test } from '@playwright/test';
import { composer, launchApp, type AppHandle } from './helpers.js';

let handle: AppHandle;
let root: string;
let seededId: string;
let agentDir: string;
let backingPath: string;

function fileSnapshot(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.set(path.slice(root.length), readFileSync(path));
    }
  };
  visit(root);
  return files;
}

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
  agentDir = join(userDataDir, 'pi-agent');
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

  backingPath = manager.getSessionFile() ?? '';
  if (!backingPath) throw new Error('seeded session was not persisted');

  handle = await launchApp({ userDataDir, projectDir, embeddedPi: true });
});

test.afterEach(async () => {
  await handle.close();
  rmSync(root, { recursive: true, force: true });
});

test('keeps catalog/export filesystem failures path-free across main IPC and preload', async () => {
  const { app, page } = handle;
  const privateName = backingPath.slice(backingPath.lastIndexOf('/') + 1);
  const catalog = await page.evaluate<Array<{ id: string; sessionId: string }>>(
    `window.tau.invoke('session.list', { scope: 'all' })`,
  );
  const selected = catalog.find((session) => session.sessionId === seededId);
  if (!selected) throw new Error('seeded catalog session was not listed');

  rmSync(backingPath);
  await app.evaluate(
    ({ dialog }, destination) => {
      dialog.showSaveDialog = () => Promise.resolve({ canceled: false, filePath: destination });
    },
    join(root, 'missing-source-export.jsonl'),
  );
  const missingError = await page.evaluate(
    `window.tau.invoke('session.exportJsonl', { sessionId: ${JSON.stringify(selected.id)} }).then(() => 'resolved', (error) => String(error.message))`,
  );
  expect(missingError).toContain('fresh native catalog record');
  expect(missingError).not.toContain(agentDir);
  expect(missingError).not.toContain(privateName);

  // A no-follow source rejection is surfaced only as fixed diagnostics/status.
  writeFileSync(join(root, 'private-source-target.jsonl'), '{}\n');
  symlinkSync(join(root, 'private-source-target.jsonl'), backingPath);
  const diagnostics = await page.evaluate(`(() => {
    const messages = [];
    const unsubscribe = window.tau.subscribe((event) => {
      if (event.type === 'diagnostic') messages.push(event.message);
    });
    return window.tau.invoke('session.list', { scope: 'all' }).then(() => {
      unsubscribe();
      return messages;
    });
  })()`);
  expect(JSON.stringify(diagnostics)).toContain('Unsafe or unknown session-directory child');
  expect(JSON.stringify(diagnostics)).not.toContain(agentDir);
  expect(JSON.stringify(diagnostics)).not.toContain(privateName);
  expect(JSON.stringify(diagnostics)).not.toContain('private-source-target.jsonl');

  rmSync(backingPath);
  const sessionsRoot = join(agentDir, 'sessions');
  const displacedRoot = join(agentDir, 'private-displaced-sessions');
  renameSync(sessionsRoot, displacedRoot);
  writeFileSync(sessionsRoot, 'invalid root');
  const rootDiagnostics = await page.evaluate(`(() => {
    const messages = [];
    const unsubscribe = window.tau.subscribe((event) => {
      if (event.type === 'diagnostic') messages.push(event.message);
    });
    return window.tau.invoke('session.list', { scope: 'all' }).then((sessions) => {
      unsubscribe();
      return { messages, sessions };
    });
  })()`);
  expect(JSON.stringify(rootDiagnostics)).toContain(
    'Session catalog roots are unavailable or unsafe',
  );
  expect(JSON.stringify(rootDiagnostics)).not.toContain(agentDir);
  expect(JSON.stringify(rootDiagnostics)).not.toContain(privateName);
  expect(JSON.stringify(rootDiagnostics)).not.toContain('private-displaced-sessions');
});

test('fails clone and import closed while preserving native list, resume, and export', async () => {
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

  const filesBeforeClone = fileSnapshot(agentDir);
  const sourceBeforeClone = readFileSync(backingPath);
  const cloneError = await page.evaluate(
    `window.tau.invoke('session.clone').then(() => 'resolved', (error) => String(error.message))`,
  );
  expect(cloneError).toContain(
    'cannot activate the exact newly branched manager or an immutable artifact',
  );
  expect(cloneError).not.toContain(agentDir);

  await runCommand('/clone');
  await expect(
    page
      .getByRole('log', { name: 'transcript' })
      .getByText(/cannot activate the exact newly branched manager or an immutable artifact/),
  ).toBeVisible();
  expect(readFileSync(backingPath)).toEqual(sourceBeforeClone);
  expect(fileSnapshot(agentDir)).toEqual(filesBeforeClone);

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
  await expect(preserved).toHaveCount(1);
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

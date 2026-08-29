import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { injectBridgePayload, launchApp, type AppHandle } from './helpers.js';

let handle: AppHandle;
let recoveryRoot: string;

test.beforeAll(async () => {
  recoveryRoot = mkdtempSync(join(tmpdir(), 'tau-gui-preload-recovery-'));
  handle = await launchApp({ env: { PI_CODING_AGENT_DIR: join(recoveryRoot, 'agent') } });
});

test.afterAll(async () => {
  await handle.close();
  rmSync(recoveryRoot, { recursive: true, force: true });
});

test('the renderer has no Node integration', async () => {
  const { page } = handle;
  const exposure = await page.evaluate(`({
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
    global: typeof window.global,
    Buffer: typeof window.Buffer,
    electron: typeof window.electron,
  })`);
  expect(exposure).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    global: 'undefined',
    Buffer: 'undefined',
    electron: 'undefined',
  });
});

test('the bridge exposes only the narrow contract', async () => {
  const { page } = handle;
  const keys = await page.evaluate<string[]>('Object.keys(window.tau).sort()');
  expect(keys).toEqual(['invoke', 'pathForFile', 'platform', 'subscribe']);

  const types = await page.evaluate(`({
    invoke: typeof window.tau.invoke,
    subscribe: typeof window.tau.subscribe,
    pathForFile: typeof window.tau.pathForFile,
    platform: typeof window.tau.platform,
  })`);
  expect(types).toEqual({
    invoke: 'function',
    subscribe: 'function',
    pathForFile: 'function',
    platform: 'string',
  });
});

test('drops forged nested and incomplete bridge events', async () => {
  const { app, page } = handle;
  await page.evaluate(`(() => {
    window.__acceptedBridgeEvents = 0;
    window.tau.subscribe(() => { window.__acceptedBridgeEvents += 1; });
  })()`);

  await injectBridgePayload(app, {
    type: 'agent',
    sessionId: 'forged-session',
    runtime: 'pi',
    event: { type: 'message_end' },
  });
  await injectBridgePayload(app, {
    type: 'agent',
    sessionId: 'forged-session',
    runtime: 'pi',
    event: {
      type: 'tool_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      text: 'forged',
      details: { nested: { value: true } },
      isError: false,
      extra: '/private/session.jsonl',
    },
  });
  await page.waitForTimeout(50);
  expect(await page.evaluate<number>('window.__acceptedBridgeEvents')).toBe(0);

  await injectBridgePayload(app, { type: 'focus', focused: true });
  await expect.poll(() => page.evaluate<number>('window.__acceptedBridgeEvents')).toBe(1);
});

test('recovery health crosses actual IPC and preload validation', async () => {
  const health = await handle.page.evaluate(`window.tau.invoke('session.importHealth')`);
  expect(health).toEqual({ available: true, retained: 0, capacity: 32 });
});

test('recovery filesystem and reveal failures stay generic across actual IPC', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tau-gui-preload-recovery-failure-'));
  const userDataDir = join(root, 'user-data');
  const projectDir = join(root, 'project');
  const invalidAgentDir = join(root, 'agent-file');
  writeFileSync(invalidAgentDir, 'private filesystem fixture');
  const failed = await launchApp({
    userDataDir,
    projectDir,
    env: { PI_CODING_AGENT_DIR: invalidAgentDir },
  });
  try {
    const health = await failed.page.evaluate(`window.tau.invoke('session.importHealth')`);
    expect(health).toEqual({ available: false, error: 'Import recovery is unavailable' });

    await failed.app.evaluate(({ shell }, privatePath) => {
      shell.openPath = () => Promise.resolve(`denied: ${privatePath}`);
    }, invalidAgentDir);
    const revealError = await failed.page.evaluate(
      `window.tau.invoke('session.revealImportRecovery').then(() => 'resolved', (error) => String(error.message))`,
    );
    expect(revealError).toBe('Could not reveal the import recovery directory');
    expect(revealError).not.toContain(invalidAgentDir);
  } finally {
    await failed.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an invalid IPC action is rejected by validation', async () => {
  const { page } = handle;
  const unknownAction = await page.evaluate(
    `window.tau.invoke('totally.bogus').then(() => 'resolved', (error) => String(error.message))`,
  );
  expect(unknownAction).toContain('Invalid IPC request');

  const invalidPayload = await page.evaluate(
    `window.tau.invoke('agent.prompt', { text: '' }).then(() => 'resolved', (error) => String(error.message))`,
  );
  expect(invalidPayload).toContain('Invalid IPC request');

  const wrongType = await page.evaluate(
    `window.tau.invoke('settings.update', { theme: 'neon' }).then(() => 'resolved', (error) => String(error.message))`,
  );
  expect(wrongType).toContain('Invalid IPC request');

  // A valid call still works after the rejections.
  const settings = await page.evaluate<{ theme: string }>(`window.tau.invoke('settings.get')`);
  expect(settings.theme).toBe('tau-dark');
});

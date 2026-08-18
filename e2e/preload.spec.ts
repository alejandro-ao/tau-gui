import { expect, test } from '@playwright/test';
import { launchApp, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeAll(async () => {
  handle = await launchApp();
});

test.afterAll(async () => {
  await handle.close();
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

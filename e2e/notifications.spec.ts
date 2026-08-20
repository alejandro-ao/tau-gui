import { expect, test, type ElectronApplication } from '@playwright/test';
import { composer, launchApp, waitForSettled, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.afterEach(async () => {
  await handle?.close();
});

/**
 * Records desktop notifications in the main process.
 *
 * `Notification.prototype.show` is patched (not the renderer, not the IPC
 * handler), so the whole production path — renderer effect → preload bridge →
 * `ui.notify` handler → Electron notification — is exercised.
 */
async function recordNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const store: { title: string; body: string }[] = [];
    (globalThis as unknown as Record<string, unknown>)['__notifications'] = store;
    Notification.isSupported = () => true;
    // Recorded instead of shown: real OS notifications would leak out of the test.
    Notification.prototype.show = function patched(this: Electron.Notification): void {
      store.push({ title: this.title, body: this.body });
    };
  });
}

async function notifications(app: ElectronApplication): Promise<{ title: string; body: string }[]> {
  return app.evaluate(
    () =>
      ((globalThis as unknown as Record<string, unknown>)['__notifications'] ?? []) as {
        title: string;
        body: string;
      }[],
  );
}

test('a settled turn notifies while the window is unfocused', async () => {
  handle = await launchApp({ settings: { turnNotification: 'desktop' } });
  const { app, page } = handle;
  await recordNotifications(app);

  // The window under test is not frontmost in CI, so `blur()` is a no-op there.
  // Emitting the window event drives the production main → renderer focus path,
  // which the renderer mirrors on `.app[data-focused]`.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.emit('blur'));
  await expect(page.locator('.app')).toHaveAttribute('data-focused', 'false');

  // CDP key events do not need OS window focus.
  await composer(page).fill('notify me when this finishes');
  await composer(page).press('Enter');
  await waitForSettled(page);

  await expect.poll(() => notifications(app), { timeout: 10_000 }).toHaveLength(1);
  const [first] = await notifications(app);
  expect(first?.title).toContain('AO | ');
  expect(first?.body).toContain('Hello from the tau');
});

test('a settled turn stays silent while the window is focused', async () => {
  handle = await launchApp({ settings: { turnNotification: 'desktop' } });
  const { app, page } = handle;
  await recordNotifications(app);

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window?.emit('blur');
    window?.emit('focus');
  });
  await expect(page.locator('.app')).toHaveAttribute('data-focused', 'true');
  await composer(page).fill('stay quiet please');
  await composer(page).press('Enter');
  await waitForSettled(page);

  expect(await notifications(app)).toEqual([]);
});

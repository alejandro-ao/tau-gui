import { expect, test } from '@playwright/test';
import { launchApp, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeAll(async () => {
  handle = await launchApp();
});

test.afterAll(async () => {
  await handle.close();
});

test('platform shortcuts toggle the left and right sidebars independently', async () => {
  const { page } = handle;
  const platform = await page.locator('.app').getAttribute('data-platform');
  const primary = platform === 'darwin' ? 'Meta' : 'Control';
  const left = page.getByTestId('sessions-rail');
  const right = page.getByTestId('sidebar');

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  for (const sidebar of [left, right]) {
    const transition = await sidebar.evaluate((element) => {
      const styles = (
        globalThis as unknown as {
          getComputedStyle: (target: unknown) => {
            transitionDuration: string;
            transitionProperty: string;
          };
        }
      ).getComputedStyle(element);
      return {
        duration: styles.transitionDuration,
        properties: styles.transitionProperty,
      };
    });
    expect(transition.properties).toContain('flex-basis');
    expect(transition.properties).toContain('opacity');
    expect(transition.properties).toContain('transform');
    expect(transition.duration).toContain('0.22s');
  }

  await page.keyboard.press(`${primary}+b`);
  await expect(left).toBeHidden();
  await expect(right).toBeVisible();

  await page.keyboard.press(`${primary}+b`);
  await expect(left).toBeVisible();

  await page.keyboard.press(`${primary}+Alt+b`);
  await expect(left).toBeVisible();
  await expect(right).toBeHidden();

  await page.keyboard.press(`${primary}+Alt+b`);
  await expect(right).toBeVisible();
});

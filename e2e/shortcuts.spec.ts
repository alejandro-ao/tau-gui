import { expect, test, type Locator } from '@playwright/test';
import { launchApp, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeAll(async () => {
  handle = await launchApp();
});

test.afterAll(async () => {
  await handle.close();
});

async function activeTransitionProperties(target: Locator): Promise<string[]> {
  return target.evaluate((element) =>
    (
      element as unknown as {
        getAnimations: () => { transitionProperty: string }[];
      }
    )
      .getAnimations()
      .map((animation) => animation.transitionProperty),
  );
}

async function transitionStyle(target: Locator): Promise<{
  delay: string;
  duration: string;
  properties: string;
}> {
  return target.evaluate((element) => {
    const styles = (
      globalThis as unknown as {
        getComputedStyle: (target: unknown) => {
          transitionDelay: string;
          transitionDuration: string;
          transitionProperty: string;
        };
      }
    ).getComputedStyle(element);
    return {
      delay: styles.transitionDelay,
      duration: styles.transitionDuration,
      properties: styles.transitionProperty,
    };
  });
}

test('platform shortcuts toggle the left and right sidebars independently', async () => {
  const { page } = handle;
  const platform = await page.locator('.app').getAttribute('data-platform');
  const primary = platform === 'darwin' ? 'Meta' : 'Control';
  const left = page.getByTestId('sessions-rail');
  const leftContents = left.locator(':scope > .sessions-rail-header');
  const right = page.getByTestId('sidebar');
  const rightContents = right.locator(':scope > .sidebar-section').first();

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(left).toBeVisible();
  await expect(right).toBeVisible();
  for (const { shell, contents } of [
    { shell: left, contents: leftContents },
    { shell: right, contents: rightContents },
  ]) {
    const shellTransition = await transitionStyle(shell);
    expect(shellTransition.properties).toContain('flex-basis');
    expect(shellTransition.properties).toContain('transform');
    expect(shellTransition.duration).toContain('0.2s');

    const contentTransition = await transitionStyle(contents);
    expect(contentTransition.properties).toBe('opacity');
    expect(contentTransition.duration).toBe('0.14s');
    expect(contentTransition.delay).toBe('0.2s');
  }

  await page.keyboard.press(`${primary}+b`);
  expect((await transitionStyle(left)).delay).toContain('0.14s');
  expect((await transitionStyle(leftContents)).delay).toBe('0s');
  expect(await activeTransitionProperties(leftContents)).toContain('opacity');
  await expect(left).toBeHidden();
  await expect(right).toBeVisible();

  await page.keyboard.press(`${primary}+b`);
  expect((await transitionStyle(left)).delay).toMatch(/^0s(, 0s)*$/);
  expect((await transitionStyle(leftContents)).delay).toBe('0.2s');
  expect(await activeTransitionProperties(leftContents)).toContain('opacity');
  await expect(left).toBeVisible();

  await page.keyboard.press(`${primary}+Alt+b`);
  expect((await transitionStyle(right)).delay).toContain('0.14s');
  expect((await transitionStyle(rightContents)).delay).toBe('0s');
  expect(await activeTransitionProperties(rightContents)).toContain('opacity');
  await expect(left).toBeVisible();
  await expect(right).toBeHidden();

  await page.keyboard.press(`${primary}+Alt+b`);
  expect((await transitionStyle(right)).delay).toMatch(/^0s(, 0s)*$/);
  expect((await transitionStyle(rightContents)).delay).toBe('0.2s');
  expect(await activeTransitionProperties(rightContents)).toContain('opacity');
  await expect(right).toBeVisible();
});

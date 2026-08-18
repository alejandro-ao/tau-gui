import { expect, test } from '@playwright/test';
import { launchApp, submitPrompt, waitForSettled, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test('tool blocks render with success state and reveal details on expansion', async () => {
  const { page } = handle;
  await submitPrompt(page, 'use a tool to inspect the project');
  await waitForSettled(page);

  // `read`/`edit` are groupable, so the outermost article is the group frame;
  // `bash` is always rendered as a single block.
  const read = page.locator('.block-tool[data-tool="read"]').first();
  const edit = page.locator('.block-tool[data-tool="edit"]').first();
  const bash = page.locator('.block-tool[data-tool="bash"]').first();

  for (const block of [read, edit, bash]) {
    await expect(block).toBeVisible();
    await expect(block).toHaveAttribute('data-state', 'success');
  }
  await expect(read).toContainText('src/index.ts');
  await expect(edit).toContainText('src/index.ts');
  await expect(bash).toContainText('Running tests');

  // Collapsed: no invocation or output detail is mounted anywhere.
  await expect(page.locator('.tool-args')).toHaveCount(0);

  // Per-block expansion reveals the exact command and output.
  await bash.locator('.block-header').first().click();
  await expect(bash.locator('.block-header').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(bash.locator('.tool-args')).toContainText('npm test');
  await expect(bash.locator('.tool-output')).toContainText('2 passed, 0 failed');

  // Global Ctrl+O expands every block, including grouped calls.
  await page.keyboard.press('Control+o');
  await expect(read.locator('.tool-args').first()).toContainText('src/index.ts');
  await expect(read.locator('.tool-output').first()).toContainText('export const value = 1;');

  // The edit tool output is rendered as a diff, not as plain text.
  const diff = edit.locator('.diff').first();
  await expect(diff).toBeVisible();
  await expect(diff.locator('.diff-line[data-kind="add"]')).toContainText('+b');
  await expect(diff.locator('.diff-line[data-kind="del"]').last()).toContainText('-a');
  await expect(diff.locator('.diff-line[data-kind="hunk"]')).toContainText('@@');

  // Ctrl+O toggles everything back to collapsed.
  await page.keyboard.press('Control+o');
  await expect(page.locator('.tool-args')).toHaveCount(0);
});

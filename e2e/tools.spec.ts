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

  // Settled calls collapse into one turn summary after the final answer.
  const summary = page.locator('.tool-run-header').last();
  await expect(summary).toContainText('Worked for');
  await expect(page.locator('.block-tool')).toHaveCount(0);

  // The narration written before the calls is intermediate work: the closing
  // message is the only answer rendered as a message.
  await expect(page.locator('.block-assistant')).toHaveCount(1);
  await expect(page.locator('.block-assistant')).toContainText('Done: tests pass.');
  await summary.click();
  await expect(page.locator('.tool-run-note')).toContainText('Inspecting the project.');

  const readRow = page.locator('.tool-run-row').filter({ hasText: 'read' }).first();
  const editRow = page.locator('.tool-run-row').filter({ hasText: 'edit' }).first();
  const bashRow = page.locator('.tool-run-row').filter({ hasText: 'bash' }).first();

  for (const row of [readRow, editRow, bashRow]) {
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-state', 'success');
  }
  await expect(readRow).toContainText('src/index.ts');
  await expect(editRow).toContainText('src/index.ts');
  await expect(bashRow).toContainText('Running tests');

  // The call list is visible, but invocation and output details stay collapsed.
  await expect(page.locator('.tool-args')).toHaveCount(0);

  // Per-call expansion reveals the exact command and output.
  await bashRow.locator('.tool-run-item').click();
  const bash = bashRow.locator('.block-tool[data-tool="bash"]');
  await expect(bashRow.locator('.tool-run-item')).toHaveAttribute('aria-expanded', 'true');
  await expect(bash.locator('.tool-args')).toContainText('npm test');
  await expect(bash.locator('.tool-output')).toContainText('2 passed, 0 failed');

  // Global Ctrl+O expands every call, including clustered calls.
  await page.keyboard.press('Control+o');
  const read = readRow.locator('.block-tool[data-tool="read"]');
  const edit = editRow.locator('.block-tool[data-tool="edit"]');
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

import { expect, test } from '@playwright/test';
import { launchApp, submitPrompt, transcript, waitForSettled, type AppHandle } from './helpers.js';

let handle: AppHandle;

test.beforeEach(async () => {
  // A per-chunk delay keeps the streaming phase observable without flakiness.
  handle = await launchApp({ env: { FAKE_RUNTIME_DELAY_MS: '40' } });
});

test.afterEach(async () => {
  await handle.close();
});

test('one undo removes a contiguous keyboard insertion', async () => {
  const { page } = handle;
  const composer = page.getByLabel('composer');

  await composer.pressSequentially('hello');
  await expect(composer).toHaveValue('hello');
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');

  await expect(composer).toHaveValue('');
});

test('a prompt streams assistant text and then finalizes', async () => {
  const { page } = handle;
  await submitPrompt(page, 'hello there');

  await expect(page.locator('.block-user')).toContainText('hello there');

  // Streaming phase: caret marker plus CLI-style running spinner.
  await expect(page.locator('.streaming-caret')).toBeVisible();
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'running');
  const spinner = page.getByTestId('composer').getByRole('status', { name: 'Model working' });
  await expect(spinner).toBeVisible();
  await expect(page.locator('.prompt-slot .activity-spinner')).toHaveCount(0);

  await waitForSettled(page);
  await expect(page.locator('.streaming-caret')).toHaveCount(0);
  await expect(page.locator('.block-assistant')).toContainText('Hello from the tau fake runtime.');
  await expect(page.getByLabel('composer')).toHaveValue('');
});

test('a thinking run keeps reasoning on the activity rail, not in the answer', async () => {
  const { page } = handle;
  await submitPrompt(page, 'show thinking please');
  await waitForSettled(page);

  // Only the closing message is an answer; reasoning collapses into a summary.
  await expect(page.locator('.block-assistant')).toHaveCount(1);
  await expect(page.locator('.block-assistant')).toContainText('Here is the answer.');
  await expect(page.locator('.block-thinking')).toHaveCount(0);
  expect(await transcript(page).innerText()).not.toContain('Considering the request carefully.');

  const summary = page.locator('.tool-run-header').last();
  await expect(summary).toContainText('Thought for');
  await summary.click();
  await expect(page.locator('.tool-run-thinking')).toContainText(
    'Considering the request carefully.',
  );
});

test('a reasoning turn renders one answer with its work on the rail', async () => {
  const { page } = handle;
  await submitPrompt(page, 'reason about the code');
  await waitForSettled(page);

  // Reasoning, narration, and the tool call are one feed; the closing message
  // is the only answer.
  await expect(page.locator('.block-assistant')).toHaveCount(1);
  await expect(page.locator('.block-assistant')).toContainText('Found one match.');

  const summary = page.locator('.tool-run-header').last();
  await expect(summary).toContainText('Worked for');
  await summary.click();
  await expect(page.locator('.tool-run-note')).toContainText('Searching the project first.');
  await expect(page.locator('.tool-run-thinking').first()).toContainText('Planning the search.');
  await expect(page.locator('.tool-run-row')).toHaveCount(1);
});

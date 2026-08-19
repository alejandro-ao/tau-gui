import { expect, test, type Locator } from '@playwright/test';
import { launchApp, submitPrompt, transcript, waitForSettled, type AppHandle } from './helpers.js';

let handle: AppHandle;

async function fullyInsideTranscript(message: Locator, viewport: Locator): Promise<boolean> {
  const [messageBox, viewportBox] = await Promise.all([
    message.boundingBox(),
    viewport.boundingBox(),
  ]);
  if (!messageBox || !viewportBox) return false;
  return (
    messageBox.y >= viewportBox.y - 1 &&
    messageBox.y + messageBox.height <= viewportBox.y + viewportBox.height + 1
  );
}

test.beforeEach(async () => {
  // A per-chunk delay keeps the streaming phase observable without flakiness.
  handle = await launchApp({
    env: { FAKE_RUNTIME_DELAY_MS: '40', FAKE_RUNTIME_ASSISTANT_DELAY_MS: '30000' },
  });
});

test.afterEach(async () => {
  await handle.close();
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

test('a newly sent message stays visible above the composer in a long thread', async () => {
  const { page } = handle;
  await submitPrompt(page, 'fill the transcript '.repeat(200));
  await waitForSettled(page);

  await transcript(page).evaluate((element) => {
    Reflect.set(element, 'scrollTop', 0);
  });

  const assistantCount = await page.locator('.block-assistant').count();
  await submitPrompt(page, 'delay assistant and keep this newest message visible');
  const newest = page
    .locator('.block-user')
    .filter({ hasText: 'delay assistant and keep this newest message visible' });

  // The fake runtime pauses before message_start: this assertion can only be
  // satisfied by the send render, not by a later assistant chunk re-pinning.
  await expect(newest).toBeVisible({ timeout: 1000 });
  expect(await page.locator('.block-assistant').count()).toBe(assistantCount);
  await expect
    .poll(() => fullyInsideTranscript(newest, transcript(page)), { timeout: 1000 })
    .toBe(true);
  await page.waitForTimeout(100);
  expect(await fullyInsideTranscript(newest, transcript(page))).toBe(true);
  expect(await page.locator('.block-assistant').count()).toBe(assistantCount);
  await expect(page.getByRole('button', { name: 'Go to bottom' })).toHaveCount(0);
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

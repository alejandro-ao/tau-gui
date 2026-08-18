/**
 * Optional smoke test against a real installed runtime.
 *
 * Skipped unless `TAU_GUI_REAL_RUNTIME=1`. By default it only starts the runtime
 * and reads state, so it never sends a prompt and never spends provider credit.
 * Set `TAU_GUI_REAL_PROMPT=1` as well to additionally complete one real coding
 * turn (this does spend provider credit). Point it at another binary or runtime
 * with:
 *
 *   TAU_GUI_REAL_RUNTIME=1 TAU_GUI_REAL_BINARY=/path/to/tau npx playwright test e2e/smoke.real.spec.ts
 */
import { expect, test } from '@playwright/test';
import {
  launchApp,
  submitPrompt,
  transcriptText,
  waitForConnected,
  waitForSettled,
  type AppHandle,
} from './helpers.js';

const enabled = process.env['TAU_GUI_REAL_RUNTIME'] === '1';
const binary = process.env['TAU_GUI_REAL_BINARY'] ?? 'tau';
const kind = process.env['TAU_GUI_REAL_KIND'] === 'pi' ? 'pi' : 'tau';
const promptEnabled = enabled && process.env['TAU_GUI_REAL_PROMPT'] === '1';
const promptText = process.env['TAU_GUI_REAL_PROMPT_TEXT'] ?? 'Reply with exactly: pong';
const promptExpectation = process.env['TAU_GUI_REAL_PROMPT_EXPECT'] ?? 'pong';

test.describe('real runtime smoke', () => {
  test.skip(!enabled, 'set TAU_GUI_REAL_RUNTIME=1 to run against an installed runtime');

  let handle: AppHandle;

  test.afterAll(async () => {
    await handle?.close();
  });

  test('starts the installed runtime and retrieves session state', async () => {
    handle = await launchApp({
      settings: {
        agentRuntime: kind,
        runtime: {
          tau: { binary, provider: null, model: null, extraArgs: [] },
          pi: { binary, provider: null, model: null, extraArgs: [] },
        },
      },
    });
    const { page } = handle;

    await waitForConnected(page);
    await expect(page.getByTestId('sidebar')).toContainText(kind);

    // State retrieval only: no prompt is sent, so no provider call happens.
    const state = await page.evaluate<{ sessionId: string; isStreaming: boolean }>(
      `window.tau.invoke('agent.state')`,
    );
    expect(typeof state.sessionId).toBe('string');
    expect(state.isStreaming).toBe(false);

    await expect(page.getByTestId('status-row')).toContainText(handle.projectDir);
  });

  test('completes one real turn', async () => {
    test.skip(!promptEnabled, 'set TAU_GUI_REAL_PROMPT=1 to spend provider credit');
    test.setTimeout(180_000);
    const { page } = handle;

    await submitPrompt(page, promptText);
    await waitForSettled(page, 150_000);
    expect(await transcriptText(page)).toContain(promptExpectation);
    // The composer stays usable after a real turn settles.
    await expect(page.getByTestId('composer').getByRole('textbox')).toBeEnabled();
  });
});

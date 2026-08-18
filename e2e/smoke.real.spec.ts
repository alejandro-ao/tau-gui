/**
 * Optional smoke test against a real installed runtime.
 *
 * Skipped unless `TAU_GUI_REAL_RUNTIME=1`. It only starts the runtime and reads
 * state, so it never sends a prompt and never spends provider credit. Point it
 * at another binary or runtime with:
 *
 *   TAU_GUI_REAL_RUNTIME=1 TAU_GUI_REAL_BINARY=/path/to/tau npx playwright test e2e/smoke.real.spec.ts
 */
import { expect, test } from '@playwright/test';
import { launchApp, waitForConnected, type AppHandle } from './helpers.js';

const enabled = process.env['TAU_GUI_REAL_RUNTIME'] === '1';
const binary = process.env['TAU_GUI_REAL_BINARY'] ?? 'tau';
const kind = process.env['TAU_GUI_REAL_KIND'] === 'pi' ? 'pi' : 'tau';

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
});

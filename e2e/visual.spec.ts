/**
 * Visual regression suite.
 *
 * Gated behind `VISUAL=1` because the baselines are rendered by this machine's
 * fonts and GPU stack (see e2e/README.md). Content is deterministic: the fake
 * runtime provides the connected session, and transcript states that a live
 * stream cannot hold still (tool running/failure, long output) are pushed
 * through the real main → renderer event channel.
 */
import { expect, test, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AppSettings, ThemeName } from '../src/shared/domain.js';
import {
  FAKE_RUNTIME,
  injectAgentEvent,
  injectSettings,
  launchApp,
  screenshotMasks,
  setWindowSize,
  stabilizeForScreenshot,
  transcript,
  type AppHandle,
} from './helpers.js';

const VISUAL_USER_DATA = join(tmpdir(), 'tau-gui-visual-userdata');
const VISUAL_PROJECT = join(tmpdir(), 'tau-gui-visual-project');

const runtimeSettings = {
  binary: FAKE_RUNTIME,
  provider: null,
  model: null,
  extraArgs: [] as string[],
};

/** Full settings record, so injected settings events keep the UI deterministic. */
function settings(patch: Partial<AppSettings> = {}): AppSettings {
  return {
    agentRuntime: 'tau',
    theme: 'tau-dark',
    sidebarPosition: 'right',
    turnNotification: 'off',
    showThinking: true,
    cwd: VISUAL_PROJECT,
    projectTrust: 'default',
    runtime: { tau: { ...runtimeSettings }, pi: { ...runtimeSettings } },
    scopedModels: { tau: [], pi: [] },
    recentSessions: [],
    ...patch,
  };
}

const NOW = 1_700_000_000_000;

function user(text: string): AgentEvent {
  return { type: 'message_end', message: { role: 'user', text, images: [], timestamp: NOW } };
}

function assistant(text: string, thinking = ''): AgentEvent {
  return {
    type: 'message_end',
    message: {
      role: 'assistant',
      text,
      thinking,
      toolCalls: [],
      provider: 'fake',
      model: 'fake-large',
      usage: null,
      stopReason: 'stop',
      errorMessage: null,
      timestamp: NOW,
    },
  };
}

const ROLE_SCRIPT: AgentEvent[] = [
  user('Explain the transcript roles and show a snippet.'),
  assistant(
    [
      'Roles render with their own vertical bar:',
      '',
      '- `you` for user turns',
      '- `assistant` for model output',
      '- `thinking` for reasoning',
      '',
      '```ts',
      'export const value = 1;',
      '```',
    ].join('\n'),
    'Considering the request carefully.',
  ),
  { type: 'compaction_start', reason: 'threshold' },
  {
    type: 'compaction_end',
    reason: 'threshold',
    aborted: false,
    willRetry: false,
    errorMessage: null,
  },
  { type: 'runtime_error', message: 'provider unavailable (503)' },
];

const LONG_OUTPUT = Array.from(
  { length: 40 },
  (_value, index) => `line ${String(index + 1).padStart(3, '0')}: deterministic long tool output`,
).join('\n');

const TOOL_SCRIPT: AgentEvent[] = [
  user('Run the tool states.'),
  { type: 'tool_start', toolCallId: 'call-run', toolName: 'bash', args: { command: 'npm test' } },
  {
    type: 'tool_update',
    toolCallId: 'call-run',
    toolName: 'bash',
    args: { command: 'npm test' },
    partialText: 'running tests…',
  },
  { type: 'tool_start', toolCallId: 'call-ok', toolName: 'grep', args: { pattern: 'value' } },
  {
    type: 'tool_end',
    toolCallId: 'call-ok',
    toolName: 'grep',
    text: 'src/index.ts:1:export const value = 1;\n',
    details: { exit_code: 0 },
    isError: false,
  },
  { type: 'tool_start', toolCallId: 'call-bad', toolName: 'lint', args: { path: 'src' } },
  {
    type: 'tool_end',
    toolCallId: 'call-bad',
    toolName: 'lint',
    text: 'src/index.ts:1:1  error  unexpected token\n1 problem (1 error)\n',
    details: { exit_code: 1 },
    isError: true,
  },
  {
    type: 'tool_start',
    toolCallId: 'call-diff',
    toolName: 'patch',
    args: { path: 'src/index.ts' },
  },
  {
    type: 'tool_end',
    toolCallId: 'call-diff',
    toolName: 'patch',
    text: [
      '--- src/index.ts',
      '+++ src/index.ts',
      '@@ -1,3 +1,3 @@',
      ' export const value = 1;',
      '-export const old = true;',
      '+export const next = true;',
      '',
    ].join('\n'),
    details: {},
    isError: false,
  },
  assistant('Tool checks complete.'),
];

const LONG_SCRIPT: AgentEvent[] = [
  user('Show a long tool output.'),
  {
    type: 'tool_start',
    toolCallId: 'call-long',
    toolName: 'bash',
    args: { command: 'npm run ci' },
  },
  {
    type: 'tool_end',
    toolCallId: 'call-long',
    toolName: 'bash',
    text: LONG_OUTPUT,
    details: { exit_code: 0 },
    isError: false,
  },
  assistant('Command complete.'),
];

async function play(handle: AppHandle, script: AgentEvent[]): Promise<void> {
  for (const event of script) await injectAgentEvent(handle.app, event);
  await expect(transcript(handle.page)).not.toContainText('No messages yet');
  // Let the transcript settle (auto-scroll + height measurement) before capture.
  await handle.page.waitForTimeout(250);
}

async function clearTranscript(page: Page): Promise<void> {
  await page.keyboard.press('Control+n');
  await expect(transcript(page)).toContainText('No messages yet');
}

async function shot(handle: AppHandle, name: string): Promise<void> {
  await expect(handle.page).toHaveScreenshot(name, {
    mask: screenshotMasks(handle.page),
    animations: 'disabled',
    caret: 'hide',
    maxDiffPixelRatio: 0.01,
  });
}

test.describe('visual regression', () => {
  test.skip(process.env['VISUAL'] !== '1', 'set VISUAL=1 to run the visual regression suite');
  test.describe.configure({ mode: 'serial', timeout: 120_000 });

  let handle: AppHandle;

  test.beforeAll(async () => {
    rmSync(VISUAL_USER_DATA, { recursive: true, force: true });
    handle = await launchApp({
      userDataDir: VISUAL_USER_DATA,
      projectDir: VISUAL_PROJECT,
      settings: { cwd: VISUAL_PROJECT },
    });
    await setWindowSize(handle.app, 1200, 800);
    await stabilizeForScreenshot(handle.page);
  });

  test.afterAll(async () => {
    await handle.close();
    rmSync(VISUAL_USER_DATA, { recursive: true, force: true });
  });

  for (const theme of ['tau-dark', 'tau-light', 'high-contrast'] as ThemeName[]) {
    test(`transcript roles in ${theme}`, async () => {
      // Clear first: a new session refreshes settings from disk, which would
      // otherwise overwrite the injected theme.
      await clearTranscript(handle.page);
      await injectSettings(handle.app, settings({ theme }));
      await expect(handle.page.locator('html')).toHaveAttribute('data-theme', theme);
      await play(handle, ROLE_SCRIPT);
      await shot(handle, `roles-${theme}.png`);
    });
  }

  test('tool running, success, failure, and diff states', async () => {
    await clearTranscript(handle.page);
    await injectSettings(handle.app, settings());
    await expect(handle.page.locator('html')).toHaveAttribute('data-theme', 'tau-dark');
    await play(handle, TOOL_SCRIPT);
    await shot(handle, 'tools-collapsed.png');

    await handle.page.keyboard.press('Control+o');
    await expect(handle.page.locator('.tool-args').first()).toBeVisible();
    await handle.page.waitForTimeout(250);
    await shot(handle, 'tools-expanded.png');
    await handle.page.keyboard.press('Control+o');
  });

  test('long tool output collapsed and expanded', async () => {
    await clearTranscript(handle.page);
    await play(handle, LONG_SCRIPT);
    await shot(handle, 'long-output-collapsed.png');

    await handle.page.locator('.tool-run-header').last().click();
    await handle.page.locator('.block-tool .block-header').first().click();
    await expect(handle.page.locator('.tool-output')).toBeVisible();
    await handle.page.waitForTimeout(250);
    await shot(handle, 'long-output-expanded.png');
  });

  test('command palette and model picker', async () => {
    await clearTranscript(handle.page);
    await handle.page.keyboard.press('Control+k');
    await expect(handle.page.getByTestId('modal-palette')).toBeVisible();
    await shot(handle, 'palette.png');
    await handle.page.keyboard.press('Escape');

    await handle.page
      .getByTestId('status-row')
      .getByRole('button', { name: /fake-large/ })
      .click();
    await expect(handle.page.getByTestId('modal-model')).toBeVisible();
    await shot(handle, 'model-picker.png');
    await handle.page.keyboard.press('Escape');
    await expect(handle.page.getByTestId('modal-model')).toHaveCount(0);
  });

  test('sidebar right, left, and off', async () => {
    await clearTranscript(handle.page);
    await play(handle, ROLE_SCRIPT);

    for (const position of ['right', 'left', 'off'] as const) {
      await injectSettings(handle.app, settings({ sidebarPosition: position }));
      await expect(handle.page.locator('.app')).toHaveAttribute('data-sidebar', position);
      await handle.page.waitForTimeout(200);
      await shot(handle, `sidebar-${position}.png`);
    }
    await injectSettings(handle.app, settings());
  });

  test('wide and narrow layouts', async () => {
    await clearTranscript(handle.page);
    await play(handle, ROLE_SCRIPT);

    await setWindowSize(handle.app, 1400, 900);
    await expect(handle.page.locator('.app')).toHaveAttribute('data-narrow', 'false');
    await handle.page.waitForTimeout(200);
    await shot(handle, 'layout-wide.png');

    await setWindowSize(handle.app, 760, 700);
    await expect(handle.page.locator('.app')).toHaveAttribute('data-narrow', 'true');
    await handle.page.waitForTimeout(200);
    await shot(handle, 'layout-narrow.png');

    // The sidebar is reachable as a drawer while narrow.
    await handle.page.getByRole('button', { name: 'session' }).click();
    await expect(handle.page.getByTestId('sidebar')).toBeVisible();
    await handle.page.waitForTimeout(200);
    await shot(handle, 'layout-narrow-drawer.png');

    await setWindowSize(handle.app, 1200, 800);
  });
});

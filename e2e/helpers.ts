/**
 * Shared Electron end-to-end harness.
 *
 * Every launch gets its own userData directory (through the main-process
 * `TAU_GUI_USER_DATA_DIR` hook) and a seeded `settings.json` that points the
 * runtime at `test/fake/fake-runtime.mjs`, so tests never touch a developer's
 * real settings and never need provider credentials.
 */
import {
  _electron as electron,
  expect,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AgentEvent, AppSettings, RuntimeKind } from '../src/shared/domain.js';
import { IPC_EVENT_CHANNEL } from '../src/shared/ipc.js';

export const REPO_ROOT = resolve(import.meta.dirname, '..');
export const MAIN_ENTRY = join(REPO_ROOT, 'out/main/index.js');
export const FAKE_RUNTIME = join(REPO_ROOT, 'test/fake/fake-runtime.mjs');

export interface LaunchOptions {
  /** Extra settings merged over the seeded defaults. */
  settings?: Partial<AppSettings>;
  /** Extra environment for the Electron process (e.g. FAKE_RUNTIME_DELAY_MS). */
  env?: Record<string, string>;
  /** Fixed directories: used by the visual suite for stable screenshots. */
  userDataDir?: string;
  projectDir?: string;
  /** Skip waiting for the runtime connection (crash/failure scenarios). */
  waitForRuntime?: boolean;
}

export interface AppHandle {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  projectDir: string;
  /** Unique argv marker used to find this launch's runtime child process. */
  marker: string;
  close: () => Promise<void>;
}

let launchCounter = 0;

function seedSettings(
  userDataDir: string,
  projectDir: string,
  marker: string,
  overrides: Partial<AppSettings>,
  kind: RuntimeKind = 'tau',
): void {
  const runtimeSettings = {
    binary: FAKE_RUNTIME,
    provider: null,
    model: null,
    extraArgs: ['--e2e-marker', marker],
  };
  const settings: AppSettings = {
    agentRuntime: kind,
    theme: 'tau-dark',
    sidebarPosition: 'right',
    turnNotification: 'off',
    showThinking: true,
    cwd: projectDir,
    projectTrust: 'default',
    runtime: { tau: { ...runtimeSettings }, pi: { ...runtimeSettings } },
    scopedModels: { tau: [], pi: [] },
    recentSessions: [],
    ...overrides,
  };
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(join(userDataDir, 'settings.json'), `${JSON.stringify(settings, null, 2)}\n`);
}

/** Creates a small deterministic project tree for cwd/completion assertions. */
function seedProject(projectDir: string): void {
  mkdirSync(join(projectDir, 'src'), { recursive: true });
  writeFileSync(join(projectDir, 'src', 'index.ts'), 'export const value = 1;\n');
  writeFileSync(join(projectDir, 'README.md'), '# fake project\n');
}

export async function launchApp(options: LaunchOptions = {}): Promise<AppHandle> {
  launchCounter += 1;
  const marker = `e2e-${process.pid}-${launchCounter}-${Date.now()}`;
  const userDataDir = options.userDataDir ?? mkdtempSync(join(tmpdir(), 'tau-gui-userdata-'));
  const projectDir = options.projectDir ?? mkdtempSync(join(tmpdir(), 'tau-gui-project-'));
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  seedProject(projectDir);
  seedSettings(userDataDir, projectDir, marker, options.settings ?? {});

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env['TAU_GUI_USER_DATA_DIR'] = userDataDir;
  env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = '1';
  Object.assign(env, options.env ?? {});

  const app = await electron.launch({
    args: [MAIN_ENTRY],
    cwd: REPO_ROOT,
    env,
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.locator('.app').waitFor();

  const handle: AppHandle = {
    app,
    page,
    userDataDir,
    projectDir,
    marker,
    close: async () => {
      await app.close().catch(() => undefined);
      if (!options.userDataDir) rmSync(userDataDir, { recursive: true, force: true });
      if (!options.projectDir) rmSync(projectDir, { recursive: true, force: true });
    },
  };

  if (options.waitForRuntime !== false) await waitForConnected(page);
  return handle;
}

/** Waits until the runtime handshake finished and the UI reports idle. */
export async function waitForConnected(page: Page): Promise<void> {
  await expect(page.getByTestId('connection-notice')).toHaveCount(0);
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle');
}

export function composer(page: Page): ReturnType<Page['getByLabel']> {
  return page.getByLabel('composer');
}

export function transcript(page: Page): ReturnType<Page['getByRole']> {
  return page.getByRole('log', { name: 'transcript' });
}

/** Types into the composer without submitting. */
export async function typeDraft(page: Page, text: string): Promise<void> {
  const input = composer(page);
  await input.click();
  await input.fill(text);
  await expect(input).toHaveValue(text);
}

/** Fills the composer and submits with the given key. */
export async function submitPrompt(
  page: Page,
  text: string,
  key: 'Enter' | 'Alt+Enter' = 'Enter',
): Promise<void> {
  await typeDraft(page, text);
  await composer(page).press(key);
}

/** Waits until the run finished (the runtime reported agent_settled). */
export async function waitForSettled(page: Page, timeout?: number): Promise<void> {
  const options = timeout === undefined ? undefined : { timeout };
  await expect(page.getByTestId('status-row')).toHaveAttribute('data-state', 'idle', options);
  await expect(page.getByTestId('prompt-slot')).toContainText('idle', options);
}

export async function transcriptText(page: Page): Promise<string> {
  return transcript(page).innerText();
}

/** Blocks currently rendered in the transcript, by kind. */
export function blocks(page: Page, kind: string): ReturnType<Page['locator']> {
  return page.locator(`.block-${kind}`);
}

/** Pids of the runtime children belonging to this launch (matched by marker). */
export function runtimePids(marker: string): number[] {
  const output = execFileSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of output.split('\n')) {
    if (!line.includes(marker)) continue;
    if (!line.includes('fake-runtime.mjs')) continue;
    const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
    if (Number.isInteger(pid)) pids.push(pid);
  }
  return pids;
}

/** Kills this launch's runtime subprocess to simulate a crash. */
export async function killRuntime(marker: string): Promise<void> {
  await expect.poll(() => runtimePids(marker).length, { timeout: 10_000 }).toBeGreaterThan(0);
  for (const pid of runtimePids(marker)) process.kill(pid, 'SIGKILL');
}

/**
 * Freezes anything that would make a screenshot non-deterministic: transitions,
 * animations, the caret blink, and the scrollbar.
 */
export async function stabilizeForScreenshot(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }
      .transcript { scrollbar-width: none !important; }
      .transcript::-webkit-scrollbar { display: none !important; }
    `,
  });
}

/** Resizes the Electron window so screenshots have a fixed layout. */
export async function setWindowSize(
  app: ElectronApplication,
  width: number,
  height: number,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) return;
      window.setResizable(true);
      window.setMinimumSize(400, 300);
      window.setContentSize(size.width, size.height);
    },
    { width, height },
  );
  await app
    .windows()[0]
    ?.waitForFunction(`Math.abs(window.innerWidth - ${width}) <= 2`, undefined, {
      timeout: 10_000,
    });
}

/**
 * Pushes a domain event down the real main → renderer channel.
 *
 * Used by the visual suite to render states the deterministic fake runtime
 * cannot hold still for (tool running, tool failure, long output). It exercises
 * the production preload validation path; no application code is stubbed.
 */
export async function injectAgentEvent(app: ElectronApplication, event: AgentEvent): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(payload.channel, {
        type: 'agent',
        event: payload.event,
      });
    },
    { channel: IPC_EVENT_CHANNEL, event },
  );
}

/** Pushes a settings event (theme, sidebar position, …) into the renderer. */
export async function injectSettings(
  app: ElectronApplication,
  settings: AppSettings,
): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send(payload.channel, {
        type: 'settings',
        settings: payload.settings,
      });
    },
    { channel: IPC_EVENT_CHANNEL, settings },
  );
}

/** Volatile regions (paths, ids, timestamps) masked out of screenshots. */
export function screenshotMasks(page: Page): ReturnType<Page['locator']>[] {
  return [
    page.locator('[data-testid="status-row"] .status-left'),
    page.locator('.sidebar-row:has(dt:text-is("cwd")) dd'),
    page.locator('.sidebar-row:has(dt:text-is("file")) dd'),
    page.locator('.sidebar-row:has(dt:text-is("id")) dd'),
    page.locator('.sidebar-row:has(dt:text-is("branch")) dd'),
    page.locator('.picker-hint'),
    page.locator('.picker-detail'),
    page.locator('.tool-elapsed'),
  ];
}

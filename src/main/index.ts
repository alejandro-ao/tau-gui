import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { app, BrowserWindow, ipcMain, shell, session as electronSession } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCsp } from '../shared/csp.js';
import type { BridgeEvent, IpcResponse } from '../shared/ipc.js';
import {
  bridgeEventSchema,
  envelopeSchema,
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  parseSessionIpcResult,
} from '../shared/ipc.js';
import { handleRequest } from './ipc.js';
import { JsonlAgentRuntime } from './runtime/agent-runtime.js';
import { EmbeddedPiRuntime } from './runtime/embedded-pi-runtime.js';
import { ImageAttachmentService } from './services/image-attachments.js';
import { ImportRecoveryService } from './services/import-recovery.js';
import { RuntimePool } from './services/runtime-pool.js';
import { SettingsStore } from './services/settings.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !app.isPackaged;

/**
 * Test-only hook: redirect the whole userData tree (settings, cache, storage)
 * into an isolated directory. End-to-end runs set it so they never read or
 * overwrite a developer's real GUI settings. It must be applied before the app
 * is ready, and it is ignored unless the environment variable is present.
 */
const isolatedUserData = process.env['TAU_GUI_USER_DATA_DIR'];
if (isolatedUserData) {
  mkdirSync(isolatedUserData, { recursive: true });
  app.setPath('userData', isolatedUserData);
}

// Playwright drives the renderer through CDP and does not need a native window
// on the desktop. Keep this hook coupled to isolated test data so setting the
// flag by itself can never hide a normal application launch.
const hideWindowForTests =
  isolatedUserData !== undefined && process.env['TAU_GUI_E2E_HIDDEN'] === '1';

// Identical to the document meta CSP injected at build time (src/shared/csp.ts).
const CSP = buildCsp(isDev);

let mainWindow: BrowserWindow | null = null;
let settings: SettingsStore;
let manager: RuntimePool;
let importRecovery: ImportRecoveryService;
let images: ImageAttachmentService;

function broadcast(event: BridgeEvent): void {
  const parsed = bridgeEventSchema.safeParse(event);
  if (!parsed.success) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_EVENT_CHANNEL, parsed.data);
  }
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 720,
    minHeight: 480,
    show: false,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'τ',
    autoHideMenuBar: true,
    // Blend the title bar into the app on macOS: the traffic lights stay as a
    // small overlay and the renderer provides an invisible drag strip.
    ...(process.platform === 'darwin'
      ? {
          titleBarStyle: 'hiddenInset' as const,
          vibrancy: 'sidebar' as const,
          visualEffectState: 'active' as const,
        }
      : {}),
    webPreferences: {
      preload: join(dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      // Hidden windows are normally throttled, which can make streaming and
      // timing assertions unnecessarily slow in the end-to-end suite.
      backgroundThrottling: !hideWindowForTests,
    },
  });

  if (!hideWindowForTests) window.once('ready-to-show', () => window.show());
  window.on('focus', () => broadcast({ type: 'focus', focused: true }));
  window.on('blur', () => broadcast({ type: 'focus', focused: false }));
  window.on('closed', () => {
    mainWindow = null;
  });

  // Renderer must never navigate or open windows on its own.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL'];
    if (!devServer || !url.startsWith(devServer)) event.preventDefault();
  });

  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (isDev && devServer) {
    void window.loadURL(devServer);
  } else {
    void window.loadFile(join(dirname, '../renderer/index.html'));
  }
  return window;
}

void app.whenReady().then(() => {
  electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
  // Deny every optional permission; the app needs none of them.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
    callback(false),
  );

  settings = new SettingsStore(SettingsStore.defaultFile(app.getPath('userData')));
  importRecovery = new ImportRecoveryService(getAgentDir(), (path) => shell.openPath(path));
  images = new ImageAttachmentService();
  const useTestRpcRuntime = process.env['TAU_GUI_TEST_RPC_RUNTIME'] === '1';
  manager = new RuntimePool(settings, broadcast, {
    runtimeFactory: useTestRpcRuntime
      ? (kind, sink) => new JsonlAgentRuntime(kind, sink)
      : (_kind, sink) =>
          new EmbeddedPiRuntime(sink, {
            spawnSession: (request, signal) => manager.spawnSession(request, signal),
          }),
    probeExecutable: useTestRpcRuntime,
  });

  ipcMain.handle(IPC_INVOKE_CHANNEL, async (_event, raw: unknown): Promise<IpcResponse> => {
    const parsed = envelopeSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0]?.message ?? '';
      return { ok: false, error: `Invalid IPC request: ${issue}`.slice(0, 1_000) };
    }
    try {
      const value = await handleRequest(
        { settings, manager, importRecovery, images, window: () => mainWindow },
        parsed.data,
      );
      return {
        ok: true,
        value: parseSessionIpcResult(parsed.data.action, value) as typeof value,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: message.replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, ' ').slice(0, 1_000),
      };
    }
  });

  mainWindow = createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void manager?.stopAll();
});

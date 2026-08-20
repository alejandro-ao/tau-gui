import { app, BrowserWindow, ipcMain, shell, session as electronSession } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCsp } from '../shared/csp.js';
import type { BridgeEvent, IpcResponse } from '../shared/ipc.js';
import { envelopeSchema, IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '../shared/ipc.js';
import { handleRequest } from './ipc.js';
import { JsonlAgentRuntime } from './runtime/agent-runtime.js';
import { EmbeddedPiRuntime } from './runtime/embedded-pi-runtime.js';
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

// Identical to the document meta CSP injected at build time (src/shared/csp.ts).
const CSP = buildCsp(isDev);

let mainWindow: BrowserWindow | null = null;
let settings: SettingsStore;
let manager: RuntimePool;

function broadcast(event: BridgeEvent): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_EVENT_CHANNEL, event);
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
    },
  });

  window.once('ready-to-show', () => window.show());
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
      return { ok: false, error: `Invalid IPC request: ${parsed.error.issues[0]?.message ?? ''}` };
    }
    try {
      const value = await handleRequest(
        { settings, manager, window: () => mainWindow },
        parsed.data,
      );
      return { ok: true, value };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
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

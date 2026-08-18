import { app, BrowserWindow, ipcMain, shell, session as electronSession } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BridgeEvent, IpcResponse } from '../shared/ipc.js';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL, requestSchema } from '../shared/ipc.js';
import { handleRequest } from './ipc.js';
import { RuntimeManager } from './services/runtime-manager.js';
import { SettingsStore } from './services/settings.js';

const dirname = fileURLToPath(new URL('.', import.meta.url));
const isDev = !app.isPackaged;

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  `style-src 'self' 'unsafe-inline'`,
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'" + (isDev ? ' ws://localhost:* http://localhost:*' : ''),
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

let mainWindow: BrowserWindow | null = null;
let settings: SettingsStore;
let manager: RuntimeManager;

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
    backgroundColor: '#0b0f10',
    title: 'τ',
    autoHideMenuBar: true,
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
  manager = new RuntimeManager(settings, broadcast);

  ipcMain.handle(IPC_INVOKE_CHANNEL, async (_event, raw: unknown): Promise<IpcResponse> => {
    const parsed = requestSchema.safeParse(raw);
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
  void manager?.stop();
});

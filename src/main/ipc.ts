import { dialog, Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { IpcAction, IpcRequest, IpcResult } from '../shared/ipc.js';
import { resourceCatalogSchema } from '../shared/ipc.js';
import { probeRuntime } from './services/discovery.js';
import { completePaths, toDisplayPath } from './services/filesystem.js';
import { discoverTauResources } from './services/resources.js';
import type { RuntimePool } from './services/runtime-pool.js';
import type { SettingsStore } from './services/settings.js';

export interface HandlerContext {
  settings: SettingsStore;
  manager: RuntimePool;
  window: () => BrowserWindow | null;
}

const SAFE_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

/** Executes one validated request. Throws on failure; the caller serializes it. */
export async function handleRequest(
  context: HandlerContext,
  request: IpcRequest,
): Promise<IpcResult<IpcAction>> {
  const { settings, manager } = context;

  switch (request.action) {
    case 'settings.get':
      return settings.current;
    case 'settings.update':
      return settings.update(request.payload);
    case 'settings.forgetSession':
      return settings.forgetSession(request.payload.id);

    case 'runtime.start':
      return manager.start({
        cwd: request.payload.cwd ?? null,
        sessionRef: request.payload.sessionRef ?? null,
      });
    case 'runtime.stop':
      return manager.stop();
    case 'runtime.probe': {
      // The binary is always read from settings: the renderer cannot ask the
      // main process to execute an arbitrary path.
      const kind = request.payload?.kind ?? settings.current.agentRuntime;
      return probeRuntime(kind, settings.current.runtime[kind].binary);
    }
    case 'runtime.snapshot':
      return manager.snapshot();

    case 'agent.prompt':
      await manager.active.prompt({ text: request.payload.text });
      return null;
    case 'agent.steer':
      await manager.active.steer({ text: request.payload.text });
      return null;
    case 'agent.followUp':
      await manager.active.followUp({ text: request.payload.text });
      return null;
    case 'agent.abort':
      await manager.active.abort();
      return null;
    case 'agent.state':
      return manager.active.getState();
    case 'agent.messages':
      return manager.active.getMessages();
    case 'agent.entries':
      return manager.active.getEntries(request.payload?.cursor);
    case 'agent.tree':
      return manager.active.getTree();
    case 'agent.stats':
      return manager.active.getStats();

    case 'models.list':
      return manager.active.listModels();
    case 'models.set': {
      // Model/thinking mutations change the authoritative agent state, so the
      // snapshot is refreshed like it is for session mutations below.
      const model = await manager.active.setModel(request.payload);
      await manager.refreshState();
      return model;
    }
    case 'models.cycle': {
      const result = await manager.active.cycleModel();
      await manager.refreshState();
      return result;
    }

    case 'thinking.list':
      return manager.active.listThinkingLevels();
    case 'thinking.set':
      await manager.active.setThinking(request.payload.level);
      await manager.refreshState();
      return null;
    case 'thinking.cycle': {
      const level = await manager.active.cycleThinking();
      await manager.refreshState();
      return level;
    }

    case 'session.new':
      await manager.active.newSession();
      await manager.refreshState();
      return null;
    case 'session.switch':
      await manager.activateSession(request.payload.ref);
      return null;
    case 'session.name':
      await manager.active.nameSession(request.payload.name);
      await manager.refreshState();
      return null;
    case 'session.fork':
      return manager.active.fork(request.payload.entryId);
    case 'session.compact':
      return manager.active.compact(request.payload?.instructions);
    case 'session.autoCompaction':
      await manager.active.setAutoCompaction(request.payload.enabled);
      return null;
    case 'session.exportHtml': {
      const window = context.window();
      const options = {
        title: 'Export session as HTML',
        defaultPath: 'session.html',
        filters: [{ name: 'HTML', extensions: ['html'] }],
      };
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return null;
      return manager.active.exportHtml(result.filePath);
    }

    case 'shell.run':
      return manager.active.runShell(request.payload.command, request.payload.excludeFromContext);
    case 'shell.abort':
      await manager.active.abortShell();
      return null;

    case 'commands.list':
      return manager.active.listCommands();
    case 'resources.list': {
      const snapshot = manager.snapshot();
      if (snapshot.runtime !== 'tau' || !snapshot.cwd) {
        return { skills: [], prompts: [], diagnostics: [] };
      }
      const catalog = await discoverTauResources(snapshot.cwd, {
        // Only an explicit main-process trust choice authorizes project reads.
        // "default" may lead the runtime to prompt, but it is not a positive
        // decision available to this discovery service.
        includeProject: settings.current.projectTrust === 'approve-once',
      });
      return resourceCatalogSchema.parse(catalog);
    }

    case 'fs.complete': {
      const cwd = manager.snapshot().cwd ?? settings.current.cwd ?? process.cwd();
      return completePaths(cwd, request.payload.query, request.payload.limit);
    }
    case 'fs.pickDirectory': {
      const window = context.window();
      const options = {
        title: 'Open project directory',
        properties: ['openDirectory' as const, 'createDirectory' as const],
      };
      const result = window
        ? await dialog.showOpenDialog(window, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
    case 'fs.relativize': {
      const cwd = manager.snapshot().cwd ?? settings.current.cwd ?? process.cwd();
      return request.payload.paths.map((path) => toDisplayPath(cwd, path));
    }

    case 'ui.openExternal': {
      let url: URL;
      try {
        url = new URL(request.payload.url);
      } catch {
        throw new Error('Refusing to open a malformed URL');
      }
      if (!SAFE_PROTOCOLS.has(url.protocol)) {
        throw new Error(`Refusing to open unsupported protocol: ${url.protocol}`);
      }
      await shell.openExternal(url.toString());
      return null;
    }
    case 'ui.setTitle': {
      context.window()?.setTitle(request.payload.title.slice(0, 200));
      return null;
    }
    case 'ui.notify': {
      if (settings.current.turnNotification !== 'desktop') return null;
      if (!Notification.isSupported()) return null;
      const notification = new Notification({
        title: request.payload.title.slice(0, 120),
        body: request.payload.body.slice(0, 240),
        silent: false,
      });
      notification.on('click', () => {
        const window = context.window();
        if (window) {
          if (window.isMinimized()) window.restore();
          window.focus();
        }
      });
      notification.show();
      return null;
    }
    case 'diagnostics.list':
      return manager.listDiagnostics();
  }
}

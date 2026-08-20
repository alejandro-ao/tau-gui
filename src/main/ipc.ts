import { clipboard, dialog, Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { IpcAction, IpcEnvelope, IpcResult } from '../shared/ipc.js';
import { contextFilesSchema, resourceCatalogSchema } from '../shared/ipc.js';
import { discoverContextFiles } from './services/context-files.js';
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
  request: IpcEnvelope,
): Promise<IpcResult<IpcAction>> {
  const { settings, manager } = context;
  // Session-scoped commands are routed by the transcript identity the renderer
  // acted on, so an in-flight session switch cannot redirect them.
  const target = request.session ?? null;
  const runtime = (): ReturnType<typeof manager.runtimeFor> => manager.runtimeFor(target);

  switch (request.action) {
    case 'settings.get':
      return settings.current;
    case 'settings.update':
      return settings.update(request.payload);
    case 'settings.toggleScopedModel':
      return settings.toggleScopedModel(request.payload.runtime, request.payload);
    case 'settings.rememberWorkingDirectory':
      return settings.rememberWorkingDirectory(request.payload.cwd);
    case 'settings.forgetSession':
      return settings.forgetSession(request.payload.id);

    case 'runtime.start':
      return manager.start({
        cwd: request.payload.cwd ?? null,
        sessionRef: request.payload.sessionRef ?? null,
      });
    case 'runtime.openSession':
      return manager.openSession(request.payload.cwd);
    case 'runtime.stop':
      return manager.stop();
    case 'runtime.restart':
      return manager.restart();
    case 'runtime.probe': {
      // The binary is always read from settings: the renderer cannot ask the
      // main process to execute an arbitrary path.
      const kind = request.payload?.kind ?? settings.current.agentRuntime;
      return probeRuntime(kind, settings.current.runtime[kind].binary);
    }
    case 'runtime.snapshot':
      return manager.snapshot();

    case 'agent.prompt':
      await runtime().prompt({ text: request.payload.text });
      return null;
    case 'agent.steer':
      manager.enqueuePrompt('steering', request.payload.text, target);
      return null;
    case 'agent.followUp':
      manager.enqueuePrompt('follow-up', request.payload.text, target);
      return null;
    case 'queue.snapshot':
      return manager.queueSnapshot(target);
    case 'queue.pop':
      return manager.popPrompt(target);
    case 'queue.resolve':
      return manager.resolvePromptRecall(request.payload.id, request.payload.outcome, target);
    case 'agent.abort':
      await runtime().abort();
      return null;
    case 'agent.state':
      return runtime().getState();
    case 'agent.messages':
      return runtime().getMessages();
    case 'agent.entries':
      return runtime().getEntries(request.payload?.cursor);
    case 'agent.tree':
      return runtime().getTree();
    case 'agent.stats':
      return runtime().getStats();

    case 'models.list':
      return runtime().listModels();
    case 'models.set': {
      // Model/thinking mutations change the authoritative agent state, so the
      // snapshot is refreshed like it is for session mutations below.
      const model = await runtime().setModel(request.payload);
      await manager.refreshState(false, target);
      return model;
    }
    case 'models.cycle': {
      const result = await runtime().cycleModel();
      await manager.refreshState(false, target);
      return result;
    }

    case 'thinking.list':
      return runtime().listThinkingLevels();
    case 'thinking.set':
      await runtime().setThinking(request.payload.level);
      await manager.refreshState(false, target);
      return null;
    case 'thinking.cycle': {
      const level = await runtime().cycleThinking();
      await manager.refreshState(false, target);
      return level;
    }

    case 'session.new':
      await manager.newSession(target);
      return null;
    case 'session.switch':
      await manager.activateSession(request.payload.ref);
      return null;
    case 'session.name':
      await manager.nameSession(request.payload.name, target);
      return null;
    case 'session.fork':
      return runtime().fork(request.payload.entryId);
    case 'session.compact':
      return runtime().compact(request.payload?.instructions);
    case 'session.autoCompaction':
      await runtime().setAutoCompaction(request.payload.enabled);
      return null;
    case 'session.exportHtml': {
      if (request.payload?.destination) {
        return runtime().exportHtml(request.payload.destination);
      }
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
      return runtime().exportHtml(result.filePath);
    }

    case 'shell.run':
      return runtime().runShell(request.payload.command, request.payload.excludeFromContext);
    case 'shell.abort':
      await runtime().abortShell();
      return null;

    case 'commands.list':
      return runtime().listCommands();
    case 'resources.list': {
      const active = runtime();
      if (active.getResources) {
        return resourceCatalogSchema.parse(await active.getResources());
      }
      // Deterministic legacy RPC tests do not embed Pi; retain their bounded
      // metadata-only scanner until the test harness moves to injected sessions.
      const snapshot = manager.snapshot();
      if (snapshot.runtime !== 'tau' || !snapshot.cwd) {
        return { skills: [], prompts: [], diagnostics: [] };
      }
      const catalog = await discoverTauResources(snapshot.cwd, {
        includeProject: manager.effectiveProjectTrust === 'approve-once',
      });
      return resourceCatalogSchema.parse(catalog);
    }
    case 'context.list': {
      const active = runtime();
      if (active.getContextFiles) {
        return contextFilesSchema.parse(await active.getContextFiles());
      }
      const snapshot = manager.snapshot();
      if (snapshot.runtime !== 'tau' || !snapshot.cwd) return [];
      const files = await discoverContextFiles(snapshot.cwd, {
        includeProject: manager.effectiveProjectTrust === 'approve-once',
      });
      return contextFilesSchema.parse(files);
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
    case 'ui.copyText':
      clipboard.writeText(request.payload.text);
      return null;
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

import { clipboard, dialog, Notification, shell } from 'electron';
import type { BrowserWindow } from 'electron';
import type { IpcAction, IpcEnvelope, IpcResult } from '../shared/ipc.js';
import {
  bashResultSchema,
  contextFilesSchema,
  entrySnapshotSchema,
  imageAttachmentListSchema,
  resourceCatalogSchema,
  resourceReloadResultSchema,
  sessionCatalogSchema,
  sessionNameSchema,
  systemPromptInspectionSchema,
  toolCatalogSchema,
  treeNavigateResultSchema,
  treeSnapshotSchema,
  piAgentPreferencesSchema,
  providerAuthListSchema,
} from '../shared/ipc.js';
import { discoverContextFiles } from './services/context-files.js';
import { probeRuntime } from './services/discovery.js';
import { completePaths, toDisplayPath } from './services/filesystem.js';
import type { ImageAttachmentService } from './services/image-attachments.js';
import type { AgentRuntime } from './runtime/agent-runtime.js';
import type { ImportRecoveryAccess } from './services/import-recovery.js';
import { discoverTauResources } from './services/resources.js';
import type { ExtensionHostService } from './services/extension-host.js';
import type { RuntimePool } from './services/runtime-pool.js';
import type { SettingsStore } from './services/settings.js';
import { recentSummary, rendererSettings } from './services/session-identity.js';

export interface HandlerContext {
  settings: SettingsStore;
  manager: RuntimePool;
  importRecovery: ImportRecoveryAccess;
  window: () => BrowserWindow | null;
  images?: ImageAttachmentService;
  extensionHost?: ExtensionHostService;
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
  type Runtime = ReturnType<typeof manager.runtimeFor>;
  const read = <T>(operation: (runtime: Runtime) => Promise<T>): Promise<T> =>
    manager.readRuntime(target, operation);
  const mutate = <T>(operation: (runtime: Runtime) => Promise<T>): Promise<T> =>
    manager.mutateRuntime(target, operation);
  // Authentication challenges must remain callable while a login promise is pending.
  const runtime = (): Runtime => manager.runtimeFor(target);

  switch (request.action) {
    case 'settings.get':
      return rendererSettings(settings.current);
    case 'settings.update':
      return rendererSettings(settings.update(request.payload));
    case 'settings.toggleScopedModel':
      return rendererSettings(settings.toggleScopedModel(request.payload.runtime, request.payload));
    case 'settings.addResourceDirectory': {
      const kind = request.payload.kind;
      const path = await pickDirectory(
        context,
        kind === 'skills' ? 'Add skills directory' : 'Add prompt templates directory',
      );
      return path ? rendererSettings(settings.addResourceDirectory(kind, path)) : null;
    }
    case 'settings.removeResourceDirectory':
      return rendererSettings(
        settings.removeResourceDirectory(request.payload.kind, request.payload.path),
      );
    case 'settings.rememberWorkingDirectory':
      return rendererSettings(settings.rememberWorkingDirectory(request.payload.cwd));
    case 'settings.forgetSession':
      return rendererSettings(settings.forgetSession(request.payload.id));

    case 'runtime.start':
      return manager.start({ cwd: request.payload.cwd ?? null });
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

    case 'agent.prompt': {
      const images = request.payload.attachmentIds?.length
        ? requiredImageService(context).take(
            request.payload.attachmentIds,
            await read((runtime) => imageSessionKey(runtime, true)),
          )
        : undefined;
      await manager.prompt({ text: request.payload.text, images }, target);
      return null;
    }
    case 'agent.steer': {
      if (request.payload.attachmentIds?.length) {
        await mutate(async (runtime) => {
          const images = requiredImageService(context).take(
            request.payload.attachmentIds!,
            await imageSessionKey(runtime, true),
          );
          await runtime.steer({ text: request.payload.text, images });
        });
      } else {
        manager.enqueuePrompt('steering', request.payload.text, target);
      }
      return null;
    }
    case 'agent.followUp': {
      if (request.payload.attachmentIds?.length) {
        await mutate(async (runtime) => {
          const images = requiredImageService(context).take(
            request.payload.attachmentIds!,
            await imageSessionKey(runtime, true),
          );
          await runtime.followUp({ text: request.payload.text, images });
        });
      } else {
        manager.enqueuePrompt('follow-up', request.payload.text, target);
      }
      return null;
    }
    case 'images.prepare': {
      const key = await read((runtime) => imageSessionKey(runtime, true));
      return imageAttachmentListSchema.parse(
        await requiredImageService(context).prepare(request.payload.paths, key),
      );
    }
    case 'images.remove': {
      requiredImageService(context).remove(
        request.payload.id,
        await read((runtime) => imageSessionKey(runtime, false)),
      );
      return null;
    }
    case 'queue.snapshot':
      return manager.queueSnapshot(target);
    case 'queue.pop':
      return manager.popPrompt(target);
    case 'queue.resolve':
      return manager.resolvePromptRecall(request.payload.id, request.payload.outcome, target);
    case 'agent.abort':
      await mutate((runtime) => runtime.abort());
      return null;
    case 'agent.state': {
      const state = await read((runtime) => runtime.getState());
      return {
        model: state.model,
        thinkingLevel: state.thinkingLevel,
        isStreaming: state.isStreaming,
        isCompacting: state.isCompacting,
        persisted: state.persisted,
        sessionId: state.sessionId,
        sessionName: state.sessionName,
        autoCompactionEnabled: state.autoCompactionEnabled,
        messageCount: state.messageCount,
        pendingMessageCount: state.pendingMessageCount,
      };
    }
    case 'agent.messages':
      return read((runtime) => runtime.getMessages());
    case 'agent.entries':
      return entrySnapshotSchema.parse(
        await read((runtime) => runtime.getEntries(request.payload?.cursor)),
      );
    case 'agent.tree':
      return treeSnapshotSchema.parse(await read((runtime) => runtime.getTree()));
    case 'agent.stats':
      return read((runtime) => runtime.getStats());

    case 'models.list':
      return read((runtime) => runtime.listModels());
    case 'models.set':
      // Model/thinking mutations and their authoritative refresh hold one gate.
      return mutate(async (runtime) => {
        const model = await runtime.setModel(request.payload);
        await manager.refreshState(false, target);
        return model;
      });
    case 'models.cycle':
      return mutate(async (runtime) => {
        const result = await runtime.cycleModel();
        await manager.refreshState(false, target);
        return result;
      });

    case 'auth.providers': {
      const active = runtime();
      if (!active.listProviderAuth) throw new Error('Provider authentication is unavailable');
      return providerAuthListSchema.parse(await active.listProviderAuth());
    }
    case 'auth.login': {
      const active = runtime();
      if (!active.loginProvider) throw new Error('Provider authentication is unavailable');
      await active.loginProvider(request.payload.providerId, request.payload.method);
      await manager.refreshState(false, target);
      return null;
    }
    case 'auth.respond': {
      const active = runtime();
      if (!active.respondProviderAuth) throw new Error('Provider authentication is unavailable');
      await active.respondProviderAuth(
        request.payload.flowId,
        request.payload.challengeId,
        request.payload.value,
      );
      return null;
    }
    case 'auth.cancel': {
      const active = runtime();
      if (!active.cancelProviderAuth) throw new Error('Provider authentication is unavailable');
      await active.cancelProviderAuth(request.payload.flowId);
      return null;
    }
    case 'auth.logout': {
      const active = runtime();
      if (!active.logoutProvider) throw new Error('Provider authentication is unavailable');
      await active.logoutProvider(request.payload.providerId);
      await manager.refreshState(false, target);
      return null;
    }
    case 'pi.preferences.get': {
      const active = runtime();
      if (!active.getPiPreferences) throw new Error('Pi preferences are unavailable');
      return piAgentPreferencesSchema.parse(await active.getPiPreferences());
    }
    case 'pi.preferences.update': {
      const active = runtime();
      if (!active.updatePiPreferences) throw new Error('Pi preferences are unavailable');
      const preferences = await active.updatePiPreferences(request.payload);
      await manager.refreshState(false, target);
      return piAgentPreferencesSchema.parse(preferences);
    }
    case 'retry.abort': {
      const active = runtime();
      if (!active.abortRetry) throw new Error('Retry cancellation is unavailable');
      await active.abortRetry();
      await manager.refreshState(false, target);
      return null;
    }

    case 'thinking.list':
      return read((runtime) => runtime.listThinkingLevels());
    case 'thinking.set':
      await mutate(async (runtime) => {
        await runtime.setThinking(request.payload.level);
        await manager.refreshState(false, target);
      });
      return null;
    case 'thinking.cycle':
      return mutate(async (runtime) => {
        const level = await runtime.cycleThinking();
        await manager.refreshState(false, target);
        return level;
      });

    case 'session.new':
      await manager.newSession(target);
      return null;
    case 'session.switch':
      await manager.activateSession(request.payload.ref);
      return null;
    case 'session.name':
      await manager.nameSession(sessionNameSchema.parse(request.payload.name), target);
      return null;
    case 'session.fork':
      return treeNavigateResultSchema.parse(
        await mutate((runtime) => runtime.fork(request.payload.entryId, request.payload)),
      );
    case 'session.label':
      await mutate((runtime) => runtime.setLabel(request.payload.entryId, request.payload.label));
      return null;
    case 'session.clone':
      await manager.cloneSession(target);
      return null;
    case 'session.importJsonl': {
      const input = await pickSessionFile(context);
      if (!input) return null;
      await manager.importSession(input, target);
      return null;
    }
    case 'session.importHealth':
      return context.importRecovery.health();
    case 'session.revealImportRecovery':
      await context.importRecovery.reveal();
      return null;
    case 'session.list': {
      const snapshot = manager.snapshot();
      const active = await read((runtime) => Promise.resolve(runtime.capabilities));
      const native = active.sessionList
        ? await read((runtime) => runtime.listSessions(request.payload.scope))
        : [];
      const nativeSessions = new Set(
        native.map((session) => `${session.runtime}:${session.sessionId}`),
      );
      const recent = settings.current.recentSessions
        .filter(
          (session) =>
            !nativeSessions.has(`${session.runtime}:${session.id}`) &&
            (request.payload.scope === 'all' || session.cwd === snapshot.cwd),
        )
        .map(recentSummary);
      return sessionCatalogSchema.parse([...native, ...recent].slice(0, 500));
    }
    case 'session.compact':
      return mutate((runtime) => runtime.compact(request.payload?.instructions));
    case 'session.autoCompaction':
      await mutate((runtime) => runtime.setAutoCompaction(request.payload.enabled));
      return null;
    case 'session.exportHtml': {
      const destination = await pickExportPath(context, 'html');
      return destination ? read((runtime) => runtime.exportHtml(destination)) : null;
    }
    case 'session.exportJsonl': {
      while (true) {
        const destination = await pickExportPath(context, 'jsonl');
        if (!destination) return null;
        try {
          return await read((runtime) =>
            runtime.exportJsonl(destination, request.payload?.sessionId),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await showExportCollision(context);
        }
      }
    }

    case 'shell.run':
      return bashResultSchema.parse(
        await mutate((runtime) =>
          runtime.runShell(request.payload.command, request.payload.excludeFromContext),
        ),
      );
    case 'shell.abort':
      await mutate((runtime) => runtime.abortShell());
      return null;

    case 'commands.list':
      return read((runtime) => runtime.listCommands());
    case 'agent.inspectSystemPrompt':
      return read(async (runtime) => {
        if (!runtime.inspectSystemPrompt) {
          throw new Error('System prompt inspection is unavailable');
        }
        return systemPromptInspectionSchema.parse(await runtime.inspectSystemPrompt());
      });
    case 'extensions.list': {
      const host = requiredExtensionHost(context);
      return host.list(manager.snapshot().cwd, manager.effectiveProjectTrust === 'approve-once');
    }
    case 'extensions.policy.get':
      return requiredExtensionHost(context).getPolicy();
    case 'extensions.policy.update':
      return requiredExtensionHost(context).updatePolicy(request.payload);
    case 'extensions.host.probe':
      return requiredExtensionHost(context).probe();
    case 'extensions.dialog.respond':
      requiredExtensionHost(context).respondDialog(
        request.payload.requestId,
        request.payload.value,
      );
      return null;
    case 'tools.list':
      return read(async (runtime) => {
        if (!runtime.listTools) throw new Error('Tool catalog inspection is unavailable');
        return toolCatalogSchema.parse(await runtime.listTools());
      });
    case 'resources.reload':
      return resourceReloadResultSchema.parse(await manager.reloadResources(target));
    case 'resources.list':
      return read(async (runtime) => {
        if (runtime.getResources) {
          return resourceCatalogSchema.parse(await runtime.getResources());
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
      });
    case 'context.list':
      return read(async (runtime) => {
        if (runtime.getContextFiles) {
          return contextFilesSchema.parse(await runtime.getContextFiles());
        }
        const snapshot = manager.snapshot();
        if (snapshot.runtime !== 'tau' || !snapshot.cwd) return [];
        const files = await discoverContextFiles(snapshot.cwd, {
          includeProject: manager.effectiveProjectTrust === 'approve-once',
        });
        return contextFilesSchema.parse(files);
      });

    case 'fs.complete': {
      const cwd = manager.snapshot().cwd ?? settings.current.cwd ?? process.cwd();
      return completePaths(cwd, request.payload.query, request.payload.limit);
    }
    case 'fs.pickDirectory':
      return pickDirectory(context, 'Open project directory');
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

async function pickSessionFile(context: HandlerContext): Promise<string | null> {
  const options = {
    title: 'Import Pi session',
    properties: ['openFile' as const],
    filters: [{ name: 'Pi session', extensions: ['jsonl'] }],
  };
  const window = context.window();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

async function pickExportPath(
  context: HandlerContext,
  extension: 'html' | 'jsonl',
): Promise<string | null> {
  const options = {
    title: `Export session as ${extension.toUpperCase()}`,
    defaultPath: `session.${extension}`,
    filters: [{ name: extension === 'html' ? 'HTML' : 'Pi session', extensions: [extension] }],
  };
  const window = context.window();
  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  return result.canceled ? null : (result.filePath ?? null);
}

async function showExportCollision(context: HandlerContext): Promise<void> {
  const options = {
    type: 'warning' as const,
    title: 'Choose a new export file',
    message: 'That file already exists. Portable export creates new files only.',
    detail: 'Choose a different filename; the existing file was not changed.',
    buttons: ['Choose another name'],
  };
  const window = context.window();
  if (window) await dialog.showMessageBox(window, options);
  else await dialog.showMessageBox(options);
}

function requiredImageService(context: HandlerContext): ImageAttachmentService {
  if (!context.images) throw new Error('Image attachments are unavailable');
  return context.images;
}

async function imageSessionKey(runtime: AgentRuntime, requireCapability: boolean): Promise<string> {
  const state = await runtime.getState();
  if (requireCapability && !state.model?.input.includes('image')) {
    throw new Error('The active model does not support image prompts');
  }
  if (!state.sessionId) throw new Error('No active session for image attachments');
  return `${runtime.kind}:${state.sessionId}`;
}

function requiredExtensionHost(context: HandlerContext): ExtensionHostService {
  if (!context.extensionHost) throw new Error('Extension isolation service is unavailable');
  return context.extensionHost;
}

async function pickDirectory(context: HandlerContext, title: string): Promise<string | null> {
  const options = {
    title,
    properties: ['openDirectory' as const, 'createDirectory' as const],
  };
  const window = context.window();
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

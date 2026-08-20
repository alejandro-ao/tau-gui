import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  type AgentSession,
  type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
import { basename, dirname, join, resolve } from 'node:path';
import type { ContextFile } from '../../shared/ipc.js';
import type {
  AgentMessage,
  AgentState,
  BashResult,
  CommandInfo,
  CompactionResult,
  EntrySnapshot,
  Model,
  ModelCycleResult,
  ModelRef,
  PromptInput,
  RuntimeCapabilities,
  RuntimeLaunchConfig,
  ResourceCatalog,
  SessionStats,
  ThinkingLevel,
  TreeSnapshot,
} from '../../shared/domain.js';
import type { AgentRuntime, RuntimeSink } from './agent-runtime.js';
import {
  normalizeEntries,
  normalizeEvent,
  normalizeMessages,
  normalizeModel,
  normalizeStats,
  normalizeThinkingLevel,
  normalizeTree,
} from './normalize.js';
import { CAPABILITIES } from './spec.js';

const EMBEDDED_PI_CAPABILITIES: RuntimeCapabilities = {
  ...CAPABILITIES.pi,
  sessionList: true,
  providerLogin: true,
  resourceReload: true,
  systemPromptInspection: true,
  toolCatalog: true,
};

/**
 * Pi SDK adapter used by the packaged application.
 *
 * Pi objects remain in Electron's main process. This adapter deliberately keeps
 * the existing application-domain contract so no SDK type or credential can
 * cross preload IPC into the renderer.
 */
export class EmbeddedPiRuntime implements AgentRuntime {
  readonly kind = 'pi' as const;
  readonly capabilities: RuntimeCapabilities = EMBEDDED_PI_CAPABILITIES;
  private runtime: AgentSessionRuntime | null = null;
  private unsubscribe: (() => void) | null = null;
  private sink: RuntimeSink;
  private readonly agentDir: string;

  constructor(sink: RuntimeSink, options: { agentDir?: string } = {}) {
    this.sink = sink;
    this.agentDir = options.agentDir ?? getAgentDir();
  }

  get running(): boolean {
    return this.runtime !== null;
  }

  async start(config: RuntimeLaunchConfig): Promise<void> {
    if (this.runtime) throw new Error('Pi is already started');
    this.sink.status('starting');

    const agentDir = this.agentDir;
    const createRuntime = async ({
      cwd,
      sessionManager,
    }: {
      cwd: string;
      agentDir: string;
      sessionManager: SessionManager;
    }) => {
      const services = await createAgentSessionServices({
        cwd,
        agentDir,
        // Extensions execute arbitrary Node.js. Keep them disabled until the
        // desktop extension trust/UI contract tracked in issue #17 lands.
        resourceLoaderOptions: { noExtensions: true },
      });
      const requested =
        config.provider && config.model
          ? services.modelRuntime.getModel(config.provider, config.model)
          : undefined;
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: requested,
      });
      return { ...created, services, diagnostics: services.diagnostics };
    };

    const sessionManager = config.sessionRef
      ? await openSession(config.sessionRef, config.cwd, agentDir)
      : SessionManager.create(config.cwd, sessionDirFor(config.cwd, agentDir));
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: config.cwd,
      agentDir,
      sessionManager,
    });
    this.runtime = runtime;
    runtime.setRebindSession((session) => {
      this.bindSession(session);
      return Promise.resolve();
    });
    this.bindSession(runtime.session);
    for (const diagnostic of runtime.diagnostics) {
      this.sink.diagnostic(`Pi ${diagnostic.type}: ${diagnostic.message}`);
    }
    this.sink.status(runtime.session.isStreaming ? 'running' : 'idle');
  }

  async stop(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (runtime) await runtime.dispose();
    this.sink.status('stopped');
  }

  private bindSession(session: AgentSession): void {
    this.unsubscribe?.();
    this.unsubscribe = session.subscribe((event) => {
      const normalized = normalizeEvent(event);
      if (normalized) this.sink.event(normalized);
      // These Pi-native state events have no transcript equivalent, but the
      // manager's authoritative refresh after terminal boundaries observes them.
      else if (
        !['entry_appended', 'session_info_changed', 'thinking_level_changed'].includes(event.type)
      ) {
        this.sink.diagnostic(`Ignored unknown Pi event: ${event.type}`);
      }
    });
  }

  private get host(): AgentSessionRuntime {
    if (!this.runtime) throw new Error('Pi is not started');
    return this.runtime;
  }

  private get session(): AgentSession {
    return this.host.session;
  }

  async prompt(input: PromptInput): Promise<void> {
    await this.session.prompt(input.text);
  }

  async steer(input: PromptInput): Promise<void> {
    await this.session.steer(input.text);
  }

  async followUp(input: PromptInput): Promise<void> {
    await this.session.followUp(input.text);
  }

  abort(): Promise<void> {
    return this.session.abort();
  }

  getState(): Promise<AgentState> {
    const session = this.session;
    return Promise.resolve({
      model: normalizeModel(session.model),
      thinkingLevel: normalizeThinkingLevel(session.thinkingLevel),
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      sessionFile: session.sessionFile ?? null,
      sessionId: session.sessionId,
      sessionName: session.sessionName ?? null,
      autoCompactionEnabled: session.autoCompactionEnabled,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
    });
  }

  getMessages(): Promise<AgentMessage[]> {
    return Promise.resolve(normalizeMessages(this.session.messages));
  }

  getEntries(cursor?: string): Promise<EntrySnapshot> {
    const entries = this.session.sessionManager.getEntries();
    const start = cursor ? Math.max(0, entries.findIndex((entry) => entry.id === cursor) + 1) : 0;
    return Promise.resolve({
      entries: normalizeEntries(entries.slice(start)),
      leafId: this.session.sessionManager.getLeafId(),
    });
  }

  getTree(): Promise<TreeSnapshot> {
    return Promise.resolve({
      tree: normalizeTree(this.session.sessionManager.getTree()),
      leafId: this.session.sessionManager.getLeafId(),
    });
  }

  getStats(): Promise<SessionStats> {
    return Promise.resolve(normalizeStats(this.session.getSessionStats()));
  }

  async listModels(): Promise<Model[]> {
    const available = await this.session.modelRuntime.getAvailable();
    const source = available.length > 0 ? available : this.session.modelRuntime.getModels();
    return source.map(normalizeModel).filter((model): model is Model => model !== null);
  }

  async setModel(ref: ModelRef): Promise<Model | null> {
    const model = this.session.modelRuntime.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`Unknown Pi model: ${ref.provider}/${ref.modelId}`);
    await this.session.setModel(model);
    return normalizeModel(model);
  }

  async cycleModel(): Promise<ModelCycleResult | null> {
    const result = await this.session.cycleModel();
    const model = normalizeModel(result?.model);
    return result && model
      ? {
          model,
          thinkingLevel: normalizeThinkingLevel(result.thinkingLevel),
          isScoped: result.isScoped,
        }
      : null;
  }

  listThinkingLevels(): Promise<ThinkingLevel[]> {
    return Promise.resolve(
      this.session.getAvailableThinkingLevels().map((level) => normalizeThinkingLevel(level)),
    );
  }

  setThinking(level: ThinkingLevel): Promise<void> {
    this.session.setThinkingLevel(level);
    return Promise.resolve();
  }

  cycleThinking(): Promise<ThinkingLevel | null> {
    const level = this.session.cycleThinkingLevel();
    return Promise.resolve(level ? normalizeThinkingLevel(level) : null);
  }

  setAutoCompaction(enabled: boolean): Promise<void> {
    this.session.setAutoCompactionEnabled(enabled);
    return Promise.resolve();
  }

  async compact(instructions?: string): Promise<CompactionResult> {
    const result = await this.session.compact(instructions);
    return {
      summary: result.summary,
      firstKeptEntryId: result.firstKeptEntryId ?? null,
      tokensBefore: result.tokensBefore,
      estimatedTokensAfter: result.estimatedTokensAfter ?? 0,
    };
  }

  async runShell(command: string, excludeFromContext: boolean): Promise<BashResult> {
    const result = await this.session.executeBash(command, undefined, { excludeFromContext });
    return {
      command,
      output: result.output,
      exitCode: result.exitCode ?? null,
      cancelled: result.cancelled,
      truncated: result.truncated,
    };
  }

  abortShell(): Promise<void> {
    this.session.abortBash();
    return Promise.resolve();
  }

  async newSession(): Promise<void> {
    await this.host.newSession();
  }

  async switchSession(ref: string): Promise<void> {
    const info = await findSession(ref, this.agentDir);
    await this.host.switchSession(info?.path ?? ref);
  }

  nameSession(name: string): Promise<void> {
    this.session.setSessionName(name);
    return Promise.resolve();
  }

  async fork(entryId: string): Promise<string> {
    const result = await this.session.navigateTree(entryId);
    return result.editorText ?? '';
  }

  exportHtml(path?: string): Promise<string> {
    return this.session.exportToHtml(path);
  }

  listCommands(): Promise<CommandInfo[]> {
    const extensionCommands = this.session.extensionRunner
      .getRegisteredCommands()
      .map((command) => ({
        name: command.name,
        description: command.description ?? '',
        source: 'runtime' as const,
      }));
    const prompts = this.session.promptTemplates.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      source: 'runtime' as const,
    }));
    return Promise.resolve([...extensionCommands, ...prompts]);
  }

  getContextFiles(): Promise<ContextFile[]> {
    return Promise.resolve(
      this.session.resourceLoader
        .getAgentsFiles()
        .agentsFiles.slice(0, 4)
        .map((file) => ({ label: basename(file.path), path: file.path })),
    );
  }

  async getResources(): Promise<ResourceCatalog> {
    const loader = this.session.resourceLoader;
    const skillsResult = loader.getSkills();
    const promptsResult = loader.getPrompts();
    const diagnostics = [...skillsResult.diagnostics, ...promptsResult.diagnostics].map(
      (item) => `${item.type}: ${item.message}`,
    );
    return {
      skills: await Promise.all(
        skillsResult.skills.map(async (skill) => ({
          name: skill.name,
          description: skill.description || null,
          origin: skill.sourceInfo.source,
          disableModelInvocation: skill.disableModelInvocation,
          // The file stays main-process-owned. Size gives a deterministic,
          // bounded approximation without sending its contents over IPC.
          estimatedTokens: await estimateFileTokens(skill.filePath),
        })),
      ),
      prompts: promptsResult.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description || null,
        origin: prompt.sourceInfo.source,
      })),
      diagnostics,
    };
  }
}

async function estimateFileTokens(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? Math.ceil(Math.min(info.size, 1_000_000) / 4) : 0;
  } catch {
    return 0;
  }
}

async function findSession(ref: string, agentDir: string) {
  const sessions = await SessionManager.listAll(join(agentDir, 'sessions'));
  return sessions.find((session) => session.id === ref || session.path === ref);
}

async function openSession(ref: string, cwd: string, agentDir: string): Promise<SessionManager> {
  if (existsSync(ref)) return SessionManager.open(ref, dirname(ref), cwd);
  const info = await findSession(ref, agentDir);
  if (!info) throw new Error(`Pi session not found: ${ref}`);
  return SessionManager.open(info.path, dirname(info.path), info.cwd || cwd);
}

/** Pi accepts a host-selected session directory through its public SDK. */
function sessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
  return join(resolve(agentDir), 'sessions', safePath);
}

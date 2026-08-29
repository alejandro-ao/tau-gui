import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  type ModelRuntime,
  SessionManager,
  type SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  type AgentSession,
  type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_CONTEXT_FILES, type ContextFile } from '../../shared/ipc.js';
import { RESOURCE_LIMITS } from '../../shared/resources.js';
import { estimateTextTokens } from '../../shared/token-estimate.js';
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
  PiAgentPreferences,
  PiAgentPreferencesPatch,
  ProviderAuthMethod,
  ProviderAuthStatus,
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
import { createSpawnSessionTool, type SpawnSessionHandler } from './spawn-session-tool.js';

/**
 * Features executable through the complete desktop application contract.
 *
 * Pi SDK support alone is not enough to enable a flag: the operation must also
 * have an AgentRuntime method, validated IPC, and a usable renderer flow.
 */
export const EMBEDDED_PI_CAPABILITIES: RuntimeCapabilities = {
  textPrompt: true,
  imagePrompt: false,
  steering: true,
  followUps: true,
  directBash: true,
  abortBash: false,
  retryControls: true,
  sessionTree: true,
  sessionClone: false,
  sessionList: false,
  extensionDialogs: false,
  providerLogin: true,
  resourceReload: false,
  systemPromptInspection: false,
  toolCatalog: false,
};

type AuthPromptLike =
  | {
      signal?: AbortSignal;
      type: 'text' | 'secret' | 'manual_code';
      message: string;
      placeholder?: string;
    }
  | {
      signal?: AbortSignal;
      type: 'select';
      message: string;
      options: readonly { id: string; label: string; description?: string }[];
    };

type AuthEventLike =
  | { type: 'info'; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds?: number;
      expiresInSeconds?: number;
    }
  | { type: 'progress'; message: string };

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
  private readonly home: string;
  private readonly spawnSession: SpawnSessionHandler | null;
  private readonly modelRuntime: ModelRuntime | undefined;
  private readonly settingsManager: SettingsManager | undefined;
  private authFlow: {
    id: string;
    controller: AbortController;
    pending: {
      id: string;
      resolve: (value: string) => void;
      reject: (error: Error) => void;
    } | null;
  } | null = null;

  constructor(
    sink: RuntimeSink,
    options: {
      agentDir?: string;
      home?: string;
      spawnSession?: SpawnSessionHandler;
      /** Public SDK service injection for deterministic no-provider tests. */
      modelRuntime?: ModelRuntime;
      settingsManager?: SettingsManager;
    } = {},
  ) {
    this.sink = sink;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.home = options.home ?? homedir();
    this.spawnSession = options.spawnSession ?? null;
    this.modelRuntime = options.modelRuntime;
    this.settingsManager = options.settingsManager;
  }

  get running(): boolean {
    return this.runtime !== null;
  }

  async start(config: RuntimeLaunchConfig): Promise<void> {
    if (this.runtime) throw new Error('Pi is already started');
    this.sink.status('starting');

    const agentDir = this.agentDir;
    const projectRoot = findProjectRoot(config.cwd);
    const additionalSkillPaths = uniquePaths([
      join(agentDir, 'skills'),
      join(this.home, '.pi', 'skills'),
      join(this.home, '.agents', 'skills'),
      join(projectRoot, '.pi', 'skills'),
      join(projectRoot, '.agents', 'skills'),
      ...(config.customSkillDirectories ?? []),
    ]);
    const additionalPromptTemplatePaths = uniquePaths([
      join(agentDir, 'prompts'),
      join(this.home, '.pi', 'prompts'),
      join(this.home, '.agents', 'prompts'),
      join(projectRoot, '.pi', 'prompts'),
      join(projectRoot, '.agents', 'prompts'),
      ...(config.customPromptDirectories ?? []),
    ]);
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
        modelRuntime: this.modelRuntime,
        settingsManager: this.settingsManager,
        // Extensions execute arbitrary Node.js. Keep them disabled until the
        // desktop extension trust/UI contract tracked in issue #17 lands.
        resourceLoaderOptions: {
          noExtensions: true,
          additionalSkillPaths,
          additionalPromptTemplatePaths,
        },
      });
      const requested =
        config.provider && config.model
          ? services.modelRuntime.getModel(config.provider, config.model)
          : undefined;
      const created = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: requested,
        customTools: this.spawnSession
          ? [createSpawnSessionTool(cwd, this.spawnSession)]
          : undefined,
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
    this.authFlow?.controller.abort();
    this.authFlow?.pending?.reject(new Error('Provider login cancelled'));
    this.authFlow = null;
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

  private waitForAuthPrompt(
    flow: NonNullable<EmbeddedPiRuntime['authFlow']>,
    prompt: AuthPromptLike,
  ): Promise<string> {
    if (flow.controller.signal.aborted)
      return Promise.reject(new Error('Provider login cancelled'));
    flow.pending?.reject(new Error('Provider login challenge replaced'));
    const challengeId = randomUUID();
    const options =
      prompt.type === 'select'
        ? prompt.options.slice(0, 50).map((option) => ({
            id: boundedText(option.id, 200),
            label: boundedText(option.label, 300),
            description: option.description ? boundedText(option.description, 1_000) : null,
          }))
        : [];
    this.sink.auth?.({
      flowId: flow.id,
      type: 'prompt',
      challengeId,
      input: prompt.type,
      message: boundedText(prompt.message, 4_096),
      placeholder:
        'placeholder' in prompt && prompt.placeholder ? boundedText(prompt.placeholder, 500) : null,
      options,
    });
    return new Promise<string>((resolve, reject) => {
      flow.pending = { id: challengeId, resolve, reject };
      const abort = () => {
        if (flow.pending?.id === challengeId) flow.pending = null;
        reject(new Error('Provider login cancelled'));
      };
      flow.controller.signal.addEventListener('abort', abort, { once: true });
      prompt.signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private emitAuthNotification(flowId: string, event: AuthEventLike): void {
    if (event.type === 'auth_url') {
      this.sink.auth?.({
        flowId,
        type: 'auth_url',
        url: safeAuthUrl(event.url),
        instructions: event.instructions ? boundedText(event.instructions, 4_096) : null,
      });
      return;
    }
    if (event.type === 'device_code') {
      this.sink.auth?.({
        flowId,
        type: 'device_code',
        userCode: boundedText(event.userCode, 500),
        verificationUri: safeAuthUrl(event.verificationUri),
        intervalSeconds: boundedOptionalInteger(event.intervalSeconds, 86_400),
        expiresInSeconds: boundedOptionalInteger(event.expiresInSeconds, 86_400),
      });
      return;
    }
    this.sink.auth?.({
      flowId,
      type: event.type,
      message: boundedText(event.message, 4_096),
      links:
        event.type === 'info'
          ? (event.links ?? []).slice(0, 10).map((link) => ({
              url: safeAuthUrl(link.url),
              label: link.label ? boundedText(link.label, 300) : null,
            }))
          : [],
    });
  }

  async listProviderAuth(): Promise<ProviderAuthStatus[]> {
    const modelRuntime = this.host.services.modelRuntime;
    const credentials = new Map(
      (await modelRuntime.listCredentials({ signal: AbortSignal.timeout(5_000) })).map((item) => [
        item.providerId,
        item.type,
      ]),
    );
    const statuses = await Promise.all(
      modelRuntime
        .getProviders()
        .slice(0, 100)
        .map(async (provider) => {
          const providerId = boundedIdentifier(provider.id);
          if (providerId !== provider.id) return null;
          const methods: ProviderAuthMethod[] = [];
          if (provider.auth.apiKey?.login) methods.push('api_key');
          if (provider.auth.oauth) methods.push('oauth');
          let check: Awaited<ReturnType<typeof modelRuntime.checkAuth>>;
          try {
            check = await modelRuntime.checkAuth(provider.id, {
              signal: AbortSignal.timeout(5_000),
            });
          } catch {
            check = undefined;
          }
          const credentialType = credentials.get(provider.id) ?? check?.type ?? null;
          return {
            id: providerId,
            name: boundedText(provider.name, 200),
            methods,
            configured: check !== undefined,
            credentialType,
            source: credentialType
              ? credentials.has(provider.id)
                ? `stored ${credentialType === 'oauth' ? 'OAuth' : 'API key'}`
                : `ambient ${credentialType === 'oauth' ? 'OAuth' : 'credential'}`
              : null,
          } satisfies ProviderAuthStatus;
        }),
    );
    return statuses
      .filter((status): status is ProviderAuthStatus => status !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async loginProvider(providerId: string, method: ProviderAuthMethod): Promise<void> {
    if (this.authFlow) throw new Error('A provider login is already in progress');
    const provider = this.host.services.modelRuntime.getProvider(providerId);
    if (!provider) throw new Error('Unknown provider');
    if (method === 'api_key' && !provider.auth.apiKey?.login) {
      throw new Error('This provider does not support API-key login');
    }
    if (method === 'oauth' && !provider.auth.oauth) {
      throw new Error('This provider does not support OAuth login');
    }

    const flowId = randomUUID();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
    const flow = { id: flowId, controller, pending: null } satisfies NonNullable<
      EmbeddedPiRuntime['authFlow']
    >;
    this.authFlow = flow;
    try {
      await this.host.services.modelRuntime.login(providerId, method, {
        signal: controller.signal,
        prompt: (prompt) => this.waitForAuthPrompt(flow, prompt),
        notify: (event) => this.emitAuthNotification(flowId, event),
      });
      this.sink.auth?.({
        flowId,
        type: 'complete',
        success: true,
        message: 'Provider login complete',
      });
    } catch {
      const cancelled = controller.signal.aborted;
      this.sink.auth?.({
        flowId,
        type: 'complete',
        success: false,
        message: cancelled ? 'Provider login cancelled' : 'Provider login failed',
      });
      throw new Error(cancelled ? 'Provider login cancelled' : 'Provider login failed');
    } finally {
      clearTimeout(timeout);
      if (this.authFlow === flow) this.authFlow = null;
    }
  }

  respondProviderAuth(flowId: string, challengeId: string, value: string): Promise<void> {
    const flow = this.authFlow;
    if (!flow || flow.id !== flowId || flow.pending?.id !== challengeId) {
      return Promise.reject(new Error('Provider login challenge is no longer active'));
    }
    const pending = flow.pending;
    flow.pending = null;
    pending.resolve(value);
    return Promise.resolve();
  }

  cancelProviderAuth(flowId: string): Promise<void> {
    const flow = this.authFlow;
    if (!flow || flow.id !== flowId) return Promise.resolve();
    flow.controller.abort();
    flow.pending?.reject(new Error('Provider login cancelled'));
    flow.pending = null;
    return Promise.resolve();
  }

  async logoutProvider(providerId: string): Promise<void> {
    try {
      await this.host.services.modelRuntime.logout(providerId, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error('Provider logout failed');
    }
  }

  getPiPreferences(): Promise<PiAgentPreferences> {
    const session = this.session;
    const settings = session.settingsManager;
    const retry = settings.getRetrySettings();
    const providerRetry = settings.getProviderRetrySettings();
    const compaction = settings.getCompactionSettings();
    const global = settings.getGlobalSettings();
    return Promise.resolve({
      steeringMode: session.steeringMode,
      followUpMode: session.followUpMode,
      transport: settings.getTransport(),
      retryEnabled: session.autoRetryEnabled,
      retryMaxRetries: retry.maxRetries,
      retryBaseDelayMs: retry.baseDelayMs,
      providerTimeoutMs: providerRetry.timeoutMs ?? null,
      providerMaxRetries: providerRetry.maxRetries ?? 0,
      providerMaxRetryDelayMs: providerRetry.maxRetryDelayMs,
      isRetrying: session.isRetrying,
      retryAttempt: session.retryAttempt,
      autoCompactionEnabled: session.autoCompactionEnabled,
      compactionReserveTokens: compaction.reserveTokens,
      compactionKeepRecentTokens: compaction.keepRecentTokens,
      defaultProvider: global.defaultProvider ?? null,
      defaultModel: global.defaultModel ?? null,
      defaultThinkingLevel: global.defaultThinkingLevel
        ? normalizeThinkingLevel(global.defaultThinkingLevel)
        : null,
      writable: {
        queueModes: true,
        transport: true,
        retryEnabled: true,
        retryPolicy: false,
        autoCompaction: true,
        compactionThresholds: false,
        modelDefaults: true,
      },
    });
  }

  async updatePiPreferences(patch: PiAgentPreferencesPatch): Promise<PiAgentPreferences> {
    const session = this.session;
    const settings = session.settingsManager;
    if (patch.steeringMode) session.setSteeringMode(patch.steeringMode);
    if (patch.followUpMode) session.setFollowUpMode(patch.followUpMode);
    if (patch.transport) settings.setTransport(patch.transport);
    if (patch.retryEnabled !== undefined) session.setAutoRetryEnabled(patch.retryEnabled);
    if (patch.autoCompactionEnabled !== undefined) {
      session.setAutoCompactionEnabled(patch.autoCompactionEnabled);
    }
    if (patch.defaultProvider && patch.defaultModel) {
      settings.setDefaultModelAndProvider(patch.defaultProvider, patch.defaultModel);
    } else {
      if (patch.defaultProvider) settings.setDefaultProvider(patch.defaultProvider);
      if (patch.defaultModel) settings.setDefaultModel(patch.defaultModel);
    }
    if (patch.defaultThinkingLevel) {
      settings.setDefaultThinkingLevel(patch.defaultThinkingLevel);
    }
    await settings.flush();
    for (const error of settings.drainErrors()) {
      this.sink.diagnostic(`Pi settings ${error.scope} write failed`);
    }
    return this.getPiPreferences();
  }

  abortRetry(): Promise<void> {
    this.session.abortRetry();
    return Promise.resolve();
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
    const cwd = this.host.cwd;
    return Promise.resolve(
      this.session.resourceLoader
        .getAgentsFiles()
        .agentsFiles.slice(0, MAX_CONTEXT_FILES)
        .map((file) => ({
          label: contextFileLabel(file.path, cwd, this.agentDir),
          path: file.path,
        })),
    );
  }

  async getResources(): Promise<ResourceCatalog> {
    const loader = this.session.resourceLoader;
    const skillsResult = loader.getSkills();
    const promptsResult = loader.getPrompts();
    const diagnostics = [...skillsResult.diagnostics, ...promptsResult.diagnostics]
      .slice(0, RESOURCE_LIMITS.diagnostics)
      .map((item) =>
        boundedMetadata(`${item.type}: ${item.message}`, RESOURCE_LIMITS.diagnosticCharacters),
      );
    const skills = await Promise.all(
      skillsResult.skills.slice(0, RESOURCE_LIMITS.catalogEntries).map(async (skill) => ({
        name: skill.name,
        description: resourceDescription(skill.description),
        origin: boundedMetadata(skill.sourceInfo.source, RESOURCE_LIMITS.originCharacters),
        disableModelInvocation: skill.disableModelInvocation,
        // The file stays main-process-owned. Preserve the sidebar's
        // provider-neutral estimate of one token per four characters.
        estimatedTokens: await estimateSkillTokens(skill.filePath),
      })),
    );
    const prompts = promptsResult.prompts
      .slice(0, RESOURCE_LIMITS.catalogEntries)
      .map((prompt) => ({
        name: prompt.name,
        description: resourceDescription(prompt.description),
        origin: boundedMetadata(prompt.sourceInfo.source, RESOURCE_LIMITS.originCharacters),
      }));
    return { skills, prompts, diagnostics };
  }
}

function resourceDescription(value: string): string | null {
  const description = boundedMetadata(value, RESOURCE_LIMITS.descriptionCharacters);
  return description || null;
}

/** Pi permits YAML-folded descriptions that retain a trailing newline. */
function boundedText(value: string, limit: number): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    })
    .join('')
    .trim()
    .slice(0, limit);
}

function boundedIdentifier(value: string): string {
  const bounded = boundedText(value, 128).replace(/[^A-Za-z0-9._:@/-]/g, '-');
  return bounded || 'unknown';
}

function boundedOptionalInteger(value: number | undefined, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(max, Math.trunc(value)))
    : null;
}

function safeAuthUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('unsupported');
    return url.toString().slice(0, 4_096);
  } catch {
    throw new Error('Provider returned an invalid authentication URL');
  }
}

function boundedMetadata(value: string, limit: number): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
    })
    .join('')
    .trim()
    .slice(0, limit);
}

function findProjectRoot(cwd: string): string {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return resolve(cwd);
    current = parent;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))].filter((path) => existsSync(path));
}

async function estimateSkillTokens(path: string): Promise<number> {
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile()) return 0;
    const length = Math.min(info.size, RESOURCE_LIMITS.fileBytes);
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return estimateTextTokens(buffer.subarray(0, bytesRead).toString('utf8'));
  } catch {
    return 0;
  } finally {
    await handle?.close();
  }
}

function contextFileLabel(path: string, cwd: string, agentDir: string): string {
  const absolute = resolve(path);
  const globalPath = relative(resolve(agentDir), absolute);
  let label: string;
  if (
    globalPath &&
    globalPath !== '..' &&
    !globalPath.startsWith(`..${sep}`) &&
    !isAbsolute(globalPath)
  ) {
    label = `~/.pi/agent/${slashPath(globalPath)}`;
  } else if (!globalPath) {
    label = '~/.pi/agent';
  } else {
    const projectPath = slashPath(relative(resolve(cwd), absolute));
    label = projectPath.startsWith('.') ? projectPath : `./${projectPath}`;
  }
  return label.length <= 256 ? label : `…${label.slice(-255)}`;
}

function slashPath(path: string): string {
  return path.split(sep).join('/');
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

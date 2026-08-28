import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  type AgentSession,
  type AgentSessionRuntime,
} from '@earendil-works/pi-coding-agent';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_CONTEXT_FILES, type ContextFile } from '../../shared/ipc.js';
import {
  INTROSPECTION_LIMITS,
  resourceReloadResultSchema,
  systemPromptInspectionSchema,
  toolCatalogSchema,
  type ResourceReloadResult,
  type SystemPromptInspection,
  type ToolCatalog,
} from '../../shared/introspection.js';
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
  normalizeSessionIdentifier,
  normalizeStats,
  normalizeThinkingLevel,
  normalizeTree,
} from './normalize.js';
import { createSpawnSessionTool, type SpawnSessionHandler } from './spawn-session-tool.js';
import { boundJson, boundedToolText } from './untrusted.js';

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
  retryControls: false,
  sessionTree: true,
  sessionClone: false,
  sessionList: false,
  extensionDialogs: false,
  providerLogin: false,
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
  private readonly home: string;
  private readonly spawnSession: SpawnSessionHandler | null;

  constructor(
    sink: RuntimeSink,
    options: {
      agentDir?: string;
      home?: string;
      spawnSession?: SpawnSessionHandler;
    } = {},
  ) {
    this.sink = sink;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.home = options.home ?? homedir();
    this.spawnSession = options.spawnSession ?? null;
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
      leafId: normalizeSessionIdentifier(this.session.sessionManager.getLeafId()),
    });
  }

  getTree(): Promise<TreeSnapshot> {
    return Promise.resolve({
      tree: normalizeTree(this.session.sessionManager.getTree()),
      leafId: normalizeSessionIdentifier(this.session.sessionManager.getLeafId()),
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
    const output = boundedToolText(result.output);
    return {
      command,
      output,
      exitCode: result.exitCode ?? null,
      cancelled: result.cancelled,
      truncated: result.truncated || output !== result.output,
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

  inspectSystemPrompt(): Promise<SystemPromptInspection> {
    const text = this.session.systemPrompt;
    const limit = INTROSPECTION_LIMITS.systemPromptCharacters;
    return Promise.resolve(
      systemPromptInspectionSchema.parse({
        text: text.slice(0, limit),
        totalCharacters: text.length,
        truncated: text.length > limit,
        origin: 'active Pi session',
      }),
    );
  }

  listTools(): Promise<ToolCatalog> {
    const diagnostics: string[] = [];
    const diagnose = (message: string): void => {
      if (diagnostics.length >= INTROSPECTION_LIMITS.diagnostics) return;
      diagnostics.push(
        boundedMetadata(message, INTROSPECTION_LIMITS.diagnosticCharacters) ||
          'tool descriptor omitted',
      );
    };

    let allValue: unknown = [];
    try {
      allValue = this.session.getAllTools();
    } catch {
      diagnose('tool catalog could not be reflected; all tools omitted');
    }
    const all = reflectArrayData(allValue, INTROSPECTION_LIMITS.toolEntries, 'tool catalog');
    for (const message of all.diagnostics) diagnose(message);

    let activeValue: unknown = [];
    try {
      activeValue = this.session.getActiveToolNames();
    } catch {
      diagnose('active tool names could not be reflected; all tools marked inactive');
    }
    const activeData = reflectArrayData(
      activeValue,
      INTROSPECTION_LIMITS.toolEntries,
      'active tool names',
    );
    for (const message of activeData.diagnostics) diagnose(message);
    const active = new Set(
      activeData.items
        .filter((value): value is string => typeof value === 'string')
        .map((value) => boundedMetadata(value, INTROSPECTION_LIMITS.toolNameCharacters))
        .filter(Boolean),
    );

    const tools: ToolCatalog['tools'] = [];
    const names = new Set<string>();
    let omitted = all.truncated;
    for (const [index, value] of all.items.entries()) {
      const reflected = reflectToolDescriptor(value);
      if (!reflected.ok) {
        omitted = true;
        diagnose(`tool ${index + 1} omitted: ${reflected.reason}`);
        continue;
      }
      const name = boundedMetadata(reflected.name, INTROSPECTION_LIMITS.toolNameCharacters);
      if (!name) {
        omitted = true;
        diagnose(`tool ${index + 1} omitted: invalid name`);
        continue;
      }
      if (names.has(name)) {
        omitted = true;
        diagnose(`${name}: duplicate normalized tool name omitted`);
        continue;
      }
      names.add(name);

      const bounded = boundJson(reflected.parameters);
      if (bounded.truncated) diagnose(`${name}: parameter schema was truncated`);
      let origin = 'unknown';
      if (reflected.sourceInfo !== undefined) {
        const source = reflectSource(reflected.sourceInfo);
        if (source === null) diagnose(`${name}: malformed source metadata replaced with unknown`);
        else origin = boundedMetadata(source, INTROSPECTION_LIMITS.originCharacters) || 'unknown';
      }
      tools.push({
        name,
        description: boundedMetadata(
          reflected.description,
          INTROSPECTION_LIMITS.toolDescriptionCharacters,
        ),
        origin,
        active: active.has(name),
        parameters: bounded.value,
        schemaTruncated: bounded.truncated,
      });
    }
    if (all.truncated) diagnose('tool catalog limit reached; remaining tools ignored');
    return Promise.resolve(
      toolCatalogSchema.parse({
        tools,
        total: all.total,
        truncated: omitted || tools.length < all.total,
        diagnostics,
      }),
    );
  }

  async reloadResources(): Promise<ResourceReloadResult> {
    const session = this.session;
    if (session.isStreaming || session.isCompacting) {
      throw new Error('Cannot reload resources while agent work is active');
    }
    const before = resourceCounts(session);
    await session.reload();
    if (this.session !== session) throw new Error('Session changed while resources were reloading');
    const after = resourceCounts(session);
    const loader = session.resourceLoader;
    const diagnostics = [
      ...loader.getSkills().diagnostics,
      ...loader.getPrompts().diagnostics,
      ...loader.getThemes().diagnostics,
    ]
      .slice(0, INTROSPECTION_LIMITS.diagnostics)
      .map((item) =>
        boundedMetadata(`${item.type}: ${item.message}`, INTROSPECTION_LIMITS.diagnosticCharacters),
      );
    for (const error of loader.getExtensions().errors) {
      if (diagnostics.length >= INTROSPECTION_LIMITS.diagnostics) break;
      diagnostics.push(
        boundedMetadata(
          `extension: ${error.path}: ${error.error}`,
          INTROSPECTION_LIMITS.diagnosticCharacters,
        ),
      );
    }
    return resourceReloadResultSchema.parse({ before, after, diagnostics });
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

interface ReflectedArrayData {
  items: unknown[];
  total: number;
  truncated: boolean;
  diagnostics: string[];
}

/** Reflects array data without ordinary index/length reads or accessor invocation. */
function reflectArrayData(value: unknown, limit: number, label: string): ReflectedArrayData {
  try {
    if (typeof value !== 'object' || value === null || !Array.isArray(value)) {
      return {
        items: [],
        total: 0,
        truncated: true,
        diagnostics: [`${label} is not a data array; values omitted`],
      };
    }
    const descriptors = Object.getOwnPropertyDescriptors(value) as Record<
      string,
      PropertyDescriptor
    >;
    const length = descriptors['length'];
    const rawLength: unknown = length && 'value' in length ? length.value : null;
    if (typeof rawLength !== 'number' || !Number.isSafeInteger(rawLength) || rawLength < 0) {
      return {
        items: [],
        total: 0,
        truncated: true,
        diagnostics: [`${label} has an invalid length; values omitted`],
      };
    }
    const total = rawLength;
    const count = Math.min(total, limit);
    const items: unknown[] = [];
    const diagnostics: string[] = [];
    let truncated = total > count;
    for (let index = 0; index < count; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) {
        truncated = true;
        diagnostics.push(`${label} item ${index + 1} is missing or accessor-backed; omitted`);
        continue;
      }
      items.push(descriptor.value);
    }
    return { items, total, truncated, diagnostics };
  } catch {
    return {
      items: [],
      total: 0,
      truncated: true,
      diagnostics: [`${label} reflection failed; values omitted`],
    };
  }
}

type ReflectedToolDescriptor =
  | {
      ok: true;
      name: string;
      description: string;
      parameters: unknown;
      sourceInfo: unknown;
    }
  | { ok: false; reason: string };

/** Reflects only own data properties; Proxy/accessor failures omit the descriptor. */
function reflectToolDescriptor(value: unknown): ReflectedToolDescriptor {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'descriptor is not an object' };
  }
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const name = descriptors['name'];
    const description = descriptors['description'];
    const parameters = descriptors['parameters'];
    const sourceInfo = descriptors['sourceInfo'];
    if (!name || !('value' in name) || typeof name.value !== 'string') {
      return { ok: false, reason: 'name is missing, accessor-backed, or malformed' };
    }
    const descriptionValue: unknown =
      description && 'value' in description ? description.value : '';
    if (description && (!('value' in description) || typeof descriptionValue !== 'string')) {
      return { ok: false, reason: 'description is accessor-backed or malformed' };
    }
    if (!parameters || !('value' in parameters)) {
      return { ok: false, reason: 'parameters are missing or accessor-backed' };
    }
    if (sourceInfo && !('value' in sourceInfo)) {
      return { ok: false, reason: 'source metadata is accessor-backed' };
    }
    const parametersValue: unknown = parameters.value;
    const sourceInfoValue: unknown =
      sourceInfo && 'value' in sourceInfo ? sourceInfo.value : undefined;
    return {
      ok: true,
      name: name.value,
      description: descriptionValue as string,
      parameters: parametersValue,
      sourceInfo: sourceInfoValue,
    };
  } catch {
    return { ok: false, reason: 'descriptor reflection failed' };
  }
}

/** Returns null for malformed/accessor-backed source metadata. */
function reflectSource(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  try {
    const descriptor = Object.getOwnPropertyDescriptors(value)['source'];
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? descriptor.value
      : null;
  } catch {
    return null;
  }
}

function resourceCounts(session: AgentSession) {
  const loader = session.resourceLoader;
  return {
    skills: loader.getSkills().skills.length,
    prompts: loader.getPrompts().prompts.length,
    themes: loader.getThemes().themes.length,
    contextFiles: loader.getAgentsFiles().agentsFiles.length,
    extensions: loader.getExtensions().extensions.length,
    tools: session.getAllTools().length,
  };
}

function resourceDescription(value: string): string | null {
  const description = boundedMetadata(value, RESOURCE_LIMITS.descriptionCharacters);
  return description || null;
}

/** Pi permits YAML-folded descriptions that retain a trailing newline. */
function boundedMetadata(value: string, limit: number): string {
  return [...value.slice(0, limit)]
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

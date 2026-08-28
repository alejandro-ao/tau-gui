import { existsSync } from 'node:fs';
import { copyFile, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
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
import { MAX_CONTEXT_FILES, MAX_TREE_EDITOR_TEXT, type ContextFile } from '../../shared/ipc.js';
import { RESOURCE_LIMITS } from '../../shared/resources.js';
import { estimateTextTokens } from '../../shared/token-estimate.js';
import type {
  AgentMessage,
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
  SessionSummary,
  ThinkingLevel,
  TreeSnapshot,
} from '../../shared/domain.js';
import type { AgentRuntime, RuntimeAgentState, RuntimeSink } from './agent-runtime.js';
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
import {
  boundedSessionList,
  ensureCheckedDirectory,
  exclusiveCopy,
  inspectPhysicalFile,
  removePhysicalFile,
  type PhysicalFile,
} from './session-files.js';

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
  sessionClone: true,
  sessionList: true,
  extensionDialogs: false,
  providerLogin: false,
  resourceReload: false,
  systemPromptInspection: false,
  toolCatalog: false,
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
  private readonly importDestinationName: () => string;
  private readonly catalog = new Map<
    string,
    { path: string; sessionId: string; physical: PhysicalFile }
  >();
  private preparedImport: {
    source: string;
    staged: string;
    sessionId: string;
    physical: PhysicalFile;
  } | null = null;

  constructor(
    sink: RuntimeSink,
    options: {
      agentDir?: string;
      home?: string;
      spawnSession?: SpawnSessionHandler;
      /** Deterministic destination naming for filesystem adversarial tests. */
      importDestinationName?: () => string;
    } = {},
  ) {
    this.sink = sink;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.home = options.home ?? homedir();
    this.spawnSession = options.spawnSession ?? null;
    this.importDestinationName = options.importDestinationName ?? (() => `${randomUUID()}.jsonl`);
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
    await this.discardPreparedImport();
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

  getState(): Promise<RuntimeAgentState> {
    const session = this.session;
    return Promise.resolve({
      model: normalizeModel(session.model),
      thinkingLevel: normalizeThinkingLevel(session.thinkingLevel),
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      persisted: session.sessionFile !== undefined,
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
    const normalized = normalizeTree(this.session.sessionManager.getTree());
    return Promise.resolve({
      rows: normalized.rows,
      leafId: this.session.sessionManager.getLeafId(),
      truncated: normalized.truncated,
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
    const info = this.catalog.get(ref) ?? (await resolveCatalogSession(ref, this.agentDir));
    if (!info) throw new Error('Pi session reference is not in the main-owned catalog');
    await this.host.switchSession(info.path);
  }

  nameSession(name: string): Promise<void> {
    this.session.setSessionName(name);
    return Promise.resolve();
  }

  async fork(
    entryId: string,
    options: {
      summary: 'none' | 'default' | 'custom';
      customInstructions?: string;
      label?: string;
    },
  ): Promise<{
    editorText: string | null;
    editorTextTruncated: boolean;
    cancelled: boolean;
    aborted: boolean;
  }> {
    const result = await this.session.navigateTree(entryId, {
      summarize: options.summary !== 'none',
      customInstructions: options.summary === 'custom' ? options.customInstructions : undefined,
      label: options.label,
    });
    const editorText = result.editorText ?? null;
    return {
      editorText: editorText?.slice(0, MAX_TREE_EDITOR_TEXT) ?? null,
      editorTextTruncated: editorText !== null && editorText.length > MAX_TREE_EDITOR_TEXT,
      cancelled: result.cancelled,
      aborted: result.aborted === true,
    };
  }

  setLabel(entryId: string, label: string | null): Promise<void> {
    if (!this.session.sessionManager.getEntry(entryId)) throw new Error('Unknown session entry');
    this.session.sessionManager.appendLabelChange(entryId, label?.trim() || undefined);
    return Promise.resolve();
  }

  async clone(): Promise<void> {
    const leafId = this.session.sessionManager.getLeafId();
    const source = this.session.sessionFile;
    if (!leafId || !source) throw new Error('Send a message before cloning this session');
    const sessionDir = await ensureCheckedDirectory(this.session.sessionManager.getSessionDir());
    const manager = SessionManager.open(source, sessionDir);
    const destination = manager.createBranchedSession(leafId);
    if (!destination) throw new Error('Failed to create cloned session');
    const artifact = await inspectPhysicalFile(destination, sessionDir);
    try {
      const result = await this.host.switchSession(destination);
      if (result.cancelled) throw new Error('Session clone was cancelled');
    } catch (error) {
      await removePhysicalFile(artifact).catch(() => false);
      throw error;
    }
  }

  async prepareImport(path: string): Promise<{ sessionId: string; physicalKey: string }> {
    await this.discardPreparedImport();
    const source = await inspectPhysicalFile(path);
    const current = this.session.sessionFile
      ? await inspectPhysicalFile(this.session.sessionFile).catch(() => null)
      : null;
    if (current?.key === source.key) throw new Error('Cannot import the active session file');

    const stagingRoot = await ensureCheckedDirectory(join(this.agentDir, 'import-staging'));
    const staged = join(stagingRoot, `${randomUUID()}.jsonl`);
    const physical = await exclusiveCopy(source.path, staged);
    try {
      // Public SDK validation only; the application never parses JSONL.
      const manager = SessionManager.open(staged, stagingRoot);
      const sessionId = manager.getSessionId();
      assertValidImportedSessionId(sessionId);
      await assertLogicalSessionIdAvailable(this.agentDir, sessionId);
      this.preparedImport = { source: resolve(path), staged, sessionId, physical };
      return { sessionId, physicalKey: physical.key };
    } catch (error) {
      await removePhysicalFile(physical).catch(() => false);
      throw error;
    }
  }

  async importJsonl(
    path: string,
  ): Promise<{ sessionId: string; physicalKey: string; physicalPath: string }> {
    const prepared = this.preparedImport;
    if (!prepared || prepared.source !== resolve(path))
      throw new Error('Import was not safely prepared');
    const sessionDir = await ensureCheckedDirectory(this.session.sessionManager.getSessionDir());
    const destinationName = this.importDestinationName();
    if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(destinationName)) {
      throw new Error('Unsafe import destination name');
    }
    const destination = join(sessionDir, destinationName);
    let created: PhysicalFile | null = null;
    try {
      created = await exclusiveCopy(prepared.staged, destination);
      const stagedNow = await inspectPhysicalFile(prepared.staged, dirname(prepared.staged));
      const destinationNow = await inspectPhysicalFile(destination, sessionDir);
      if (
        stagedNow.key !== prepared.physical.key ||
        stagedNow.size !== prepared.physical.size ||
        destinationNow.key !== created.key ||
        destinationNow.size !== created.size
      ) {
        throw new Error('Prepared import identity changed before activation');
      }
      const destinationManager = SessionManager.open(destination, sessionDir);
      const sessionId = destinationManager.getSessionId();
      assertValidImportedSessionId(sessionId);
      if (sessionId !== prepared.sessionId) {
        throw new Error('Prepared import logical identity changed before activation');
      }
      // Last possible no-follow identity check before the public replacement API.
      const finalDestination = await inspectPhysicalFile(destination, sessionDir);
      if (finalDestination.key !== created.key || finalDestination.size !== created.size) {
        throw new Error('Import destination changed before activation');
      }
      const result = await this.host.switchSession(destination);
      if (result.cancelled) throw new Error('Session import was cancelled');
      this.preparedImport = null;
      await removePhysicalFile(prepared.physical).catch(() => false);
      return { sessionId, physicalKey: created.key, physicalPath: created.path };
    } catch (error) {
      if (created) await removePhysicalFile(created).catch(() => false);
      throw error;
    }
  }

  async discardPreparedImport(): Promise<void> {
    const prepared = this.preparedImport;
    this.preparedImport = null;
    if (prepared) await removePhysicalFile(prepared.physical).catch(() => false);
  }

  async describeSession(ref: string): Promise<{ sessionId: string; physicalKey: string }> {
    const record = this.catalog.get(ref) ?? (await resolveCatalogSession(ref, this.agentDir));
    if (!record) throw new Error('Pi session reference is not in the main-owned catalog');
    return { sessionId: record.sessionId, physicalKey: record.physical.key };
  }

  async listSessions(scope: 'cwd' | 'all'): Promise<SessionSummary[]> {
    const result = await loadCatalog(this.agentDir, scope === 'cwd' ? this.host.cwd : null);
    this.catalog.clear();
    for (const record of result.records) this.catalog.set(record.summary.id, record);
    for (const message of result.diagnostics.slice(0, 20)) this.sink.diagnostic(message);
    return result.records.map((record) => record.summary);
  }

  exportHtml(path?: string): Promise<string> {
    return this.session.exportToHtml(path);
  }

  async exportJsonl(path: string, sessionId?: string): Promise<string> {
    let source = this.session.sessionFile;
    if (sessionId) {
      const record =
        this.catalog.get(sessionId) ?? (await resolveCatalogSession(sessionId, this.agentDir));
      if (!record) throw new Error('Inactive export requires a native catalog record');
      source = record.path;
    }
    if (!source) throw new Error('This session has not been saved yet');
    await copyFile(source, path);
    return path;
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

const MAX_SESSION_CATALOG_ENTRIES = 500;

function boundedNullable(value: string | undefined, limit: number): string | null {
  if (!value) return null;
  const bounded = boundedMetadata(value, limit);
  return bounded || null;
}

function resourceDescription(value: string): string | null {
  const description = boundedMetadata(value, RESOURCE_LIMITS.descriptionCharacters);
  return description || null;
}

/** Pi permits YAML-folded descriptions that retain a trailing newline. */
function boundedMetadata(value: string, limit: number): string {
  return [...value.normalize('NFC')]
    .map((character) => (/\p{Cc}|\p{Cf}|\p{Cs}/u.test(character) ? ' ' : character))
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

interface CatalogRecord {
  summary: SessionSummary;
  path: string;
  sessionId: string;
  physical: PhysicalFile;
}

function catalogId(physical: PhysicalFile): string {
  return `pi-${createHash('sha256').update(`${physical.key}\0${physical.path}`).digest('hex').slice(0, 32)}`;
}

export async function loadCatalog(
  agentDir: string,
  cwd: string | null,
): Promise<{ records: CatalogRecord[]; diagnostics: string[] }> {
  const listed = await boundedSessionList(join(agentDir, 'sessions'));
  const diagnostics = [...listed.diagnostics];
  const candidates: CatalogRecord[] = [];
  const pathIds = new Map<string, string>();
  for (const { info, physical } of listed.sessions) {
    try {
      if (cwd !== null && info.cwd !== cwd) continue;
      if (typeof info.id !== 'string') throw new Error('invalid session id');
      assertValidImportedSessionId(info.id);
      const createdAt = info.created instanceof Date ? info.created.getTime() : Number.NaN;
      const modifiedAt = info.modified instanceof Date ? info.modified.getTime() : Number.NaN;
      if (
        !Number.isFinite(createdAt) ||
        createdAt < 0 ||
        !Number.isFinite(modifiedAt) ||
        modifiedAt < 0
      ) {
        throw new Error('invalid session date');
      }
      const id = catalogId(physical);
      pathIds.set(resolve(info.path), id);
      candidates.push({
        path: physical.path,
        sessionId: info.id,
        physical,
        summary: {
          id,
          source: 'native',
          runtime: 'pi',
          sessionId: info.id,
          exportable: true,
          name: boundedNullable(typeof info.name === 'string' ? info.name : undefined, 160),
          firstMessage: boundedNullable(
            typeof info.firstMessage === 'string' ? info.firstMessage : undefined,
            500,
          ),
          cwd: boundedNullable(typeof info.cwd === 'string' ? info.cwd : undefined, 4_096),
          createdAt,
          modifiedAt,
          messageCount:
            typeof info.messageCount === 'number' && Number.isFinite(info.messageCount)
              ? Math.max(0, Math.min(Math.trunc(info.messageCount), 1_000_000))
              : 0,
          parentSessionId: null,
        },
      });
    } catch (error) {
      diagnostics.push(`Dropped malformed session record: ${(error as Error).message}`);
    }
  }

  // Conflicting logical IDs are non-selectable. Physical duplicates are also dropped.
  const idCounts = new Map<string, number>();
  const physicalCounts = new Map<string, number>();
  for (const record of candidates) {
    idCounts.set(record.sessionId, (idCounts.get(record.sessionId) ?? 0) + 1);
    physicalCounts.set(record.physical.key, (physicalCounts.get(record.physical.key) ?? 0) + 1);
  }
  const records = candidates
    .filter((record) => {
      const unique =
        idCounts.get(record.sessionId) === 1 && physicalCounts.get(record.physical.key) === 1;
      if (!unique) diagnostics.push(`Dropped conflicting session identity: ${record.sessionId}`);
      return unique;
    })
    .map((record) => {
      const source = listed.sessions.find(({ physical }) => physical.path === record.path)?.info;
      return {
        ...record,
        summary: {
          ...record.summary,
          parentSessionId:
            source?.parentSessionPath && typeof source.parentSessionPath === 'string'
              ? (pathIds.get(resolve(source.parentSessionPath)) ?? null)
              : null,
        },
      };
    })
    .sort((left, right) => right.summary.modifiedAt - left.summary.modifiedAt)
    .slice(0, MAX_SESSION_CATALOG_ENTRIES);
  return { records, diagnostics };
}

async function assertLogicalSessionIdAvailable(agentDir: string, sessionId: string): Promise<void> {
  const listed = await boundedSessionList(join(agentDir, 'sessions'));
  if (
    listed.sessions.some(({ info }) => {
      if (typeof info.id !== 'string') return false;
      try {
        assertValidImportedSessionId(info.id);
        return info.id === sessionId;
      } catch {
        return false;
      }
    })
  ) {
    throw new Error('A session with this identity already exists; portable re-import is refused');
  }
}

function assertValidImportedSessionId(id: string): void {
  if (id.length > 128) throw new Error('Imported session identity is invalid');
  try {
    // Pi 0.84.2 declares assertValidSessionId but omits it from the package-root
    // exports. The public in-memory factory invokes that exact validator for an
    // explicit ID, without filesystem access or a forbidden deep import.
    SessionManager.inMemory('/', { id });
  } catch {
    throw new Error('Imported session identity is invalid');
  }
}

async function resolveCatalogSession(ref: string, agentDir: string): Promise<CatalogRecord | null> {
  if (!/^pi-[a-f0-9]{32}$/.test(ref)) return null;
  const catalog = await loadCatalog(agentDir, null);
  return catalog.records.find((record) => record.summary.id === ref) ?? null;
}

async function openSession(ref: string, cwd: string, agentDir: string): Promise<SessionManager> {
  // Legacy paths can enter only through main-owned persisted settings. Renderer
  // IPC cannot carry a path-shaped session reference.
  if (isAbsolute(ref)) {
    const physical = await inspectPhysicalFile(ref);
    return SessionManager.open(physical.path, dirname(physical.path), cwd);
  }
  const catalog = await loadCatalog(agentDir, null);
  const record = catalog.records.find(
    (candidate) => candidate.summary.id === ref || candidate.sessionId === ref,
  );
  if (!record) throw new Error('Pi session reference is not in the main-owned catalog');
  return SessionManager.open(record.path, dirname(record.path), record.summary.cwd ?? cwd);
}

/** Pi accepts a host-selected session directory through its public SDK. */
function sessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
  return join(resolve(agentDir), 'sessions', safePath);
}

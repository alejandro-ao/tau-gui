import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
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
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
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
  assertArtifactCapacity,
  boundedSessionList,
  checkedExistingDirectory,
  ensureCheckedDirectory,
  exclusiveCopy,
  inspectPhysicalFile,
  markRetainedArtifact,
  retainPhysicalFile,
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
  private activeSessionBinding: {
    path: string;
    sessionId: string;
    physicalKey: string | null;
  } | null = null;
  private sink: RuntimeSink;
  private readonly agentDir: string;
  private readonly home: string;
  private readonly spawnSession: SpawnSessionHandler | null;
  private readonly importDestinationName: () => string;
  private readonly exportAfterCreate?: (destination: string) => void | Promise<void>;
  private readonly catalog = new Map<
    string,
    { path: string; sessionId: string; physical: PhysicalFile }
  >();
  private catalogComplete = false;
  private preparedImport: {
    source: string;
    destination: string;
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
      /** Test seam for source/destination races after exclusive creation. */
      exportAfterCreate?: (destination: string) => void | Promise<void>;
    } = {},
  ) {
    this.sink = sink;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.home = options.home ?? homedir();
    this.spawnSession = options.spawnSession ?? null;
    this.importDestinationName = options.importDestinationName ?? (() => `${randomUUID()}.jsonl`);
    this.exportAfterCreate = options.exportAfterCreate;
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
    runtime.setRebindSession((session) => this.bindSession(session));
    await this.bindSession(runtime.session);
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
    this.activeSessionBinding = null;
    await this.discardPreparedImport();
    if (runtime) await runtime.dispose();
    this.sink.status('stopped');
  }

  private async bindSession(session: AgentSession): Promise<void> {
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
    const path = session.sessionFile;
    if (!path) {
      this.activeSessionBinding = null;
      return;
    }
    let physicalKey: string | null;
    try {
      physicalKey = (await inspectPhysicalFile(path)).key;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A newly-created empty Pi session has a reserved path before its first
      // persisted turn. Its first export binds the inode created there.
      physicalKey = null;
    }
    this.activeSessionBinding = { path, sessionId: session.sessionId, physicalKey };
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
    const record = await resolveCatalogSession(ref, this.agentDir);
    if (!record) throw new Error('Pi session reference is not in the main-owned catalog');
    await this.host.switchSession(record.path);
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
    const catalog = await loadCatalog(this.agentDir, null);
    if (!catalog.complete) throw incompleteCatalogError();
    if (catalog.records.length >= MAX_SESSION_CATALOG_ENTRIES) {
      throw new Error('Session catalog capacity reached; clone refused');
    }
    const session = this.session;
    if (session.isStreaming) throw new Error('Wait for the current response before cloning');
    const manager = session.sessionManager;
    const leafId = manager.getLeafId();
    if (!leafId || !session.sessionFile) {
      throw new Error('Send a message before cloning this session');
    }
    const sessionDir = await ensureCheckedDirectory(manager.getSessionDir());
    if (
      this.session !== session ||
      this.session.sessionManager !== manager ||
      session.isStreaming
    ) {
      throw new Error('Active session changed before clone creation');
    }
    // Pi documents this instance operation as extracting the selected path from
    // the manager's live tree. Never reopen the active path: a same-user swap
    // could substitute different bytes and opening can migrate or initialize it.
    const destination = this.session.sessionManager.createBranchedSession(leafId);
    if (!destination) throw new Error('Failed to create cloned session');
    const artifact = await inspectPhysicalFile(destination, sessionDir);
    try {
      const result = await this.host.switchSession(destination);
      if (result.cancelled) throw new Error('Session clone was cancelled');
    } catch (error) {
      await retainPhysicalFile(artifact, (message) => this.sink.diagnostic(message));
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

    const importRoot = await ensureCheckedDirectory(join(this.agentDir, 'imported-sessions'));
    await assertArtifactCapacity(importRoot);
    const destinationName = this.importDestinationName();
    if (!/^[A-Za-z0-9._-]+\.jsonl$/.test(destinationName)) {
      throw new Error('Unsafe import destination name');
    }
    const destination = join(importRoot, destinationName);
    let created: PhysicalFile | null = null;
    let createdUncertain = false;
    try {
      // Pi open can initialize empty files and migrate legacy formats. Give it
      // only the app-owned final inode copied from the validated no-follow
      // source handle; the external file must remain byte-for-byte untouched.
      created = await exclusiveCopy(source.path, destination, {
        expectedSource: source,
        onRetained: (message) => {
          createdUncertain = true;
          this.sink.diagnostic(message);
        },
      });
      const destinationManager = SessionManager.open(destination, importRoot);
      const sessionId = destinationManager.getSessionId();
      assertValidImportedSessionId(sessionId);
      await assertLogicalSessionIdAvailable(this.agentDir, sessionId, destination);
      const finalDestination = await inspectPhysicalFile(destination, importRoot);
      if (finalDestination.key !== created.key) {
        throw new Error('Import destination changed during public SDK validation');
      }
      this.preparedImport = {
        source: resolve(path),
        destination,
        sessionId,
        physical: finalDestination,
      };
      return { sessionId, physicalKey: finalDestination.key };
    } catch (error) {
      if (created) await retainPhysicalFile(created, (message) => this.sink.diagnostic(message));
      if (created || createdUncertain) {
        await markRetainedArtifact(destination).catch(() => undefined);
      }
      throw error;
    }
  }

  async importJsonl(
    path: string,
  ): Promise<{ sessionId: string; physicalKey: string; physicalPath: string }> {
    const prepared = this.preparedImport;
    if (!prepared || prepared.source !== resolve(path)) {
      throw new Error('Import was not safely prepared');
    }
    try {
      const beforeSwitch = await inspectPhysicalFile(
        prepared.destination,
        dirname(prepared.destination),
      );
      if (
        beforeSwitch.key !== prepared.physical.key ||
        beforeSwitch.size !== prepared.physical.size ||
        beforeSwitch.mtimeNs !== prepared.physical.mtimeNs ||
        beforeSwitch.ctimeNs !== prepared.physical.ctimeNs
      ) {
        throw new Error('Prepared import changed before activation');
      }
      const result = await this.host.switchSession(prepared.destination);
      if (result.cancelled) throw new Error('Session import was cancelled');
      this.preparedImport = null;
      return {
        sessionId: prepared.sessionId,
        physicalKey: prepared.physical.key,
        physicalPath: prepared.physical.path,
      };
    } catch (error) {
      await retainPhysicalFile(prepared.physical, (message) => this.sink.diagnostic(message));
      await markRetainedArtifact(prepared.destination).catch(() => undefined);
      this.preparedImport = null;
      throw error;
    }
  }

  async discardPreparedImport(): Promise<void> {
    const prepared = this.preparedImport;
    this.preparedImport = null;
    if (!prepared) return;
    await retainPhysicalFile(prepared.physical, (message) => this.sink.diagnostic(message));
    await markRetainedArtifact(prepared.destination).catch(() => undefined);
  }

  async describeSession(ref: string): Promise<{ sessionId: string; physicalKey: string }> {
    const record = await resolveCatalogSession(ref, this.agentDir);
    if (!record) throw new Error('Pi session reference is not in the main-owned catalog');
    return { sessionId: record.sessionId, physicalKey: record.physical.key };
  }

  async listSessions(scope: 'cwd' | 'all'): Promise<SessionSummary[]> {
    const result = await loadCatalog(this.agentDir, scope === 'cwd' ? this.host.cwd : null);
    for (const message of result.diagnostics.slice(0, 20)) this.sink.diagnostic(message);
    return result.records.map((record) => record.summary);
  }

  async exportHtml(path?: string): Promise<string> {
    try {
      return await this.session.exportToHtml(path);
    } catch {
      throw new Error('HTML export failed safely');
    }
  }

  async exportJsonl(path: string, sessionId?: string): Promise<string> {
    let source: { path: string; physical: PhysicalFile; sessionId: string };
    if (sessionId) {
      const catalog = await loadCatalog(this.agentDir, null);
      if (!catalog.complete) throw incompleteCatalogError();
      const record = catalog.records.find((candidate) => candidate.summary.id === sessionId);
      if (!record) throw new Error('Inactive export requires a fresh native catalog record');
      source = { path: record.path, physical: record.physical, sessionId: record.sessionId };
    } else {
      // Active legacy settings may legitimately point outside catalog roots.
      // Bind the main-only live path directly to a fresh no-follow identity and
      // the session object's authoritative logical ID.
      const activePath = this.session.sessionFile;
      const activeSessionId = this.session.sessionId;
      if (!activePath) throw new Error('This session has not been saved yet');
      assertValidImportedSessionId(activeSessionId);
      const binding = this.activeSessionBinding;
      const physical = await inspectPhysicalFile(activePath);
      if (
        !binding ||
        binding.path !== activePath ||
        binding.sessionId !== activeSessionId ||
        (binding.physicalKey !== null && binding.physicalKey !== physical.key) ||
        this.session.sessionFile !== activePath ||
        this.session.sessionId !== activeSessionId
      ) {
        throw new Error('Active export source changed during binding');
      }
      if (binding.physicalKey === null) binding.physicalKey = physical.key;
      source = { path: activePath, physical, sessionId: activeSessionId };
    }

    const parent = await checkedExistingDirectory(dirname(resolve(path)));
    const destination = join(parent, basename(path));
    await exclusiveCopy(source.path, destination, {
      expectedSource: source.physical,
      afterCreate: this.exportAfterCreate,
      onRetained: (message) => this.sink.diagnostic(message),
    });
    if (
      !sessionId &&
      (this.session.sessionFile !== source.path || this.session.sessionId !== source.sessionId)
    ) {
      throw new Error('Active export source changed during copy');
    }
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
  // JSON's array encoding is canonical for these ordered primitive fields and
  // cannot introduce delimiter ambiguity. The token binds the renderer's
  // selection to the complete physical generation observed by this catalog.
  const generation = JSON.stringify([
    physical.path,
    physical.key,
    physical.size,
    physical.mtimeNs,
    physical.ctimeNs,
  ]);
  return `pi-${createHash('sha256').update(generation, 'utf8').digest('hex').slice(0, 32)}`;
}

export async function loadCatalog(
  agentDir: string,
  cwd: string | null,
  excludedPath?: string,
): Promise<{ records: CatalogRecord[]; diagnostics: string[]; complete: boolean }> {
  let nativeRoot: string;
  let importedRoot: string;
  try {
    [nativeRoot, importedRoot] = await Promise.all([
      ensureCheckedDirectory(join(agentDir, 'sessions')),
      ensureCheckedDirectory(join(agentDir, 'imported-sessions')),
    ]);
  } catch {
    return {
      records: [],
      diagnostics: ['Session catalog roots are unavailable or unsafe'],
      complete: false,
    };
  }
  const [native, imported] = await Promise.all([
    boundedSessionList(join(agentDir, 'sessions')),
    boundedSessionList(importedRoot),
  ]);
  const listed = {
    sessions: [...native.sessions, ...imported.sessions],
    diagnostics: [...native.diagnostics, ...imported.diagnostics],
    complete: native.complete && imported.complete,
  };
  const diagnostics = [...listed.diagnostics];
  let complete = listed.complete;
  const candidates: CatalogRecord[] = [];
  const pathIds = new Map<string, string>();
  for (const { info, physical } of listed.sessions) {
    try {
      if (excludedPath && resolve(physical.path) === resolve(excludedPath)) continue;
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
    } catch {
      complete = false;
      diagnostics.push('Dropped malformed session record: metadata is invalid');
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
      if (!unique) {
        complete = false;
        diagnostics.push('Dropped conflicting session identity');
      }
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
    .sort((left, right) => right.summary.modifiedAt - left.summary.modifiedAt);
  if (records.length > MAX_SESSION_CATALOG_ENTRIES) {
    complete = false;
    diagnostics.push('Session catalog record budget exceeded; remaining records omitted');
    records.length = MAX_SESSION_CATALOG_ENTRIES;
  }
  return { records, diagnostics, complete };
}

async function assertLogicalSessionIdAvailable(
  agentDir: string,
  sessionId: string,
  candidatePath?: string,
): Promise<void> {
  const catalog = await loadCatalog(agentDir, null, candidatePath);
  if (!catalog.complete) throw incompleteCatalogError();
  if (catalog.records.some((record) => record.sessionId === sessionId)) {
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

function incompleteCatalogError(): Error {
  return new Error('Session catalog is incomplete; identity-sensitive operation refused');
}

async function resolveCatalogSession(ref: string, agentDir: string): Promise<CatalogRecord | null> {
  if (!/^pi-[a-f0-9]{32}$/.test(ref)) return null;
  const catalog = await loadCatalog(agentDir, null);
  if (!catalog.complete) throw incompleteCatalogError();
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
  if (!catalog.complete) throw incompleteCatalogError();
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

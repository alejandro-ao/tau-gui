import type { ContextFile } from '../../shared/ipc.js';
import type {
  ResourceReloadResult,
  SystemPromptInspection,
  ToolCatalog,
} from '../../shared/introspection.js';
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  BashResult,
  CommandInfo,
  CompactionResult,
  EntrySnapshot,
  Model,
  ModelCycleResult,
  ModelRef,
  AuthFlowEvent,
  PiAgentPreferences,
  PiAgentPreferencesPatch,
  ProviderAuthMethod,
  ProviderAuthStatus,
  PromptInput,
  RuntimeCapabilities,
  RuntimeKind,
  RuntimeLaunchConfig,
  RuntimeStatus,
  ResourceCatalog,
  SessionStats,
  SessionSummary,
  ThinkingLevel,
  TreeSnapshot,
} from '../../shared/domain.js';
export interface RuntimeAgentState extends AgentState {
  /** Main-process-only durable identity; never copy into renderer DTOs. */
  sessionFile: string | null;
}

export interface RuntimeSink {
  event(event: AgentEvent): void;
  status(status: RuntimeStatus, detail?: string | null): void;
  diagnostic(line: string): void;
  auth?(event: AuthFlowEvent): void;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  start(config: RuntimeLaunchConfig): Promise<void>;
  stop(): Promise<void>;
  prompt(input: PromptInput): Promise<void>;
  steer(input: PromptInput): Promise<void>;
  followUp(input: PromptInput): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<RuntimeAgentState>;
  getMessages(): Promise<AgentMessage[]>;
  getEntries(cursor?: string): Promise<EntrySnapshot>;
  getTree(): Promise<TreeSnapshot>;
  getStats(): Promise<SessionStats>;
  listModels(): Promise<Model[]>;
  setModel(ref: ModelRef): Promise<Model | null>;
  cycleModel(): Promise<ModelCycleResult | null>;
  listThinkingLevels(): Promise<ThinkingLevel[]>;
  setThinking(level: ThinkingLevel): Promise<void>;
  cycleThinking(): Promise<ThinkingLevel | null>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  compact(instructions?: string): Promise<CompactionResult>;
  listProviderAuth?(): Promise<ProviderAuthStatus[]>;
  loginProvider?(providerId: string, method: ProviderAuthMethod): Promise<void>;
  respondProviderAuth?(flowId: string, challengeId: string, value: string): Promise<void>;
  cancelProviderAuth?(flowId: string): Promise<void>;
  logoutProvider?(providerId: string): Promise<void>;
  getPiPreferences?(): Promise<PiAgentPreferences>;
  updatePiPreferences?(patch: PiAgentPreferencesPatch): Promise<PiAgentPreferences>;
  abortRetry?(): Promise<void>;
  runShell(command: string, excludeFromContext: boolean): Promise<BashResult>;
  abortShell(): Promise<void>;
  newSession(): Promise<void>;
  switchSession(ref: string): Promise<void>;
  nameSession(name: string): Promise<void>;
  fork(
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
  }>;
  setLabel(entryId: string, label: string | null): Promise<void>;
  clone(): Promise<void>;
  prepareImport?(path: string): Promise<{ sessionId: string; physicalKey: string }>;
  importJsonl(
    path: string,
  ): Promise<void | { sessionId: string; physicalKey: string; physicalPath: string }>;
  discardPreparedImport?(): Promise<void>;
  describeSession?(ref: string): Promise<{ sessionId: string; physicalKey: string }>;
  listSessions(scope: 'cwd' | 'all'): Promise<SessionSummary[]>;
  exportHtml(path?: string): Promise<string>;
  exportJsonl(path: string, sessionId?: string): Promise<string>;
  listCommands(): Promise<CommandInfo[]>;
  /** Direct SDK runtimes can expose authoritative resource metadata. */
  getResources?(): Promise<ResourceCatalog>;
  getContextFiles?(): Promise<ContextFile[]>;
  /** Local-only inspection; callers must never append this result to session messages. */
  inspectSystemPrompt?(): Promise<SystemPromptInspection>;
  listTools?(): Promise<ToolCatalog>;
  reloadResources?(): Promise<ResourceReloadResult>;
}

/**
 * Runtime operations required by each capability at the application-domain
 * boundary. A null entry means the current AgentRuntime contract has no such
 * operation, so no production adapter may advertise that capability yet.
 * Renderer and IPC coverage remain additional requirements.
 */
export const CAPABILITY_RUNTIME_METHODS = {
  textPrompt: ['prompt'],
  imagePrompt: ['prompt', 'steer', 'followUp'],
  steering: ['steer'],
  followUps: ['followUp'],
  directBash: ['runShell'],
  abortBash: ['abortShell'],
  retryControls: ['getPiPreferences', 'updatePiPreferences', 'abortRetry'],
  sessionTree: ['getTree', 'fork', 'setLabel'],
  sessionClone: ['clone'],
  sessionList: ['listSessions'],
  extensionDialogs: null,
  providerLogin: [
    'listProviderAuth',
    'loginProvider',
    'respondProviderAuth',
    'cancelProviderAuth',
    'logoutProvider',
  ],
  resourceReload: ['reloadResources'],
  systemPromptInspection: ['inspectSystemPrompt'],
  toolCatalog: ['listTools'],
} as const satisfies Record<keyof RuntimeCapabilities, readonly (keyof AgentRuntime)[] | null>;

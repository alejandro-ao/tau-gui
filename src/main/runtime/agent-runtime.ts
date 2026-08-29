import type { ContextFile } from '../../shared/ipc.js';
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
  PromptInput,
  RuntimeCapabilities,
  RuntimeKind,
  RuntimeLaunchConfig,
  RuntimeStatus,
  ResourceCatalog,
  SessionStats,
  ThinkingLevel,
  TreeSnapshot,
} from '../../shared/domain.js';

export interface RuntimeSink {
  event(event: AgentEvent): void;
  status(status: RuntimeStatus, detail?: string | null): void;
  diagnostic(line: string): void;
}

/** Application-domain boundary implemented by embedded Pi and injected fake Pi tests. */
export interface AgentRuntime {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  start(config: RuntimeLaunchConfig): Promise<void>;
  stop(): Promise<void>;
  prompt(input: PromptInput): Promise<void>;
  steer(input: PromptInput): Promise<void>;
  followUp(input: PromptInput): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<AgentState>;
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
  runShell(command: string, excludeFromContext: boolean): Promise<BashResult>;
  abortShell(): Promise<void>;
  newSession(): Promise<void>;
  switchSession(ref: string): Promise<void>;
  nameSession(name: string): Promise<void>;
  fork(entryId: string): Promise<string>;
  exportHtml(path?: string): Promise<string>;
  listCommands(): Promise<CommandInfo[]>;
  getResources?(): Promise<ResourceCatalog>;
  getContextFiles?(): Promise<ContextFile[]>;
}

export const CAPABILITY_RUNTIME_METHODS = {
  textPrompt: ['prompt'],
  imagePrompt: null,
  steering: ['steer'],
  followUps: ['followUp'],
  directBash: ['runShell'],
  abortBash: ['abortShell'],
  retryControls: null,
  sessionTree: ['getTree', 'fork'],
  sessionClone: null,
  sessionList: null,
  extensionDialogs: null,
  providerLogin: null,
  resourceReload: null,
  systemPromptInspection: null,
  toolCatalog: null,
} as const satisfies Record<keyof RuntimeCapabilities, readonly (keyof AgentRuntime)[] | null>;

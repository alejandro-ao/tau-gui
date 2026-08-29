/**
 * Application-domain types.
 *
 * Pi SDK values and injected fake-Pi values are normalized into these shapes
 * by the main-process application-domain adapter. The renderer only
 * ever sees the types declared in this file.
 */

export type RuntimeKind = 'tau' | 'pi';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export type ProjectTrust = 'default' | 'approve-once' | 'decline-once';

/** Optional protocol surfaces. Unsupported actions must be disabled, never faked. */
export interface RuntimeCapabilities {
  textPrompt: boolean;
  imagePrompt: boolean;
  steering: boolean;
  followUps: boolean;
  directBash: boolean;
  abortBash: boolean;
  retryControls: boolean;
  sessionTree: boolean;
  sessionClone: boolean;
  sessionList: boolean;
  extensionDialogs: boolean;
  providerLogin: boolean;
  resourceReload: boolean;
  systemPromptInspection: boolean;
  toolCatalog: boolean;
}

export interface RuntimeLaunchConfig {
  cwd: string;
  sessionRef?: string | null;
  projectTrust: ProjectTrust;
  /** User-selected resource directories, passed directly to Pi's loader. */
  customSkillDirectories?: string[];
  customPromptDirectories?: string[];
}

/* ------------------------------------------------------------------ models */

export interface ModelCost {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Model {
  id: string;
  name: string;
  provider: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  cost: ModelCost;
}

export interface ModelRef {
  provider: string;
  modelId: string;
}

export interface ModelCycleResult {
  model: Model;
  thinkingLevel: ThinkingLevel;
  isScoped: boolean;
}

/* ---------------------------------------------------- auth and Pi preferences */

export type ProviderAuthMethod = 'api_key' | 'oauth';

/** Sanitized provider metadata. Credentials and tokens never enter this DTO. */
export interface ProviderAuthStatus {
  id: string;
  name: string;
  methods: ProviderAuthMethod[];
  configured: boolean;
  credentialType: ProviderAuthMethod | null;
  source: string | null;
}

export type AuthFlowEvent =
  | {
      flowId: string;
      type: 'prompt';
      challengeId: string;
      input: 'text' | 'secret' | 'select' | 'manual_code';
      message: string;
      placeholder: string | null;
      options: { id: string; label: string; description: string | null }[];
    }
  | {
      flowId: string;
      type: 'info' | 'progress';
      message: string;
      links: { url: string; label: string | null }[];
    }
  | {
      flowId: string;
      type: 'auth_url';
      url: string;
      instructions: string | null;
    }
  | {
      flowId: string;
      type: 'device_code';
      userCode: string;
      verificationUri: string;
      intervalSeconds: number | null;
      expiresInSeconds: number | null;
    }
  | { flowId: string; type: 'complete'; success: boolean; message: string };

export interface PiAgentPreferences {
  steeringMode: 'all' | 'one-at-a-time';
  followUpMode: 'all' | 'one-at-a-time';
  transport: 'sse' | 'websocket' | 'websocket-cached' | 'auto';
  retryEnabled: boolean;
  retryMaxRetries: number;
  retryBaseDelayMs: number;
  providerTimeoutMs: number | null;
  providerMaxRetries: number;
  providerMaxRetryDelayMs: number;
  isRetrying: boolean;
  retryAttempt: number;
  autoCompactionEnabled: boolean;
  compactionReserveTokens: number;
  compactionKeepRecentTokens: number;
  defaultProvider: string | null;
  defaultModel: string | null;
  defaultThinkingLevel: ThinkingLevel | null;
  /** Pi exposes public setters for these fields in this pinned SDK version. */
  writable: {
    queueModes: boolean;
    transport: boolean;
    retryEnabled: boolean;
    retryPolicy: boolean;
    autoCompaction: boolean;
    compactionThresholds: boolean;
    modelDefaults: boolean;
  };
}

export interface PiAgentPreferencesPatch {
  steeringMode?: 'all' | 'one-at-a-time';
  followUpMode?: 'all' | 'one-at-a-time';
  transport?: 'sse' | 'websocket' | 'websocket-cached' | 'auto';
  retryEnabled?: boolean;
  autoCompactionEnabled?: boolean;
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: ThinkingLevel;
}

/* ---------------------------------------------------------------- messages */

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
  totalTokens: number;
  cost: number | null;
}

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted';

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type MessageRole =
  | 'user'
  | 'assistant'
  | 'toolResult'
  | 'bashExecution'
  | 'custom'
  | 'branchSummary'
  | 'compactionSummary';

export interface UserMessage {
  role: 'user';
  text: string;
  images: { mimeType: string; data: string }[];
  timestamp: number;
}

export interface AssistantMessage {
  role: 'assistant';
  text: string;
  thinking: string;
  toolCalls: ToolCall[];
  provider: string;
  model: string;
  usage: Usage | null;
  stopReason: StopReason | null;
  errorMessage: string | null;
  timestamp: number;
}

export interface ToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  text: string;
  details: Record<string, unknown>;
  isError: boolean;
  timestamp: number;
}

export interface BashExecutionMessage {
  role: 'bashExecution';
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
  excludeFromContext: boolean;
  timestamp: number;
}

export interface CustomMessage {
  role: 'custom';
  customType: string;
  text: string;
  display: boolean;
  details: Record<string, unknown>;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: 'branchSummary';
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;

/* ------------------------------------------------------------------ events */

export type AgentEvent =
  | { type: 'agent_start' }
  | { type: 'turn_start' }
  | { type: 'message_start'; message: AgentMessage }
  | {
      type: 'message_delta';
      kind: 'text' | 'thinking';
      delta: string;
      message: AssistantMessage;
    }
  | { type: 'message_end'; message: AgentMessage }
  | { type: 'tool_start'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | {
      type: 'tool_update';
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      partialText: string;
    }
  | {
      type: 'tool_end';
      toolCallId: string;
      toolName: string;
      text: string;
      details: Record<string, unknown>;
      isError: boolean;
    }
  | { type: 'turn_end' }
  | { type: 'agent_end'; willRetry: boolean }
  | { type: 'agent_settled' }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'compaction_start'; reason: 'manual' | 'threshold' | 'overflow' }
  | {
      type: 'compaction_end';
      reason: 'manual' | 'threshold' | 'overflow';
      aborted: boolean;
      willRetry: boolean;
      errorMessage: string | null;
    }
  | { type: 'retry_start'; attempt: number; maxAttempts: number; delayMs: number; message: string }
  | { type: 'retry_end'; success: boolean; attempt: number; finalError: string | null }
  // Process-level status is not an agent event: it travels as a `status`
  // bridge event carrying the whole runtime snapshot.
  | { type: 'runtime_error'; message: string };

export type RuntimeStatus =
  | 'stopped'
  | 'starting'
  | 'idle'
  | 'running'
  | 'compacting'
  | 'retrying'
  | 'failed'
  | 'disconnected';

/* ------------------------------------------------------------------- state */

export interface AgentState {
  model: Model | null;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  /** Whether the runtime has durable backing; its private file path stays in main. */
  persisted: boolean;
  sessionId: string;
  sessionName: string | null;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStats {
  persisted: boolean;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number | null;
  contextUsage: {
    tokens: number;
    contextWindow: number;
    percent: number;
  };
}

/* ----------------------------------------------------------------- entries */

export interface SessionEntry {
  id: string;
  parentId: string | null;
  timestamp: string;
  kind:
    | 'message'
    | 'custom_message'
    | 'model_change'
    | 'thinking_level_change'
    | 'compaction'
    | 'branch_summary'
    | 'custom'
    | 'label'
    | 'session_info';
  /** Present for message-bearing entries. */
  message?: AgentMessage;
  /** Short human-readable preview used by the tree browser. */
  summary: string;
  /** Resolved Pi bookmark label, when present. */
  label?: string;
}

export interface EntrySnapshot {
  entries: SessionEntry[];
  leafId: string | null;
}

/** Bounded, presentation-only tree row. Full messages and extension details never cross IPC. */
export interface TreeRow {
  id: string;
  parentId: string | null;
  depth: number;
  kind: SessionEntry['kind'];
  role: MessageRole | null;
  timestamp: string;
  preview: string;
  label: string | null;
}

export interface TreeSnapshot {
  rows: TreeRow[];
  leafId: string | null;
  truncated: boolean;
}

export type TreeSummaryMode = 'none' | 'default' | 'custom';

export interface TreeNavigateOptions {
  summary: TreeSummaryMode;
  customInstructions?: string;
  label?: string;
}

export interface TreeNavigateResult {
  editorText: string | null;
  /** True when a larger editable message was deterministically capped for IPC. */
  editorTextTruncated: boolean;
  cancelled: boolean;
  aborted: boolean;
}

/* ----------------------------------------------------------------- actions */

export interface PromptInput {
  text: string;
  images?: { type: 'image'; data: string; mimeType: string }[];
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string | null;
  tokensBefore: number;
  estimatedTokensAfter: number;
}

export interface BashResult {
  command: string;
  output: string;
  exitCode: number | null;
  cancelled: boolean;
  truncated: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
  source: 'runtime' | 'frontend';
}

/** Metadata only: resource contents stay in the main process/runtime. */
export interface SkillInfo {
  name: string;
  description: string | null;
  origin: string;
  disableModelInvocation: boolean;
  /** Approximate token count derived in main from the complete SKILL.md text. */
  estimatedTokens: number;
}

export interface PromptTemplateInfo {
  name: string;
  description: string | null;
  origin: string;
}

export interface ResourceCatalog {
  skills: SkillInfo[];
  prompts: PromptTemplateInfo[];
  diagnostics: string[];
}

export interface SessionRef {
  id: string;
  name: string | null;
  /** First user message, used as the fallback display label. */
  firstMessage?: string | null;
  /** Persisted so empty sessions can be omitted from recent-session UI. */
  messageCount?: number;
  path: string | null;
  cwd: string | null;
  runtime: RuntimeKind;
  lastSeen: number;
}

/** Bounded Pi-native session metadata. Session file paths never cross IPC. */
export interface SessionSummary {
  /** Opaque main-owned catalog identity used for resume/export and React keys. */
  id: string;
  source: 'native' | 'recent';
  runtime: RuntimeKind;
  /** Runtime transcript identity, used only to correlate activity/current state. */
  sessionId: string;
  /** Only native records can be resolved for inactive portable export. */
  exportable: boolean;
  name: string | null;
  firstMessage: string | null;
  cwd: string | null;
  createdAt: number;
  modifiedAt: number;
  messageCount: number;
  parentSessionId: string | null;
}

/* ---------------------------------------------------------------- settings */

export type SidebarPosition = 'right' | 'left' | 'off';
export type ThemeName = 'tau-dark' | 'tau-light' | 'high-contrast' | 'pure-black';
export type TurnNotification = 'desktop' | 'off';

export interface AppSettings {
  theme: ThemeName;
  sidebarPosition: SidebarPosition;
  turnNotification: TurnNotification;
  showThinking: boolean;
  cwd: string | null;
  /** GUI-managed directories shown in the sessions rail, newest first. */
  workingDirectories: string[];
  /** Additional directories scanned by Pi for executable skill packages. */
  customSkillDirectories: string[];
  /** Additional directories scanned by Pi for Markdown prompt templates. */
  customPromptDirectories: string[];
  projectTrust: ProjectTrust;
  /** App-owned favourite model tuple keys for embedded Pi. */
  scopedModels: string[];
  recentSessions: SessionRef[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'tau-dark',
  sidebarPosition: 'right',
  turnNotification: 'desktop',
  showThinking: true,
  cwd: null,
  workingDirectories: [],
  customSkillDirectories: [],
  customPromptDirectories: [],
  projectTrust: 'default',
  scopedModels: [],
  recentSessions: [],
};

export const DEFAULT_CAPABILITIES: RuntimeCapabilities = {
  textPrompt: true,
  imagePrompt: false,
  steering: false,
  followUps: false,
  directBash: false,
  abortBash: false,
  retryControls: false,
  sessionTree: false,
  sessionClone: false,
  sessionList: false,
  extensionDialogs: false,
  providerLogin: false,
  resourceReload: false,
  systemPromptInspection: false,
  toolCatalog: false,
};

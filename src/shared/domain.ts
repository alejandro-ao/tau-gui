/**
 * Application-domain types.
 *
 * These types are runtime-independent. Tau and Pi wire payloads are normalized
 * into these shapes by runtime adapters in the main process. The renderer only
 * ever sees the types declared in this file.
 */

export type RuntimeKind = 'tau' | 'pi';

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
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
  scopedModels: boolean;
}

export interface RuntimeLaunchConfig {
  kind: RuntimeKind;
  binary: string;
  cwd: string;
  provider?: string | null;
  model?: string | null;
  sessionRef?: string | null;
  extraArgs: string[];
  projectTrust: ProjectTrust;
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
  sessionFile: string | null;
  sessionId: string;
  sessionName: string | null;
  autoCompactionEnabled: boolean;
  messageCount: number;
  pendingMessageCount: number;
}

export interface SessionStats {
  sessionFile: string | null;
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
  /** Short human-readable label used by the tree browser. */
  summary: string;
  raw: Record<string, unknown>;
}

export interface EntrySnapshot {
  entries: SessionEntry[];
  leafId: string | null;
}

export interface TreeNode {
  entry: SessionEntry;
  children: TreeNode[];
}

export interface TreeSnapshot {
  tree: TreeNode[];
  leafId: string | null;
}

/* ----------------------------------------------------------------- actions */

export interface PromptInput {
  text: string;
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

/* ---------------------------------------------------------------- settings */

export type SidebarPosition = 'right' | 'left' | 'off';
export type ThemeName = 'tau-dark' | 'tau-light' | 'high-contrast';
export type TurnNotification = 'desktop' | 'off';

export interface RuntimeSettings {
  binary: string;
  provider: string | null;
  model: string | null;
  extraArgs: string[];
}

export interface AppSettings {
  agentRuntime: RuntimeKind;
  theme: ThemeName;
  sidebarPosition: SidebarPosition;
  turnNotification: TurnNotification;
  showThinking: boolean;
  cwd: string | null;
  projectTrust: ProjectTrust;
  runtime: Record<RuntimeKind, RuntimeSettings>;
  recentSessions: SessionRef[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  agentRuntime: 'tau',
  theme: 'tau-dark',
  sidebarPosition: 'right',
  turnNotification: 'desktop',
  showThinking: true,
  cwd: null,
  projectTrust: 'default',
  runtime: {
    tau: { binary: 'tau', provider: null, model: null, extraArgs: [] },
    pi: { binary: 'pi', provider: null, model: null, extraArgs: [] },
  },
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
  scopedModels: false,
};

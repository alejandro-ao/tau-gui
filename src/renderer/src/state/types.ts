import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  AppSettings,
  CommandInfo,
  Model,
  SessionStats,
  ThinkingLevel,
} from '../../../shared/domain.js';
import type { RuntimeSnapshot } from '../../../shared/ipc.js';

export type ToolState = 'running' | 'success' | 'error';

export interface UserBlock {
  kind: 'user';
  id: string;
  text: string;
  timestamp: number;
}

export interface AssistantBlock {
  kind: 'assistant';
  id: string;
  text: string;
  streaming: boolean;
  aborted: boolean;
  timestamp: number;
}

export interface ThinkingBlock {
  kind: 'thinking';
  id: string;
  text: string;
  streaming: boolean;
  timestamp: number;
}

export interface ToolBlock {
  kind: 'tool';
  id: string;
  toolCallId: string;
  name: string;
  args: Record<string, unknown>;
  output: string;
  state: ToolState;
  startedAt: number;
  endedAt: number | null;
  timestamp: number;
}

export interface ShellBlock {
  kind: 'shell';
  id: string;
  command: string;
  output: string;
  exitCode: number | null;
  excludeFromContext: boolean;
  running: boolean;
  timestamp: number;
}

export interface StatusBlock {
  kind: 'status';
  id: string;
  text: string;
  tone: 'info' | 'warn';
  timestamp: number;
}

export interface ErrorBlock {
  kind: 'error';
  id: string;
  text: string;
  timestamp: number;
}

export interface SummaryBlock {
  kind: 'compaction' | 'branch';
  id: string;
  summary: string;
  detail: string | null;
  timestamp: number;
}

export interface CustomBlock {
  kind: 'custom';
  id: string;
  customType: string;
  text: string;
  timestamp: number;
}

export type TranscriptBlock =
  | UserBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolBlock
  | ShellBlock
  | StatusBlock
  | ErrorBlock
  | SummaryBlock
  | CustomBlock;

export type ModalKind =
  | 'palette'
  | 'model'
  | 'scoped'
  | 'session'
  | 'tree'
  | 'theme'
  | 'thinking'
  | 'hotkeys'
  | 'details'
  | 'settings'
  | 'diagnostics'
  | 'commands';

export interface AppState {
  snapshot: RuntimeSnapshot;
  settings: AppSettings;
  agent: AgentState | null;
  stats: SessionStats | null;
  models: Model[];
  thinkingLevels: ThinkingLevel[];
  commands: CommandInfo[];
  blocks: TranscriptBlock[];
  /** Ids of the provisional assistant/thinking blocks for the active stream. */
  streamingAssistantId: string | null;
  streamingThinkingId: string | null;
  queue: { steering: string[]; followUp: string[] };
  diagnostics: string[];
  expandAll: boolean;
  expanded: Record<string, boolean>;
  /**
   * Composer draft. It lives in the store so it survives modals, session
   * switches, and runtime switches.
   */
  draft: string;
  modal: ModalKind | null;
  windowFocused: boolean;
  busy: boolean;
  lastCompletionPreview: string | null;
  /** Monotonic count of settled turns; keys completion notifications. */
  settledCount: number;
}

export type Action =
  | { type: 'event'; event: AgentEvent; now: number }
  | { type: 'snapshot'; snapshot: RuntimeSnapshot }
  | { type: 'settings'; settings: AppSettings }
  | { type: 'diagnostic'; message: string }
  | { type: 'diagnostics'; messages: string[] }
  | { type: 'stats'; stats: SessionStats }
  | { type: 'models'; models: Model[] }
  | { type: 'thinkingLevels'; levels: ThinkingLevel[] }
  | { type: 'commands'; commands: CommandInfo[] }
  | { type: 'hydrate'; messages: AgentMessage[]; now: number }
  | { type: 'localMessage'; block: TranscriptBlock }
  | { type: 'updateBlock'; id: string; patch: Partial<TranscriptBlock> }
  | { type: 'clearTranscript' }
  | { type: 'toggleExpandAll' }
  | { type: 'toggleExpanded'; id: string }
  | { type: 'draft'; text: string }
  | { type: 'modal'; modal: ModalKind | null }
  | { type: 'focus'; focused: boolean }
  | { type: 'busy'; busy: boolean };

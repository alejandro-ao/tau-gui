import type { AgentEvent, AgentMessage, AppSettings } from '../../../shared/domain.js';
import { DEFAULT_CAPABILITIES, DEFAULT_SETTINGS } from '../../../shared/domain.js';
import type { RuntimeSnapshot } from '../../../shared/ipc.js';
import type { Action, AppState, TranscriptBlock } from './types.js';

export const INITIAL_SNAPSHOT: RuntimeSnapshot = {
  runtime: 'tau',
  status: 'stopped',
  detail: null,
  runtimeVersion: null,
  capabilities: DEFAULT_CAPABILITIES,
  cwd: null,
  gitBranch: null,
  state: null,
};

export const INITIAL_STATE: AppState = {
  snapshot: INITIAL_SNAPSHOT,
  settings: DEFAULT_SETTINGS,
  agent: null,
  stats: null,
  models: [],
  thinkingLevels: [],
  commands: [],
  blocks: [],
  streamingAssistantId: null,
  streamingThinkingId: null,
  queue: { steering: [], followUp: [] },
  diagnostics: [],
  expandAll: false,
  expanded: {},
  draft: '',
  composerFocusRequest: 0,
  modal: null,
  windowFocused: true,
  busy: false,
  sessionTransitioning: false,
  lastCompletionPreview: null,
  settledCount: 0,
  sessionActivity: {},
};

const MAX_DIAGNOSTICS = 300;

let blockCounter = 0;

/** Deterministic block ids keep the reducer replayable in tests. */
export function nextBlockId(prefix: string): string {
  blockCounter += 1;
  return `${prefix}-${blockCounter}`;
}

export function resetBlockIds(): void {
  blockCounter = 0;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'event':
      // IPC delivery can already contain events queued by the previously
      // active process when a session switch completes. Never apply a scoped
      // event unless it belongs to the transcript represented by the latest
      // snapshot. Local reducer replays omit the scope intentionally.
      if (
        action.sessionId !== undefined &&
        (action.sessionId !== state.snapshot.state?.sessionId ||
          action.runtime !== state.snapshot.runtime)
      ) {
        return state;
      }
      return applyEvent(state, action.event, action.now);
    case 'snapshot':
      return { ...state, snapshot: action.snapshot, agent: action.snapshot.state ?? state.agent };
    case 'sessionNavigation':
      if (!action.active) {
        return {
          ...state,
          sessionTransitioning: false,
          snapshot:
            state.snapshot.status === 'starting' && state.snapshot.detail === 'Opening session'
              ? { ...state.snapshot, status: 'idle', detail: null }
              : state.snapshot,
        };
      }
      return {
        ...state,
        sessionTransitioning: true,
        snapshot: {
          ...state.snapshot,
          runtime: action.targetRuntime ?? state.snapshot.runtime,
          status: 'starting',
          detail: 'Opening session',
          state: null,
        },
        agent: null,
        stats: null,
        blocks: [],
        streamingAssistantId: null,
        streamingThinkingId: null,
        queue: { steering: [], followUp: [] },
        expanded: {},
        composerFocusRequest: state.composerFocusRequest + 1,
      };
    case 'settings':
      return { ...state, settings: action.settings };
    case 'sessionActivity': {
      const key = `${action.activity.runtime}:${action.activity.sessionId}`;
      const previous = state.sessionActivity[key];
      return {
        ...state,
        sessionActivity: {
          ...state.sessionActivity,
          [key]: {
            ...action.activity,
            responseReady:
              action.activity.responseReady === null
                ? (previous?.responseReady ?? false)
                : action.activity.responseReady,
          },
        },
      };
    }
    case 'diagnostic':
      return {
        ...state,
        diagnostics: [...state.diagnostics, action.message].slice(-MAX_DIAGNOSTICS),
      };
    case 'diagnostics':
      return { ...state, diagnostics: action.messages.slice(-MAX_DIAGNOSTICS) };
    case 'stats':
      return { ...state, stats: action.stats };
    case 'models':
      return { ...state, models: action.models };
    case 'thinkingLevels':
      return { ...state, thinkingLevels: action.levels };
    case 'commands':
      return { ...state, commands: action.commands };
    case 'hydrate':
      // Authoritative reads are session-scoped too: a response that describes
      // another transcript must never replace the rendered one.
      if (
        action.sessionId !== undefined &&
        (action.sessionId !== state.snapshot.state?.sessionId ||
          action.runtime !== state.snapshot.runtime)
      ) {
        return state;
      }
      return {
        ...state,
        blocks: hydrateBlocks(action.messages, action.now),
        streamingAssistantId: null,
        streamingThinkingId: null,
      };
    case 'localMessage':
      return { ...state, blocks: [...state.blocks, action.block] };
    case 'updateBlock':
      return {
        ...state,
        blocks: state.blocks.map((block) =>
          block.id === action.id ? ({ ...block, ...action.patch } as TranscriptBlock) : block,
        ),
      };
    case 'clearTranscript':
      return {
        ...state,
        blocks: [],
        streamingAssistantId: null,
        streamingThinkingId: null,
        queue: { steering: [], followUp: [] },
        expanded: {},
        composerFocusRequest: state.composerFocusRequest + 1,
      };
    case 'toggleExpandAll':
      return { ...state, expandAll: !state.expandAll, expanded: {} };
    case 'toggleExpanded':
      return {
        ...state,
        expanded: { ...state.expanded, [action.id]: !isExpanded(state, action.id) },
      };
    case 'draft':
      return { ...state, draft: action.text };
    case 'modal':
      return { ...state, modal: action.modal };
    case 'focus':
      return { ...state, windowFocused: action.focused };
    case 'busy':
      return { ...state, busy: action.busy };
  }
}

export function isExpanded(state: AppState, id: string): boolean {
  const override = state.expanded[id];
  return override === undefined ? state.expandAll : override;
}

function applyEvent(state: AppState, event: AgentEvent, now: number): AppState {
  switch (event.type) {
    case 'agent_start':
      return { ...state, streamingAssistantId: null, streamingThinkingId: null };

    case 'message_start': {
      // Assistant text is assembled from deltas, and tool results are already
      // represented by their tool block.
      if (event.message.role === 'assistant' || event.message.role === 'toolResult') return state;
      return { ...state, blocks: [...state.blocks, ...blocksFromMessage(event.message, now)] };
    }

    case 'message_delta': {
      let next = state;
      if (event.message.thinking) {
        next = upsertStreamBlock(next, 'thinking', event.message.thinking, now);
      }
      if (event.message.text) {
        next = upsertStreamBlock(next, 'assistant', event.message.text, now);
      }
      return next;
    }

    case 'message_end': {
      const message = event.message;
      if (message.role !== 'assistant') {
        // Tool results arrive as messages too; the tool block already covers them.
        if (message.role === 'toolResult') return state;
        // Runtimes emit message_start and message_end for durable non-assistant
        // messages. The end payload is authoritative, so replace rather than
        // append when the provisional block is already the last one rendered.
        const rendered = blocksFromMessage(message, now);
        const previous = state.blocks.at(-1);
        const replacement = rendered[0];
        if (previous && replacement && sameBlockIdentity(previous, replacement)) {
          return {
            ...state,
            blocks: [
              ...state.blocks.slice(0, -1),
              ...rendered.map((block, index) =>
                index === 0 ? { ...block, id: previous.id } : block,
              ),
            ],
          };
        }
        return { ...state, blocks: [...state.blocks, ...rendered] };
      }
      // `message_end.message` is authoritative and replaces provisional state.
      // The replacement is spliced in at the position of the first provisional
      // block so anything appended mid-stream (tool blocks, retry/compaction
      // status, errors, steering echoes) keeps its relative order.
      const provisional = new Set(
        [state.streamingThinkingId, state.streamingAssistantId].filter(
          (id): id is string => id !== null,
        ),
      );
      const rendered = blocksFromMessage(message, now);
      const firstIndex = state.blocks.findIndex((block) => provisional.has(block.id));
      const kept = state.blocks.filter((block) => !provisional.has(block.id));
      const at =
        firstIndex === -1 ? kept.length : countKeptBefore(state.blocks, provisional, firstIndex);
      return {
        ...state,
        blocks: [...kept.slice(0, at), ...rendered, ...kept.slice(at)],
        streamingAssistantId: null,
        streamingThinkingId: null,
      };
    }

    case 'tool_start':
      return {
        ...state,
        blocks: [
          ...state.blocks,
          {
            kind: 'tool',
            id: nextBlockId('tool'),
            toolCallId: event.toolCallId,
            name: event.toolName,
            args: event.args,
            output: '',
            state: 'running',
            startedAt: now,
            endedAt: null,
            timestamp: now,
          },
        ],
      };

    case 'tool_update':
      return patchTool(state, event.toolCallId, { output: event.partialText });

    case 'tool_end':
      return patchTool(state, event.toolCallId, {
        output: event.text,
        state: event.isError ? 'error' : 'success',
        endedAt: now,
      });

    case 'queue_update':
      return { ...state, queue: { steering: event.steering, followUp: event.followUp } };

    case 'compaction_start':
      return appendStatus(state, `Compacting context (${event.reason})…`, 'info', now);

    case 'compaction_end':
      return appendStatus(
        state,
        event.aborted
          ? `Compaction failed${event.errorMessage ? `: ${event.errorMessage}` : ''}`
          : 'Compaction complete',
        event.aborted ? 'warn' : 'info',
        now,
      );

    case 'retry_start':
      return appendStatus(
        state,
        `Retrying (attempt ${event.attempt}/${event.maxAttempts})${event.message ? `: ${event.message}` : ''}`,
        'warn',
        now,
      );

    case 'retry_end':
      return appendStatus(
        state,
        event.success
          ? 'Retry succeeded'
          : `Retry failed${event.finalError ? `: ${event.finalError}` : ''}`,
        event.success ? 'info' : 'warn',
        now,
      );

    case 'runtime_error':
      return {
        ...state,
        streamingAssistantId: null,
        streamingThinkingId: null,
        blocks: [
          ...state.blocks,
          { kind: 'error', id: nextBlockId('error'), text: event.message, timestamp: now },
        ],
      };

    case 'agent_settled': {
      const preview = lastAssistantText(state);
      return {
        ...state,
        streamingAssistantId: null,
        streamingThinkingId: null,
        lastCompletionPreview: preview,
        // Defensive: the runtime clears its queues when a turn settles.
        queue: { steering: [], followUp: [] },
        settledCount: state.settledCount + 1,
      };
    }

    default:
      return state;
  }
}

/** Number of surviving blocks before `index`, used to splice in place. */
function countKeptBefore(
  blocks: TranscriptBlock[],
  provisional: Set<string>,
  index: number,
): number {
  let kept = 0;
  for (let cursor = 0; cursor < index; cursor += 1) {
    const block = blocks[cursor];
    if (block && !provisional.has(block.id)) kept += 1;
  }
  return kept;
}

/** Two blocks describe the same runtime message (provisional vs authoritative). */
function sameBlockIdentity(left: TranscriptBlock, right: TranscriptBlock): boolean {
  if (left.kind !== right.kind) return false;
  switch (right.kind) {
    case 'user':
    case 'assistant':
    case 'thinking':
    case 'status':
    case 'error':
      return 'text' in left && left.text === right.text;
    case 'shell':
      return 'command' in left && left.command === right.command;
    case 'custom':
      return 'customType' in left && left.customType === right.customType;
    case 'compaction':
    case 'branch':
      return 'summary' in left && left.summary === right.summary;
    default:
      return false;
  }
}

function upsertStreamBlock(
  state: AppState,
  kind: 'assistant' | 'thinking',
  text: string,
  now: number,
): AppState {
  const key = kind === 'assistant' ? 'streamingAssistantId' : 'streamingThinkingId';
  const existingId = state[key];
  if (existingId) {
    return {
      ...state,
      blocks: state.blocks.map((block) =>
        block.id === existingId ? ({ ...block, text } as TranscriptBlock) : block,
      ),
    };
  }
  const id = nextBlockId(kind);
  const block: TranscriptBlock =
    kind === 'assistant'
      ? {
          kind: 'assistant',
          id,
          text,
          streaming: true,
          aborted: false,
          timestamp: now,
        }
      : { kind: 'thinking', id, text, streaming: true, timestamp: now };
  return { ...state, [key]: id, blocks: [...state.blocks, block] };
}

function patchTool(
  state: AppState,
  toolCallId: string,
  patch: Partial<Extract<TranscriptBlock, { kind: 'tool' }>>,
): AppState {
  let found = false;
  const blocks = state.blocks.map((block) => {
    if (!found && block.kind === 'tool' && block.toolCallId === toolCallId) {
      found = true;
      return { ...block, ...patch };
    }
    return block;
  });
  return found ? { ...state, blocks } : state;
}

function appendStatus(state: AppState, text: string, tone: 'info' | 'warn', now: number): AppState {
  return {
    ...state,
    blocks: [
      ...state.blocks,
      { kind: 'status', id: nextBlockId('status'), text, tone, timestamp: now },
    ],
  };
}

function lastAssistantText(state: AppState): string | null {
  for (let index = state.blocks.length - 1; index >= 0; index -= 1) {
    const block = state.blocks[index];
    if (block && block.kind === 'assistant' && block.text.trim()) return block.text.trim();
  }
  return null;
}

/**
 * Rebuilds a transcript from durable messages.
 *
 * Tool results carry no arguments, so they are correlated with the `toolCalls`
 * of the assistant messages that requested them. That keeps the intent line and
 * tool grouping intact after a session switch, compaction, or fork.
 */
export function hydrateBlocks(messages: AgentMessage[], now: number): TranscriptBlock[] {
  const toolArgs = new Map<string, Record<string, unknown>>();
  const blocks: TranscriptBlock[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) toolArgs.set(call.id, call.arguments);
    }
    blocks.push(...blocksFromMessage(message, now, toolArgs));
  }
  return blocks;
}

/** Converts a durable runtime message into renderable blocks. */
export function blocksFromMessage(
  message: AgentMessage,
  now: number,
  toolArgs?: Map<string, Record<string, unknown>>,
): TranscriptBlock[] {
  switch (message.role) {
    case 'user':
      return [
        {
          kind: 'user',
          id: nextBlockId('user'),
          text: message.text,
          timestamp: message.timestamp || now,
        },
      ];
    case 'assistant': {
      const blocks: TranscriptBlock[] = [];
      if (message.thinking.trim()) {
        blocks.push({
          kind: 'thinking',
          id: nextBlockId('thinking'),
          text: message.thinking,
          streaming: false,
          timestamp: message.timestamp || now,
        });
      }
      if (message.text.trim()) {
        blocks.push({
          kind: 'assistant',
          id: nextBlockId('assistant'),
          text: message.text,
          streaming: false,
          aborted: message.stopReason === 'aborted',
          timestamp: message.timestamp || now,
        });
      }
      if (message.errorMessage) {
        blocks.push({
          kind: 'error',
          id: nextBlockId('error'),
          text: message.errorMessage,
          timestamp: message.timestamp || now,
        });
      }
      return blocks;
    }
    case 'toolResult':
      return [
        {
          kind: 'tool',
          id: nextBlockId('tool'),
          toolCallId: message.toolCallId,
          name: message.toolName,
          args: toolArgs?.get(message.toolCallId) ?? {},
          output: message.text,
          state: message.isError ? 'error' : 'success',
          startedAt: message.timestamp || now,
          endedAt: message.timestamp || now,
          timestamp: message.timestamp || now,
        },
      ];
    case 'bashExecution':
      return [
        {
          kind: 'shell',
          id: nextBlockId('shell'),
          command: message.command,
          output: message.output,
          exitCode: message.exitCode,
          excludeFromContext: message.excludeFromContext,
          running: false,
          timestamp: message.timestamp || now,
        },
      ];
    case 'custom':
      return message.display
        ? [
            {
              kind: 'custom',
              id: nextBlockId('custom'),
              customType: message.customType,
              text: message.text,
              timestamp: message.timestamp || now,
            },
          ]
        : [];
    case 'branchSummary':
      return [
        {
          kind: 'branch',
          id: nextBlockId('branch'),
          summary: message.summary,
          detail: `from ${message.fromId}`,
          timestamp: message.timestamp || now,
        },
      ];
    case 'compactionSummary':
      return [
        {
          kind: 'compaction',
          id: nextBlockId('compaction'),
          summary: message.summary,
          detail: `${message.tokensBefore} tokens before compaction`,
          timestamp: message.timestamp || now,
        },
      ];
  }
}

/* --------------------------------------------------------------- selectors */

type ToolTranscriptBlock = Extract<TranscriptBlock, { kind: 'tool' }>;
type ThinkingTranscriptBlock = Extract<TranscriptBlock, { kind: 'thinking' }>;
type ActivityTranscriptBlock = ToolTranscriptBlock | ThinkingTranscriptBlock;
type UserTranscriptBlock = Extract<TranscriptBlock, { kind: 'user' }>;

export type BlockGroup =
  | { kind: 'single'; block: TranscriptBlock }
  | {
      kind: 'tools';
      blocks: ToolTranscriptBlock[];
      activity: ActivityTranscriptBlock[];
      settled: boolean;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: 'user-tools';
      user: UserTranscriptBlock;
      blocks: ToolTranscriptBlock[];
      activity: ActivityTranscriptBlock[];
      startedAt: number;
    };

/**
 * Treats tools and reasoning as one turn activity feed. While work is active it
 * sits directly below the prompt. Once the final answer arrives, the same feed
 * becomes a collapsed summary immediately before that answer.
 */
export function groupBlocks(blocks: TranscriptBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (!block) break;

    if (block.kind === 'user') {
      let end = index + 1;
      while (end < blocks.length && blocks[end]?.kind !== 'user') end += 1;
      const rest = blocks.slice(index + 1, end);
      const tools = rest.filter((entry): entry is ToolTranscriptBlock => entry.kind === 'tool');
      const activity = rest.filter(
        (entry): entry is ActivityTranscriptBlock =>
          entry.kind === 'tool' || entry.kind === 'thinking',
      );
      if (tools.length === 0) {
        groups.push({ kind: 'single', block });
        for (const entry of rest) groups.push({ kind: 'single', block: entry });
        index = end;
        continue;
      }

      const lastToolIndex = rest.findLastIndex((entry) => entry.kind === 'tool');
      const finalAnswerIndex = rest.findIndex(
        (entry, restIndex) =>
          restIndex > lastToolIndex && entry.kind === 'assistant' && !entry.streaming,
      );

      if (finalAnswerIndex === -1) {
        groups.push({
          kind: 'user-tools',
          user: block,
          blocks: tools,
          activity,
          startedAt: block.timestamp,
        });
        for (const entry of rest) {
          if (entry.kind !== 'tool' && entry.kind !== 'thinking') {
            groups.push({ kind: 'single', block: entry });
          }
        }
      } else {
        groups.push({ kind: 'single', block });
        let summaryAdded = false;
        for (let restIndex = 0; restIndex < rest.length; restIndex += 1) {
          const entry = rest[restIndex];
          if (!entry) continue;
          if (restIndex === finalAnswerIndex) {
            groups.push({
              kind: 'tools',
              blocks: tools,
              activity,
              settled: true,
              startedAt: block.timestamp,
              endedAt: entry.timestamp,
            });
            summaryAdded = true;
          }
          if (entry.kind !== 'tool' && entry.kind !== 'thinking') {
            groups.push({ kind: 'single', block: entry });
          }
        }
        if (tools.length > 0 && !summaryAdded) {
          groups.push({ kind: 'tools', blocks: tools, activity, settled: false });
        }
      }
      index = end;
      continue;
    }

    if (block.kind === 'tool') {
      const tools: ToolTranscriptBlock[] = [block];
      index += 1;
      while (blocks[index]?.kind === 'tool') {
        tools.push(blocks[index] as ToolTranscriptBlock);
        index += 1;
      }
      groups.push({ kind: 'tools', blocks: tools, activity: tools, settled: false });
      continue;
    }

    groups.push({ kind: 'single', block });
    index += 1;
  }

  return groups;
}

export function isRunning(state: AppState): boolean {
  if (state.sessionTransitioning) return false;
  const status = state.snapshot.status;
  return status === 'running' || status === 'compacting' || status === 'retrying';
}

export function windowTitle(state: AppState, settings: AppSettings): string {
  const name =
    state.agent?.sessionName ?? shortenPath(state.snapshot.cwd ?? settings.cwd) ?? 'session';
  return isRunning(state) ? `τ | ${name} | running` : `τ | ${name}`;
}

export function shortenPath(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

import type { AgentEvent, AgentMessage, AppSettings } from '../../../shared/domain.js';
import { DEFAULT_CAPABILITIES, DEFAULT_SETTINGS } from '../../../shared/domain.js';
import type { RuntimeSnapshot, SessionTarget } from '../../../shared/ipc.js';
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

export function snapshotTarget(snapshot: RuntimeSnapshot): SessionTarget | undefined {
  const sessionId = snapshot.state?.sessionId;
  return sessionId
    ? { runtime: snapshot.runtime, sessionId }
    : (snapshot.recoveryTarget ?? undefined);
}

function sameTarget(left: SessionTarget | undefined, right: SessionTarget): boolean {
  return left?.runtime === right.runtime && left.sessionId === right.sessionId;
}

function sessionDraftKey(target: SessionTarget | undefined): string | null {
  return target ? `${target.runtime}:${target.sessionId}` : null;
}

/** Saves the outgoing draft and restores the draft owned by the next session. */
function switchDraftSession(state: AppState, nextKey: string | null): AppState {
  if (state.draftSessionKey === nextKey) return state;
  const draftsBySession = state.draftSessionKey
    ? { ...state.draftsBySession, [state.draftSessionKey]: state.draft }
    : state.draftsBySession;
  return {
    ...state,
    draftsBySession,
    draftSessionKey: nextKey,
    draft: nextKey ? (draftsBySession[nextKey] ?? '') : '',
  };
}

export const INITIAL_STATE: AppState = {
  snapshot: INITIAL_SNAPSHOT,
  settings: DEFAULT_SETTINGS,
  agent: null,
  stats: null,
  models: [],
  thinkingLevels: [],
  commands: [],
  resources: { skills: [], prompts: [], diagnostics: [] },
  contextFiles: [],
  systemPromptInspection: null,
  toolCatalog: { tools: [], total: 0, truncated: false, diagnostics: [] },
  resourceReload: null,
  blocks: [],
  streamingAssistantId: null,
  streamingThinkingId: null,
  queue: { runtime: 'tau', sessionId: '', steering: [], followUp: [] },
  diagnostics: [],
  expandAll: false,
  expanded: {},
  draft: '',
  draftsBySession: {},
  draftSessionKey: null,
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
    case 'snapshot': {
      const next = switchDraftSession(
        { ...state, snapshot: action.snapshot, agent: action.snapshot.state ?? state.agent },
        sessionDraftKey(snapshotTarget(action.snapshot)),
      );
      return isRuntimeWorking(state.snapshot.status) && !isRuntimeWorking(action.snapshot.status)
        ? finalizeLatestResponse(next)
        : next;
    }
    case 'queue': {
      const target = snapshotTarget(state.snapshot);
      if (
        action.snapshot.sessionId !== target?.sessionId ||
        action.snapshot.runtime !== target.runtime
      ) {
        return state;
      }
      return { ...state, queue: action.snapshot };
    }
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
      return switchDraftSession(
        {
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
          contextFiles: [],
          systemPromptInspection: null,
          toolCatalog: { tools: [], total: 0, truncated: false, diagnostics: [] },
          resourceReload: null,
          blocks: [],
          streamingAssistantId: null,
          streamingThinkingId: null,
          queue: {
            runtime: action.targetRuntime ?? state.snapshot.runtime,
            sessionId: '',
            steering: [],
            followUp: [],
          },
          expanded: {},
          composerFocusRequest: state.composerFocusRequest + 1,
        },
        null,
      );
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
    case 'resources':
      return { ...state, resources: action.resources };
    case 'contextFiles':
      return { ...state, contextFiles: action.files };
    case 'systemPromptInspection':
      return sameTarget(snapshotTarget(state.snapshot), action.target)
        ? { ...state, systemPromptInspection: action.inspection }
        : state;
    case 'toolCatalog':
      return sameTarget(snapshotTarget(state.snapshot), action.target)
        ? { ...state, toolCatalog: action.catalog }
        : state;
    case 'resourceReload':
      return sameTarget(snapshotTarget(state.snapshot), action.target)
        ? { ...state, resourceReload: action.result }
        : state;
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
        blocks: hydrateBlocks(
          action.messages,
          action.now,
          !isRuntimeWorking(state.snapshot.status),
        ),
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
        queue: { runtime: state.snapshot.runtime, sessionId: '', steering: [], followUp: [] },
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
      return {
        ...state,
        draft: action.text,
        draftsBySession: state.draftSessionKey
          ? { ...state.draftsBySession, [state.draftSessionKey]: action.text }
          : state.draftsBySession,
      };
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
      // Assistant text is assembled from deltas. A new assistant attempt also
      // invalidates a prior candidate in this user turn before any text arrives.
      if (event.message.role === 'assistant') return invalidateLatestResponse(state);
      // Tool results are already represented by their tool block.
      if (event.message.role === 'toolResult') return state;
      return {
        ...state,
        blocks: [...state.blocks, ...blocksFromMessage(event.message, now)],
      };
    }

    case 'message_delta': {
      // Some runtime implementations can omit message_start, so the first
      // delta provides the same continuation evidence. Avoid rescanning the
      // transcript once this response already owns a provisional block.
      let next =
        state.streamingAssistantId === null && state.streamingThinkingId === null
          ? invalidateLatestResponse(state)
          : state;
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
      // Native runtime queues are not authoritative for editable GUI prompts.
      return state;

    case 'compaction_start':
      return appendStatus(state, `Compacting context (${event.reason})…`, 'info', now);

    case 'compaction_end': {
      const next = appendStatus(
        state,
        event.aborted
          ? `Compaction failed${event.errorMessage ? `: ${event.errorMessage}` : ''}`
          : 'Compaction complete',
        event.aborted ? 'warn' : 'info',
        now,
      );
      return event.willRetry ? invalidateLatestResponse(next) : next;
    }

    case 'retry_start':
      return invalidateLatestResponse(
        appendStatus(
          state,
          `Retrying (attempt ${event.attempt}/${event.maxAttempts})${event.message ? `: ${event.message}` : ''}`,
          'warn',
          now,
        ),
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

    case 'agent_end':
      return event.willRetry ? invalidateLatestResponse(state) : state;

    case 'agent_settled': {
      // Error and truncated responses cannot be considered terminal at
      // message_end because Pi may retry or compact-and-continue them. Promote
      // the latest no-tool candidate only once the whole run actually settles.
      // RuntimeManager publishes the terminal snapshot before this event and
      // deliberately leaves status active for a stale duplicate settle.
      const settled = isRuntimeWorking(state.snapshot.status)
        ? state
        : finalizeLatestResponse(state);
      const preview = lastAssistantText(settled);
      return {
        ...settled,
        streamingAssistantId: null,
        streamingThinkingId: null,
        lastCompletionPreview: preview,
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

/** Updates only the latest assistant response in the current user turn. */
function patchLatestAssistant(
  state: AppState,
  patch: (
    block: Extract<TranscriptBlock, { kind: 'assistant' }>,
  ) => Extract<TranscriptBlock, { kind: 'assistant' }> | null,
): AppState {
  const lastUser = state.blocks.findLastIndex((block) => block.kind === 'user');
  const index = state.blocks.findLastIndex((block) => block.kind === 'assistant');
  if (index <= lastUser) return state;
  const block = state.blocks[index];
  if (!block || block.kind !== 'assistant') return state;
  const replacement = patch(block);
  if (!replacement) return state;
  const blocks = [...state.blocks];
  blocks[index] = replacement;
  return { ...state, blocks };
}

function invalidateLatestResponse(state: AppState): AppState {
  return patchLatestAssistant(state, (block) => (block.final ? { ...block, final: false } : null));
}

function finalizeLatestResponse(state: AppState): AppState {
  return patchLatestAssistant(state, (block) =>
    block.endedWithoutTools && !block.final ? { ...block, final: true } : null,
  );
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
          // Streaming text is never the answer until message_end proves the
          // model returned no tool calls.
          final: false,
          endedWithoutTools: false,
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
    if (block?.kind === 'assistant') return block.text.trim() || null;
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
export function hydrateBlocks(
  messages: AgentMessage[],
  now: number,
  settleTail = true,
): TranscriptBlock[] {
  const toolArgs = new Map<string, Record<string, unknown>>();
  const blocks: TranscriptBlock[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) toolArgs.set(call.id, call.arguments);
    }
    blocks.push(...blocksFromMessage(message, now, toolArgs));
  }
  return finalizeHydratedResponses(blocks, settleTail);
}

/** Finalizes the last no-tool response in each durable user turn. */
function finalizeHydratedResponses(
  blocks: TranscriptBlock[],
  settleTail: boolean,
): TranscriptBlock[] {
  const settled = [...blocks];
  let latestAssistant = -1;
  const finalizeAt = (index: number): void => {
    const block = settled[index];
    if (block?.kind === 'assistant' && block.endedWithoutTools && !block.final) {
      settled[index] = { ...block, final: true };
    }
  };

  for (let index = 0; index < settled.length; index += 1) {
    const block = settled[index];
    if (block?.kind === 'user') {
      finalizeAt(latestAssistant);
      latestAssistant = -1;
    } else if (block?.kind === 'assistant') {
      latestAssistant = index;
    }
  }
  if (settleTail) finalizeAt(latestAssistant);
  return settled;
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
      const endedWithoutTools = message.toolCalls.length === 0;
      if (message.thinking.trim()) {
        blocks.push({
          kind: 'thinking',
          id: nextBlockId('thinking'),
          text: message.thinking,
          streaming: false,
          timestamp: message.timestamp || now,
        });
      }
      // A no-tool response needs a block even when it has no visible text: the
      // block is the durable completion marker for thinking-only and provider
      // failure responses, and groupBlocks omits it from rendered output.
      if (message.text.trim() || endedWithoutTools) {
        blocks.push({
          kind: 'assistant',
          id: nextBlockId('assistant'),
          text: message.text,
          streaming: false,
          aborted: message.stopReason === 'aborted',
          // Error and length responses can be followed by an automatic retry.
          // They become final at agent_settled if no continuation supersedes them.
          final:
            endedWithoutTools && message.stopReason !== 'error' && message.stopReason !== 'length',
          endedWithoutTools,
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
type AssistantTranscriptBlock = Extract<TranscriptBlock, { kind: 'assistant' }>;
type ActivityTranscriptBlock =
  ToolTranscriptBlock | ThinkingTranscriptBlock | AssistantTranscriptBlock;
type UserTranscriptBlock = Extract<TranscriptBlock, { kind: 'user' }>;

export type BlockGroup =
  | { kind: 'single'; block: TranscriptBlock }
  | {
      kind: 'tools';
      /** Stable id of the feed, derived from its first activity block. */
      id: string;
      blocks: ToolTranscriptBlock[];
      activity: ActivityTranscriptBlock[];
      settled: boolean;
      startedAt?: number;
      endedAt?: number;
    }
  | {
      kind: 'user-tools';
      user: UserTranscriptBlock;
      id: string;
      blocks: ToolTranscriptBlock[];
      activity: ActivityTranscriptBlock[];
      settled: boolean;
      startedAt: number;
      endedAt?: number;
    };

/**
 * Groups the transcript into turns.
 *
 * A turn is everything between two user prompts. Reasoning, intermediate
 * narration, and tool calls form one activity feed; only an assistant response
 * that ended without requesting further tool calls is rendered as the answer.
 * While the turn is still running the feed stays live and narration renders as
 * a provisional message; the feed collapses into a summary only once the final
 * response exists.
 */
export function groupBlocks(blocks: TranscriptBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let index = 0;

  while (index < blocks.length) {
    const block = blocks[index];
    if (!block) break;

    // Headless turn bodies exist too: hydrated tails, post-compaction
    // continuations, and steering echoes can precede any rendered prompt.
    const leading = block.kind === 'user' ? block : null;
    let end = index + (leading ? 1 : 0);
    while (end < blocks.length && blocks[end]?.kind !== 'user') end += 1;
    groups.push(...turnGroups(leading, blocks.slice(leading ? index + 1 : index, end)));
    index = end;
  }

  return groups;
}

/** Renders one turn body as an activity feed plus the blocks that stand alone. */
function turnGroups(user: UserTranscriptBlock | null, body: TranscriptBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  const lastTool = body.findLastIndex((entry) => entry.kind === 'tool');
  // A previous attempt cannot settle a turn while a newer assistant response is
  // provisional. Only the latest response may be its closing answer.
  const lastAssistant = body.findLastIndex((entry) => entry.kind === 'assistant');
  const candidate = body[lastAssistant];
  const answerAt =
    lastAssistant > lastTool && candidate?.kind === 'assistant' && candidate.final
      ? lastAssistant
      : -1;
  const hiddenAssistant = (entry: TranscriptBlock): boolean =>
    entry.kind === 'assistant' && !entry.text.trim();
  // Reasoning always belongs to the rail; visible narration joins it only when
  // a later tool call proved it was intermediate work rather than the answer.
  const isActivity = (entry: TranscriptBlock, entryIndex: number): boolean =>
    entry.kind === 'tool' ||
    entry.kind === 'thinking' ||
    (entry.kind === 'assistant' && !hiddenAssistant(entry) && entryIndex < lastTool);
  const activity = body.filter((entry, entryIndex): entry is ActivityTranscriptBlock =>
    isActivity(entry, entryIndex),
  );
  const standalone = (entry: TranscriptBlock, entryIndex: number): boolean =>
    !hiddenAssistant(entry) && !isActivity(entry, entryIndex);

  if (activity.length === 0) {
    if (user) groups.push({ kind: 'single', block: user });
    for (const entry of body) {
      if (!hiddenAssistant(entry)) groups.push({ kind: 'single', block: entry });
    }
    return groups;
  }

  const feed = {
    id: activity[0]?.id ?? '',
    blocks: activity.filter((entry): entry is ToolTranscriptBlock => entry.kind === 'tool'),
    activity,
  };
  const answer = answerAt === -1 ? null : body[answerAt];
  // The activity feed stays live until the turn has actually ended, i.e. until
  // the model produced a response with no tool calls. Keeping the prompt and
  // feed in the same stable group also lets the view animate the live rail into
  // its summary instead of remounting it after message_end.
  const settled = answerAt !== -1;

  groups.push(
    user
      ? {
          kind: 'user-tools',
          user,
          ...feed,
          settled,
          startedAt: user.timestamp,
          endedAt: answer?.timestamp,
        }
      : {
          kind: 'tools',
          ...feed,
          settled,
          endedAt: answer?.timestamp,
        },
  );
  body.forEach((entry, entryIndex) => {
    if (standalone(entry, entryIndex)) groups.push({ kind: 'single', block: entry });
  });
  return groups;
}

function isRuntimeWorking(status: RuntimeSnapshot['status']): boolean {
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'compacting' ||
    status === 'retrying'
  );
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

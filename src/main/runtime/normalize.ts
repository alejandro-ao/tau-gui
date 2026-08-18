/**
 * Wire → application-domain normalization.
 *
 * Tau and Pi both speak a camelCase JSONL dialect derived from Pi's protocol.
 * All Tau/Pi specific knowledge about payload shapes lives here so the renderer
 * only handles `src/shared/domain.ts` types.
 */
import type {
  AgentEvent,
  AgentMessage,
  AssistantMessage,
  Model,
  SessionEntry,
  SessionStats,
  AgentState,
  StopReason,
  ThinkingLevel,
  ToolCall,
  TreeNode,
  Usage,
} from '../../shared/domain.js';
import { THINKING_LEVELS } from '../../shared/domain.js';

type Wire = Record<string, unknown>;

const isWire = (value: unknown): value is Wire =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const numOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

const bool = (value: unknown, fallback = false): boolean =>
  typeof value === 'boolean' ? value : fallback;

const record = (value: unknown): Record<string, unknown> => (isWire(value) ? value : {});

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export function normalizeThinkingLevel(value: unknown): ThinkingLevel {
  const level = str(value, 'medium');
  return (THINKING_LEVELS as readonly string[]).includes(level)
    ? (level as ThinkingLevel)
    : 'medium';
}

/* ---------------------------------------------------------------- messages */

/** Concatenate the text of Pi/Tau `UserContent` (string or content blocks). */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  return list(content)
    .filter(isWire)
    .filter((block) => block['type'] === 'text')
    .map((block) => str(block['text']))
    .join('');
}

function contentImages(content: unknown): { mimeType: string; data: string }[] {
  return list(content)
    .filter(isWire)
    .filter((block) => block['type'] === 'image')
    .map((block) => ({ mimeType: str(block['mimeType']), data: str(block['data']) }));
}

function normalizeUsage(value: unknown): Usage | null {
  if (!isWire(value)) return null;
  const cost = record(value['cost']);
  return {
    input: num(value['input']),
    output: num(value['output']),
    cacheRead: num(value['cacheRead']),
    cacheWrite: num(value['cacheWrite']),
    reasoning: numOrNull(value['reasoning']),
    totalTokens: num(value['totalTokens']),
    cost: numOrNull(cost['total']),
  };
}

function normalizeStopReason(value: unknown): StopReason | null {
  const reason = str(value);
  return reason === 'stop' ||
    reason === 'length' ||
    reason === 'toolUse' ||
    reason === 'error' ||
    reason === 'aborted'
    ? reason
    : null;
}

function normalizeToolCalls(content: unknown): ToolCall[] {
  return list(content)
    .filter(isWire)
    .filter((block) => block['type'] === 'toolCall')
    .map((block) => ({
      id: str(block['id']),
      name: str(block['name']),
      arguments: record(block['arguments']),
    }));
}

export function normalizeAssistantMessage(value: Wire): AssistantMessage {
  const content = list(value['content']).filter(isWire);
  return {
    role: 'assistant',
    text: content
      .filter((block) => block['type'] === 'text')
      .map((block) => str(block['text']))
      .join(''),
    thinking: content
      .filter((block) => block['type'] === 'thinking')
      .map((block) => str(block['thinking']))
      .join(''),
    toolCalls: normalizeToolCalls(value['content']),
    provider: str(value['provider']),
    model: str(value['model']),
    usage: normalizeUsage(value['usage']),
    stopReason: normalizeStopReason(value['stopReason']),
    errorMessage: typeof value['errorMessage'] === 'string' ? value['errorMessage'] : null,
    timestamp: num(value['timestamp'], Date.now()),
  };
}

/** Returns null for unrecognized roles so callers can fall back safely. */
export function normalizeMessage(value: unknown): AgentMessage | null {
  if (!isWire(value)) return null;
  const timestamp = num(value['timestamp'], Date.now());
  switch (value['role']) {
    case 'user':
      return {
        role: 'user',
        text: contentText(value['content']),
        images: contentImages(value['content']),
        timestamp,
      };
    case 'assistant':
      return normalizeAssistantMessage(value);
    case 'toolResult':
      return {
        role: 'toolResult',
        toolCallId: str(value['toolCallId']),
        toolName: str(value['toolName']),
        text: contentText(value['content']),
        details: record(value['details']),
        isError: bool(value['isError']),
        timestamp,
      };
    case 'bashExecution':
      return {
        role: 'bashExecution',
        command: str(value['command']),
        output: str(value['output']),
        exitCode: numOrNull(value['exitCode']),
        cancelled: bool(value['cancelled']),
        truncated: bool(value['truncated']),
        excludeFromContext: bool(value['excludeFromContext']),
        timestamp,
      };
    case 'custom':
      return {
        role: 'custom',
        customType: str(value['customType'], 'custom'),
        text: contentText(value['content']),
        display: bool(value['display'], true),
        details: record(value['details']),
        timestamp,
      };
    case 'branchSummary':
      return {
        role: 'branchSummary',
        summary: str(value['summary']),
        fromId: str(value['fromId']),
        timestamp,
      };
    case 'compactionSummary':
      return {
        role: 'compactionSummary',
        summary: str(value['summary']),
        tokensBefore: num(value['tokensBefore']),
        timestamp,
      };
    default:
      return null;
  }
}

export function normalizeMessages(value: unknown): AgentMessage[] {
  return list(value)
    .map(normalizeMessage)
    .filter((message): message is AgentMessage => message !== null);
}

/* ------------------------------------------------------------------ events */

/** Returns null when a wire event has no application-domain meaning. */
export function normalizeEvent(record_: Wire): AgentEvent | null {
  const type = str(record_['type']);
  switch (type) {
    case 'agent_start':
      return { type: 'agent_start' };
    case 'turn_start':
      return { type: 'turn_start' };
    case 'turn_end':
      return { type: 'turn_end' };
    case 'message_start': {
      const message = normalizeMessage(record_['message']);
      return message ? { type: 'message_start', message } : null;
    }
    case 'message_end': {
      const message = normalizeMessage(record_['message']);
      return message ? { type: 'message_end', message } : null;
    }
    case 'message_update': {
      const wireMessage = record_['message'];
      if (!isWire(wireMessage) || wireMessage['role'] !== 'assistant') return null;
      const message = normalizeAssistantMessage(wireMessage);
      const inner = record(record_['assistantMessageEvent']);
      const innerType = str(inner['type']);
      const delta = str(inner['delta']);
      if (innerType === 'text_delta')
        return { type: 'message_delta', kind: 'text', delta, message };
      if (innerType === 'thinking_delta')
        return { type: 'message_delta', kind: 'thinking', delta, message };
      // Non-delta stream events still carry an authoritative partial snapshot.
      return { type: 'message_delta', kind: 'text', delta: '', message };
    }
    case 'tool_execution_start':
      return {
        type: 'tool_start',
        toolCallId: str(record_['toolCallId']),
        toolName: str(record_['toolName']),
        args: record(record_['args']),
      };
    case 'tool_execution_update':
      return {
        type: 'tool_update',
        toolCallId: str(record_['toolCallId']),
        toolName: str(record_['toolName']),
        args: record(record_['args']),
        partialText: contentText(record(record_['partialResult'])['content']),
      };
    case 'tool_execution_end': {
      const result = record(record_['result']);
      return {
        type: 'tool_end',
        toolCallId: str(record_['toolCallId']),
        toolName: str(record_['toolName']),
        text: contentText(result['content']),
        details: record(result['details']),
        isError: bool(record_['isError']),
      };
    }
    case 'agent_end':
      return { type: 'agent_end', willRetry: bool(record_['willRetry']) };
    case 'agent_settled':
      return { type: 'agent_settled' };
    case 'queue_update':
      return {
        type: 'queue_update',
        steering: list(record_['steering']).map((item) => str(item)),
        followUp: list(record_['followUp']).map((item) => str(item)),
      };
    case 'compaction_start':
      return { type: 'compaction_start', reason: normalizeCompactionReason(record_['reason']) };
    case 'compaction_end':
      return {
        type: 'compaction_end',
        reason: normalizeCompactionReason(record_['reason']),
        aborted: bool(record_['aborted']),
        willRetry: bool(record_['willRetry']),
        errorMessage: typeof record_['errorMessage'] === 'string' ? record_['errorMessage'] : null,
      };
    case 'auto_retry_start':
      return {
        type: 'retry_start',
        attempt: num(record_['attempt'], 1),
        maxAttempts: num(record_['maxAttempts'], 1),
        delayMs: num(record_['delayMs']),
        message: str(record_['errorMessage']),
      };
    case 'auto_retry_end':
      return {
        type: 'retry_end',
        success: bool(record_['success']),
        attempt: num(record_['attempt'], 1),
        finalError: typeof record_['finalError'] === 'string' ? record_['finalError'] : null,
      };
    case 'rpc_error':
      return { type: 'runtime_error', message: str(record_['error'], 'Runtime error') };
    default:
      return null;
  }
}

function normalizeCompactionReason(value: unknown): 'manual' | 'threshold' | 'overflow' {
  const reason = str(value);
  return reason === 'manual' || reason === 'threshold' || reason === 'overflow' ? reason : 'manual';
}

/* ------------------------------------------------------- state and models */

export function normalizeModel(value: unknown): Model | null {
  if (!isWire(value)) return null;
  const cost = record(value['cost']);
  return {
    id: str(value['id']),
    name: str(value['name'], str(value['id'])),
    provider: str(value['provider']),
    api: str(value['api']),
    reasoning: bool(value['reasoning']),
    input: list(value['input']).map((item) => str(item)),
    contextWindow: num(value['contextWindow']),
    maxTokens: num(value['maxTokens']),
    cost: {
      input: num(cost['input']),
      output: num(cost['output']),
      cacheRead: num(cost['cacheRead']),
      cacheWrite: num(cost['cacheWrite']),
    },
  };
}

export function normalizeState(value: unknown): AgentState {
  const wire = record(value);
  return {
    model: normalizeModel(wire['model']),
    thinkingLevel: normalizeThinkingLevel(wire['thinkingLevel']),
    isStreaming: bool(wire['isStreaming']),
    isCompacting: bool(wire['isCompacting']),
    sessionFile: typeof wire['sessionFile'] === 'string' ? wire['sessionFile'] : null,
    sessionId: str(wire['sessionId']),
    sessionName: typeof wire['sessionName'] === 'string' ? wire['sessionName'] : null,
    autoCompactionEnabled: bool(wire['autoCompactionEnabled'], true),
    messageCount: num(wire['messageCount']),
    pendingMessageCount: num(wire['pendingMessageCount']),
  };
}

export function normalizeStats(value: unknown): SessionStats {
  const wire = record(value);
  const tokens = record(wire['tokens']);
  const usage = record(wire['contextUsage']);
  return {
    sessionFile: typeof wire['sessionFile'] === 'string' ? wire['sessionFile'] : null,
    sessionId: str(wire['sessionId']),
    userMessages: num(wire['userMessages']),
    assistantMessages: num(wire['assistantMessages']),
    toolCalls: num(wire['toolCalls']),
    totalMessages: num(wire['totalMessages']),
    tokens: {
      input: num(tokens['input']),
      output: num(tokens['output']),
      cacheRead: num(tokens['cacheRead']),
      cacheWrite: num(tokens['cacheWrite']),
      total: num(tokens['total']),
    },
    cost: numOrNull(wire['cost']),
    contextUsage: {
      tokens: num(usage['tokens']),
      contextWindow: num(usage['contextWindow']),
      percent: num(usage['percent']),
    },
  };
}

/* ----------------------------------------------------------------- entries */

const ENTRY_KINDS: readonly SessionEntry['kind'][] = [
  'message',
  'custom_message',
  'model_change',
  'thinking_level_change',
  'compaction',
  'branch_summary',
  'custom',
  'label',
  'session_info',
];

export function normalizeEntry(value: unknown): SessionEntry | null {
  if (!isWire(value)) return null;
  const rawKind = str(value['type']);
  const kind = (ENTRY_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as SessionEntry['kind'])
    : 'custom';
  const message = normalizeMessage(value['message']) ?? undefined;
  const entry: SessionEntry = {
    id: str(value['id']),
    parentId: typeof value['parentId'] === 'string' ? value['parentId'] : null,
    timestamp: str(value['timestamp']),
    kind,
    summary: entrySummary(kind, value, message),
    raw: value,
  };
  if (message) entry.message = message;
  return entry;
}

function entrySummary(
  kind: SessionEntry['kind'],
  value: Wire,
  message: AgentMessage | undefined,
): string {
  if (message) {
    switch (message.role) {
      case 'user':
        return message.text;
      case 'assistant':
        return message.text || (message.toolCalls[0]?.name ?? '(thinking)');
      case 'toolResult':
        return message.toolName;
      case 'bashExecution':
        return `$ ${message.command}`;
      case 'custom':
        return message.text || message.customType;
      case 'branchSummary':
      case 'compactionSummary':
        return message.summary;
    }
  }
  switch (kind) {
    case 'model_change':
      return `model → ${str(value['provider'])}:${str(value['modelId'])}`;
    case 'thinking_level_change':
      return `thinking → ${str(value['thinkingLevel'], 'off')}`;
    case 'compaction':
      return str(value['summary'], 'compaction');
    case 'branch_summary':
      return str(value['summary'], 'branch summary');
    case 'label':
      return str(value['label']);
    case 'session_info':
      return str(value['name'], 'session');
    case 'custom_message':
      return str(value['customType'], 'custom message');
    default:
      return str(value['customType'], kind);
  }
}

export function normalizeEntries(value: unknown): SessionEntry[] {
  return list(value)
    .map(normalizeEntry)
    .filter((entry): entry is SessionEntry => entry !== null);
}

export function normalizeTree(value: unknown): TreeNode[] {
  return list(value)
    .map((node) => {
      if (!isWire(node)) return null;
      const entry = normalizeEntry(node['entry']);
      if (!entry) return null;
      return { entry, children: normalizeTree(node['children']) } satisfies TreeNode;
    })
    .filter((node): node is TreeNode => node !== null);
}

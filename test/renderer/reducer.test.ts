import { beforeEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AssistantMessage } from '../../src/shared/domain.js';
import {
  INITIAL_STATE,
  groupBlocks,
  isExpanded,
  isRunning,
  reducer,
  resetBlockIds,
  windowTitle,
} from '../../src/renderer/src/state/reducer.js';
import type { AppState, TranscriptBlock } from '../../src/renderer/src/state/types.js';

const assistant = (text: string, thinking = ''): AssistantMessage => ({
  role: 'assistant',
  text,
  thinking,
  toolCalls: [],
  provider: 'fake',
  model: 'fake-large',
  usage: null,
  stopReason: 'stop',
  errorMessage: null,
  timestamp: 1,
});

const replay = (events: AgentEvent[], start: AppState = INITIAL_STATE): AppState =>
  events.reduce((state, event) => reducer(state, { type: 'event', event, now: 1000 }), start);

beforeEach(() => {
  resetBlockIds();
});

describe('session event routing', () => {
  const activeState: AppState = {
    ...INITIAL_STATE,
    snapshot: {
      ...INITIAL_STATE.snapshot,
      runtime: 'tau',
      status: 'idle',
      state: {
        model: null,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        sessionFile: null,
        sessionId: 'active-session',
        sessionName: null,
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    },
  };

  it('rejects a queued tool event from the previously active session', () => {
    const event: AgentEvent = {
      type: 'tool_start',
      toolCallId: 'stale-call',
      toolName: 'read',
      args: { path: 'old-session.ts' },
    };

    const stale = reducer(activeState, {
      type: 'event',
      event,
      sessionId: 'background-session',
      runtime: 'tau',
      now: 1000,
    });
    const current = reducer(activeState, {
      type: 'event',
      event,
      sessionId: 'active-session',
      runtime: 'tau',
      now: 1000,
    });

    expect(stale).toBe(activeState);
    expect(stale.blocks).toEqual([]);
    expect(current.blocks).toHaveLength(1);
  });
});

describe('streaming assembly', () => {
  it('creates a provisional assistant block from deltas', () => {
    const state = replay([
      { type: 'agent_start' },
      { type: 'message_delta', kind: 'text', delta: 'Hel', message: assistant('Hel') },
      { type: 'message_delta', kind: 'text', delta: 'lo', message: assistant('Hello') },
    ]);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: 'assistant', text: 'Hello', streaming: true });
    expect(state.streamingAssistantId).not.toBeNull();
  });

  it('replaces provisional state with the authoritative message_end payload', () => {
    const state = replay([
      { type: 'agent_start' },
      { type: 'message_delta', kind: 'text', delta: 'partial', message: assistant('partial') },
      { type: 'message_end', message: assistant('final answer') },
    ]);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({
      kind: 'assistant',
      text: 'final answer',
      streaming: false,
    });
    expect(state.streamingAssistantId).toBeNull();
  });

  it('keeps thinking and text as separate blocks', () => {
    const state = replay([
      { type: 'agent_start' },
      { type: 'message_delta', kind: 'thinking', delta: 'why', message: assistant('', 'why') },
      {
        type: 'message_delta',
        kind: 'text',
        delta: 'because',
        message: assistant('because', 'why'),
      },
      { type: 'message_end', message: assistant('because', 'why') },
    ]);
    expect(state.blocks.map((block) => block.kind)).toEqual(['thinking', 'assistant']);
  });

  it('renders user messages once from message_start', () => {
    const state = replay([
      { type: 'message_start', message: { role: 'user', text: 'do it', images: [], timestamp: 1 } },
      { type: 'message_end', message: { role: 'user', text: 'do it', images: [], timestamp: 1 } },
    ]);
    expect(state.blocks).toHaveLength(1);
    expect(state.blocks[0]).toMatchObject({ kind: 'user', text: 'do it' });
  });

  it('splices the authoritative message in place, keeping mid-stream blocks in order', () => {
    const state = replay([
      { type: 'agent_start' },
      { type: 'message_delta', kind: 'text', delta: 'Look', message: assistant('Look') },
      { type: 'tool_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'retry_start', attempt: 1, maxAttempts: 2, delayMs: 0, message: 'rate limited' },
      {
        type: 'message_delta',
        kind: 'text',
        delta: ' here',
        message: assistant('Look here'),
      },
      { type: 'message_end', message: assistant('Look here') },
    ]);
    expect(state.blocks.map((block) => block.kind)).toEqual(['assistant', 'tool', 'status']);
    expect(state.blocks[0]).toMatchObject({ text: 'Look here', streaming: false });
  });

  it('keeps thinking before text when tool blocks interleave with the stream', () => {
    const state = replay([
      { type: 'agent_start' },
      { type: 'message_delta', kind: 'thinking', delta: 'plan', message: assistant('', 'plan') },
      { type: 'message_delta', kind: 'text', delta: 'go', message: assistant('go', 'plan') },
      { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: { command: 'ls' } },
      { type: 'message_end', message: assistant('go', 'plan') },
    ]);
    expect(state.blocks.map((block) => block.kind)).toEqual(['thinking', 'assistant', 'tool']);
  });

  it('adds an error block for provider failures and keeps the transcript usable', () => {
    const failed: AssistantMessage = {
      ...assistant('I could not finish.'),
      stopReason: 'error',
      errorMessage: 'provider unavailable (503)',
    };
    const state = replay([{ type: 'agent_start' }, { type: 'message_end', message: failed }]);
    expect(state.blocks.map((block) => block.kind)).toEqual(['assistant', 'error']);
  });

  it('clears streaming state on rpc_error', () => {
    const state = replay([
      { type: 'agent_start' },
      { type: 'message_delta', kind: 'text', delta: 'x', message: assistant('x') },
      { type: 'runtime_error', message: 'stream broke' },
    ]);
    expect(state.streamingAssistantId).toBeNull();
    expect(state.blocks.at(-1)).toMatchObject({ kind: 'error', text: 'stream broke' });
  });
});

describe('tools', () => {
  const toolRun: AgentEvent[] = [
    { type: 'tool_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
    {
      type: 'tool_update',
      toolCallId: 'c1',
      toolName: 'read',
      args: { path: 'a.ts' },
      partialText: 'partial',
    },
    {
      type: 'tool_end',
      toolCallId: 'c1',
      toolName: 'read',
      text: 'full body',
      details: {},
      isError: false,
    },
  ];

  it('tracks tool lifecycle on one block', () => {
    const running = replay(toolRun.slice(0, 2));
    expect(running.blocks[0]).toMatchObject({ kind: 'tool', state: 'running', output: 'partial' });
    const done = replay(toolRun);
    expect(done.blocks).toHaveLength(1);
    expect(done.blocks[0]).toMatchObject({ state: 'success', output: 'full body', endedAt: 1000 });
  });

  it('marks failures', () => {
    const state = replay([
      { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
      {
        type: 'tool_end',
        toolCallId: 'c1',
        toolName: 'bash',
        text: 'boom',
        details: {},
        isError: true,
      },
    ]);
    expect(state.blocks[0]).toMatchObject({ state: 'error' });
  });

  it('does not duplicate a tool block from toolResult message_start', () => {
    const state = replay([
      ...toolRun,
      {
        type: 'message_start',
        message: {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'read',
          text: 'full body',
          details: {},
          isError: false,
          timestamp: 1,
        },
      },
    ]);
    expect(state.blocks).toHaveLength(1);
  });

  it('ignores toolResult messages because tool blocks already cover them', () => {
    const state = replay([
      ...toolRun,
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'read',
          text: 'full body',
          details: {},
          isError: false,
          timestamp: 1,
        },
      },
    ]);
    expect(state.blocks).toHaveLength(1);
  });

  it('collects all adjacent tool calls into one run', () => {
    const state = replay([
      { type: 'tool_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
      { type: 'tool_start', toolCallId: 'c2', toolName: 'read', args: { path: 'b.ts' } },
      { type: 'tool_start', toolCallId: 'c3', toolName: 'bash', args: { command: 'ls' } },
      { type: 'tool_start', toolCallId: 'c4', toolName: 'mystery_extension', args: {} },
    ]);
    const groups = groupBlocks(state.blocks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'tools', settled: false });
    expect(groups[0]?.kind === 'tools' && groups[0].blocks).toHaveLength(4);
  });

  it('shows tools below the prompt until the final answer has finished', () => {
    const user: TranscriptBlock = { kind: 'user', id: 'u', text: 'inspect', timestamp: 0 };
    const answer: TranscriptBlock = {
      kind: 'assistant',
      id: 'a',
      text: 'done',
      streaming: true,
      aborted: false,
      timestamp: 2,
    };
    const tool = replay([
      { type: 'tool_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
    ]).blocks[0];
    if (!tool) throw new Error('expected tool');

    expect(groupBlocks([user, tool, answer]).map((group) => group.kind)).toEqual([
      'user-tools',
      'single',
    ]);
    expect(
      groupBlocks([user, tool, { ...answer, streaming: false }]).map((group) => group.kind),
    ).toEqual(['single', 'tools', 'single']);
  });

  it('interleaves thinking with tools in the turn activity feed', () => {
    const user: TranscriptBlock = { kind: 'user', id: 'u', text: 'inspect', timestamp: 0 };
    const thinking: TranscriptBlock = {
      kind: 'thinking',
      id: 'thought',
      text: 'Checking the relevant files.',
      streaming: false,
      timestamp: 1,
    };
    const first = replay([
      { type: 'tool_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
    ]).blocks[0];
    const second = replay([
      { type: 'tool_start', toolCallId: 'c2', toolName: 'bash', args: { command: 'npm test' } },
    ]).blocks[0];
    if (!first || !second) throw new Error('expected tools');

    const group = groupBlocks([user, first, thinking, second])[0];
    expect(group?.kind).toBe('user-tools');
    expect(group?.kind === 'user-tools' && group.activity.map((entry) => entry.kind)).toEqual([
      'tool',
      'thinking',
      'tool',
    ]);
  });

  it('does not treat assistant progress before a tool as the final answer', () => {
    const user: TranscriptBlock = { kind: 'user', id: 'u', text: 'inspect', timestamp: 0 };
    const progress: TranscriptBlock = {
      kind: 'assistant',
      id: 'a',
      text: 'inspecting',
      streaming: false,
      aborted: false,
      timestamp: 1,
    };
    const tool = replay([
      { type: 'tool_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
    ]).blocks[0];
    if (!tool) throw new Error('expected tool');

    expect(groupBlocks([user, progress, tool]).map((group) => group.kind)).toEqual([
      'user-tools',
      'single',
    ]);
  });
});

describe('lifecycle bookkeeping', () => {
  it('records queue state', () => {
    const state = replay([{ type: 'queue_update', steering: ['a'], followUp: ['b'] }]);
    expect(state.queue).toEqual({ steering: ['a'], followUp: ['b'] });
  });

  it('adds status blocks for compaction and retries', () => {
    const state = replay([
      { type: 'compaction_start', reason: 'overflow' },
      {
        type: 'compaction_end',
        reason: 'overflow',
        aborted: false,
        willRetry: true,
        errorMessage: null,
      },
      { type: 'retry_start', attempt: 1, maxAttempts: 1, delayMs: 0, message: 'Context overflow' },
      { type: 'retry_end', success: true, attempt: 1, finalError: null },
    ]);
    expect(state.blocks.map((block) => block.kind)).toEqual([
      'status',
      'status',
      'status',
      'status',
    ]);
  });

  it('captures a completion preview and counts settles', () => {
    const state = replay([
      { type: 'agent_start' },
      { type: 'message_end', message: assistant('all done') },
      { type: 'agent_settled' },
    ]);
    expect(state.lastCompletionPreview).toBe('all done');
    expect(state.settledCount).toBe(1);
    // A repeated identical answer is a distinct settle.
    const again = replay(
      [{ type: 'message_end', message: assistant('all done') }, { type: 'agent_settled' }],
      state,
    );
    expect(again.settledCount).toBe(2);
  });

  it('clears the queue when the turn settles', () => {
    const state = replay([
      { type: 'queue_update', steering: ['stop that'], followUp: ['then this'] },
      { type: 'agent_settled' },
    ]);
    expect(state.queue).toEqual({ steering: [], followUp: [] });
  });

  it('treats running/compacting/retrying as active and idle as settled', () => {
    const base = { ...INITIAL_STATE };
    for (const status of ['running', 'compacting', 'retrying'] as const) {
      expect(isRunning({ ...base, snapshot: { ...base.snapshot, status } })).toBe(true);
    }
    for (const status of ['idle', 'stopped', 'failed', 'disconnected'] as const) {
      expect(isRunning({ ...base, snapshot: { ...base.snapshot, status } })).toBe(false);
    }
  });
});

describe('view state', () => {
  it('toggles global and per-block expansion', () => {
    let state = reducer(INITIAL_STATE, { type: 'toggleExpandAll' });
    expect(isExpanded(state, 'tool-1')).toBe(true);
    state = reducer(state, { type: 'toggleExpanded', id: 'tool-1' });
    expect(isExpanded(state, 'tool-1')).toBe(false);
    expect(isExpanded(state, 'tool-2')).toBe(true);
  });

  it('clears transcript state without touching settings', () => {
    const seeded = replay([{ type: 'queue_update', steering: ['x'], followUp: [] }]);
    const cleared = reducer(seeded, { type: 'clearTranscript' });
    expect(cleared.blocks).toEqual([]);
    expect(cleared.queue).toEqual({ steering: [], followUp: [] });
    expect(cleared.settings).toBe(seeded.settings);
  });

  it('hydrates a transcript from durable messages', () => {
    const state = reducer(INITIAL_STATE, {
      type: 'hydrate',
      now: 1,
      messages: [
        { role: 'user', text: 'hi', images: [], timestamp: 1 },
        assistant('hello'),
        {
          role: 'bashExecution',
          command: 'ls',
          output: 'a\n',
          exitCode: 0,
          cancelled: false,
          truncated: false,
          excludeFromContext: false,
          timestamp: 3,
        },
        { role: 'compactionSummary', summary: 'compacted', tokensBefore: 10, timestamp: 4 },
      ],
    });
    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
      'shell',
      'compaction',
    ]);
  });

  it('keeps tool arguments and renders an assistant error once when hydrating', () => {
    const failing = {
      ...assistant('I tried.'),
      errorMessage: 'provider unavailable (503)',
      stopReason: 'error' as const,
    };
    const state = reducer(INITIAL_STATE, {
      type: 'hydrate',
      now: 1,
      messages: [
        { role: 'user', text: 'read the file', images: [], timestamp: 1 },
        {
          ...assistant('reading'),
          toolCalls: [{ id: 'call-1', name: 'read', arguments: { path: 'src/a.ts' } }],
        },
        {
          role: 'toolResult',
          toolCallId: 'call-1',
          toolName: 'read',
          text: 'file body',
          details: {},
          isError: false,
          timestamp: 2,
        },
        failing,
      ],
    });
    expect(state.blocks.map((block) => block.kind)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'error',
    ]);
    // The hydrated tool block keeps the arguments from the requesting message.
    expect(state.blocks[2]).toMatchObject({
      kind: 'tool',
      name: 'read',
      args: { path: 'src/a.ts' },
    });
    // The failure text appears exactly once, as its own error block.
    const errorTexts = state.blocks.filter(
      (block) => 'text' in block && block.text === 'provider unavailable (503)',
    );
    expect(errorTexts).toHaveLength(1);
  });

  it('builds the window title from session name and run state', () => {
    const idle: AppState = {
      ...INITIAL_STATE,
      agent: {
        model: null,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        sessionFile: null,
        sessionId: 's',
        sessionName: 'refactor',
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
    };
    expect(windowTitle(idle, idle.settings)).toBe('τ | refactor');
    const running: AppState = { ...idle, snapshot: { ...idle.snapshot, status: 'running' } };
    expect(windowTitle(running, running.settings)).toBe('τ | refactor | running');
  });
});

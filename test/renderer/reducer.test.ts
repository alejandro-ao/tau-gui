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

  it('rejects an authoritative read that describes another session', () => {
    const messages = [
      {
        role: 'user' as const,
        text: 'belongs to the background session',
        images: [],
        timestamp: 1,
      },
    ];

    const stale = reducer(activeState, {
      type: 'hydrate',
      messages,
      now: 1000,
      sessionId: 'background-session',
      runtime: 'tau',
    });
    const otherRuntime = reducer(activeState, {
      type: 'hydrate',
      messages,
      now: 1000,
      sessionId: 'active-session',
      runtime: 'pi',
    });
    const current = reducer(activeState, {
      type: 'hydrate',
      messages,
      now: 1000,
      sessionId: 'active-session',
      runtime: 'tau',
    });

    expect(stale).toBe(activeState);
    expect(otherRuntime).toBe(activeState);
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

  it('keeps narration written before a tool on the activity rail', () => {
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

    const groups = groupBlocks([user, progress, tool]);
    expect(groups.map((group) => group.kind)).toEqual(['user-tools']);
    expect(groups[0]?.kind === 'user-tools' && groups[0].activity.map((entry) => entry.id)).toEqual(
      ['a', tool.id],
    );
  });
});

describe('answer selection', () => {
  const user: TranscriptBlock = { kind: 'user', id: 'u', text: 'inspect', timestamp: 0 };

  const thinking = (id: string, text: string, timestamp: number): TranscriptBlock => ({
    kind: 'thinking',
    id,
    text,
    streaming: false,
    timestamp,
  });

  const message = (id: string, text: string, timestamp: number): TranscriptBlock => ({
    kind: 'assistant',
    id,
    text,
    streaming: false,
    aborted: false,
    timestamp,
  });

  const tool = (id: string): TranscriptBlock => {
    const block = replay([
      { type: 'tool_start', toolCallId: id, toolName: 'read', args: { path: `${id}.ts` } },
      {
        type: 'tool_end',
        toolCallId: id,
        toolName: 'read',
        text: 'body',
        details: {},
        isError: false,
      },
    ]).blocks[0];
    if (!block) throw new Error('expected tool');
    return block;
  };

  it('renders only the closing assistant message as the answer', () => {
    // A reasoning model narrates every step: thinking and narration repeat
    // between tool calls and must never look like separate answers.
    const first = tool('c1');
    const second = tool('c2');
    const groups = groupBlocks([
      user,
      thinking('t1', 'Planning the work.', 1),
      message('n1', 'Exploring the repository.', 2),
      first,
      thinking('t2', 'Reviewing what came back.', 3),
      message('n2', 'Now checking the tests.', 4),
      second,
      message('answer', 'Everything passes.', 5),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['single', 'tools', 'single']);
    const feed = groups[1];
    expect(feed?.kind === 'tools' && feed.activity.map((entry) => entry.id)).toEqual([
      't1',
      'n1',
      first.id,
      't2',
      'n2',
      second.id,
    ]);
    expect(groups[2]).toMatchObject({ kind: 'single', block: { id: 'answer' } });
  });

  it('collapses a reasoning turn that never called a tool', () => {
    const groups = groupBlocks([
      user,
      thinking('t1', 'Weighing the options.', 1),
      message('a', 'Answer.', 2),
    ]);

    expect(groups.map((group) => group.kind)).toEqual(['single', 'tools', 'single']);
    const feed = groups[1];
    expect(feed?.kind === 'tools' && feed.blocks).toHaveLength(0);
    expect(feed?.kind === 'tools' && feed.activity.map((entry) => entry.id)).toEqual(['t1']);
    expect(feed?.kind === 'tools' && feed.id).toBe('t1');
  });

  it('leaves a plain answer standalone and keeps a streaming answer out of the rail', () => {
    expect(groupBlocks([user, message('a', 'Answer.', 1)]).map((group) => group.kind)).toEqual([
      'single',
      'single',
    ]);

    const streaming = groupBlocks([
      user,
      thinking('t1', 'Still reasoning.', 1),
      { ...message('a', 'Partial', 2), streaming: true } as TranscriptBlock,
    ]);
    expect(streaming.map((group) => group.kind)).toEqual(['user-tools', 'single']);
    expect(streaming[1]).toMatchObject({ block: { id: 'a', streaming: true } });
  });

  it('does not fold consecutive answers with no tool call between them', () => {
    // An aborted attempt followed by a retry is durable history, not narration.
    const groups = groupBlocks([
      user,
      { ...message('a1', 'Interrupted.', 1), aborted: true } as TranscriptBlock,
      message('a2', 'Second attempt.', 2),
    ]);
    expect(groups.map((group) => group.kind)).toEqual(['single', 'single', 'single']);
  });
});

describe('lifecycle bookkeeping', () => {
  it('ignores native queue updates and accepts scoped application snapshots', () => {
    const viewed = {
      ...INITIAL_STATE,
      snapshot: {
        ...INITIAL_STATE.snapshot,
        state: { ...INITIAL_STATE.snapshot.state!, sessionId: 'session-1' },
      },
    };
    const native = replay([{ type: 'queue_update', steering: ['native'], followUp: [] }], viewed);
    expect(native.queue.steering).toEqual([]);

    const snapshot = {
      runtime: 'tau' as const,
      sessionId: 'session-1',
      steering: [
        { id: 'prompt-1', kind: 'steering' as const, text: 'repeat' },
        { id: 'prompt-2', kind: 'steering' as const, text: 'repeat' },
      ],
      followUp: [{ id: 'prompt-3', kind: 'follow-up' as const, text: 'later' }],
    };
    const state = reducer(viewed, { type: 'queue', snapshot });
    expect(state.queue).toEqual(snapshot);
    expect(
      reducer(viewed, { type: 'queue', snapshot: { ...snapshot, sessionId: 'background' } }),
    ).toBe(viewed);
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

  it('does not let runtime settle events mutate the application queue', () => {
    const queued: AppState = {
      ...INITIAL_STATE,
      queue: {
        runtime: 'tau',
        sessionId: 'session-1',
        steering: [{ id: 'prompt-1', kind: 'steering', text: 'keep' }],
        followUp: [],
      },
    };
    expect(replay([{ type: 'agent_settled' }], queued).queue).toEqual(queued.queue);
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
    const seeded = {
      ...INITIAL_STATE,
      queue: {
        runtime: 'tau' as const,
        sessionId: 'session-1',
        steering: [{ id: 'prompt-1', kind: 'steering' as const, text: 'x' }],
        followUp: [],
      },
    };
    const cleared = reducer(seeded, { type: 'clearTranscript' });
    expect(cleared.blocks).toEqual([]);
    expect(cleared.queue).toEqual({
      runtime: 'tau',
      sessionId: '',
      steering: [],
      followUp: [],
    });
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
    expect(windowTitle(idle, idle.settings)).toBe('AO | refactor');
    const running: AppState = { ...idle, snapshot: { ...idle.snapshot, status: 'running' } };
    expect(windowTitle(running, running.settings)).toBe('AO | refactor | running');
  });
});

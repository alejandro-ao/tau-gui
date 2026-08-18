import { describe, expect, it } from 'vitest';
import {
  normalizeEntry,
  normalizeEvent,
  normalizeMessage,
  normalizeModel,
  normalizeState,
  normalizeStats,
  normalizeTree,
} from '../src/main/runtime/normalize.js';

describe('normalizeMessage', () => {
  it('normalizes a string-content user message', () => {
    expect(normalizeMessage({ role: 'user', content: 'hi', timestamp: 5 })).toEqual({
      role: 'user',
      text: 'hi',
      images: [],
      timestamp: 5,
    });
  });

  it('normalizes block-content user messages with images', () => {
    const message = normalizeMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', data: 'AAA', mimeType: 'image/png' },
      ],
      timestamp: 1,
    });
    expect(message).toMatchObject({
      text: 'look',
      images: [{ mimeType: 'image/png', data: 'AAA' }],
    });
  });

  it('splits assistant text, thinking, and tool calls', () => {
    const message = normalizeMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'answer' },
        { type: 'toolCall', id: 'c1', name: 'read', arguments: { path: 'a.ts' } },
      ],
      provider: 'openai',
      model: 'gpt',
      stopReason: 'toolUse',
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { total: 0.5 },
      },
      timestamp: 2,
    });
    expect(message).toMatchObject({
      role: 'assistant',
      text: 'answer',
      thinking: 'hmm',
      toolCalls: [{ id: 'c1', name: 'read', arguments: { path: 'a.ts' } }],
      stopReason: 'toolUse',
    });
    expect(message?.role === 'assistant' && message.usage?.cost).toBe(0.5);
  });

  it('normalizes tool results, bash executions, and summaries', () => {
    expect(
      normalizeMessage({
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'out' }],
        details: { exit_code: 0 },
        isError: false,
        timestamp: 1,
      }),
    ).toMatchObject({ role: 'toolResult', text: 'out', isError: false });

    expect(
      normalizeMessage({
        role: 'bashExecution',
        command: 'ls',
        output: 'a',
        exitCode: 0,
        timestamp: 1,
      }),
    ).toMatchObject({ role: 'bashExecution', command: 'ls', exitCode: 0 });

    expect(
      normalizeMessage({ role: 'compactionSummary', summary: 's', tokensBefore: 9, timestamp: 1 }),
    ).toMatchObject({ role: 'compactionSummary', tokensBefore: 9 });
  });

  it('returns null for unknown roles', () => {
    expect(normalizeMessage({ role: 'mystery' })).toBeNull();
  });
});

describe('normalizeEvent', () => {
  it('maps text deltas', () => {
    const event = normalizeEvent({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'text', text: 'ab' }] },
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'b' },
    });
    expect(event).toMatchObject({ type: 'message_delta', kind: 'text', delta: 'b' });
  });

  it('maps thinking deltas', () => {
    const event = normalizeEvent({
      type: 'message_update',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }] },
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'x' },
    });
    expect(event).toMatchObject({ type: 'message_delta', kind: 'thinking', delta: 'x' });
  });

  it('maps tool lifecycle events', () => {
    expect(
      normalizeEvent({
        type: 'tool_execution_start',
        toolCallId: 'c',
        toolName: 'read',
        args: { path: 'x' },
      }),
    ).toEqual({ type: 'tool_start', toolCallId: 'c', toolName: 'read', args: { path: 'x' } });

    expect(
      normalizeEvent({
        type: 'tool_execution_end',
        toolCallId: 'c',
        toolName: 'read',
        result: { content: [{ type: 'text', text: 'body' }], details: { exit_code: 0 } },
        isError: false,
      }),
    ).toEqual({
      type: 'tool_end',
      toolCallId: 'c',
      toolName: 'read',
      text: 'body',
      details: { exit_code: 0 },
      isError: false,
    });
  });

  it('maps queue, compaction, retry, and error records', () => {
    expect(normalizeEvent({ type: 'queue_update', steering: ['a'], followUp: ['b'] })).toEqual({
      type: 'queue_update',
      steering: ['a'],
      followUp: ['b'],
    });
    expect(normalizeEvent({ type: 'compaction_start', reason: 'overflow' })).toEqual({
      type: 'compaction_start',
      reason: 'overflow',
    });
    expect(
      normalizeEvent({
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 2,
        delayMs: 10,
        errorMessage: 'x',
      }),
    ).toEqual({ type: 'retry_start', attempt: 1, maxAttempts: 2, delayMs: 10, message: 'x' });
    expect(normalizeEvent({ type: 'rpc_error', error: 'boom' })).toEqual({
      type: 'runtime_error',
      message: 'boom',
    });
  });

  it('ignores unknown event types', () => {
    expect(normalizeEvent({ type: 'entry_appended', entry: {} })).toBeNull();
    expect(normalizeEvent({ type: 'brand_new_event' })).toBeNull();
  });
});

describe('normalizeState / normalizeStats / normalizeModel', () => {
  it('defaults missing state fields', () => {
    const state = normalizeState({});
    expect(state).toMatchObject({
      model: null,
      thinkingLevel: 'medium',
      isStreaming: false,
      sessionId: '',
      sessionName: null,
    });
  });

  it('normalizes models with cost defaults', () => {
    expect(normalizeModel({ id: 'm', provider: 'p' })).toMatchObject({
      id: 'm',
      name: 'm',
      provider: 'p',
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });

  it('normalizes stats', () => {
    const stats = normalizeStats({
      sessionId: 's',
      tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 },
      cost: 1.5,
      contextUsage: { tokens: 5, contextWindow: 100, percent: 5 },
    });
    expect(stats.tokens.total).toBe(10);
    expect(stats.cost).toBe(1.5);
    expect(stats.contextUsage.percent).toBe(5);
  });
});

describe('entries and trees', () => {
  it('derives a summary for message entries', () => {
    const entry = normalizeEntry({
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2024-01-01T00:00:00Z',
      message: { role: 'user', content: 'do the thing', timestamp: 1 },
    });
    expect(entry).toMatchObject({ id: 'e1', kind: 'message', summary: 'do the thing' });
  });

  it('describes non-message entries', () => {
    expect(
      normalizeEntry({ type: 'model_change', id: 'e2', provider: 'openai', modelId: 'gpt' })
        ?.summary,
    ).toBe('model → openai:gpt');
    expect(normalizeEntry({ type: 'label', id: 'e3', label: 'checkpoint' })?.summary).toBe(
      'checkpoint',
    );
  });

  it('normalizes nested trees', () => {
    const tree = normalizeTree([
      {
        entry: { type: 'message', id: 'a', message: { role: 'user', content: 'x', timestamp: 1 } },
        children: [{ entry: { type: 'label', id: 'b', label: 'l' }, children: [] }],
      },
    ]);
    expect(tree[0]?.children[0]?.entry.id).toBe('b');
  });
});

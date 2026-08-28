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
import { boundJson, MAX_TOOL_OUTPUT_CHARACTERS } from '../src/main/runtime/untrusted.js';
import { INTROSPECTION_LIMITS, toolCatalogSchema } from '../src/shared/introspection.js';

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

  it('strictly bounds untrusted tool output and payloads', () => {
    let getterCalled = false;
    const args = Object.defineProperty({ safe: 'value' }, 'secret', {
      enumerable: true,
      get: () => {
        getterCalled = true;
        return process.env;
      },
    });
    const event = normalizeEvent({
      type: 'tool_execution_end',
      toolCallId: 'c'.repeat(300),
      toolName: 't'.repeat(200),
      result: {
        content: [{ type: 'text', text: 'x'.repeat(MAX_TOOL_OUTPUT_CHARACTERS + 100) }],
        details: { args, huge: 'y'.repeat(10_000) },
      },
      isError: false,
    });

    expect(getterCalled).toBe(false);
    expect(event?.type).toBe('tool_end');
    if (event?.type !== 'tool_end') throw new Error('expected tool end');
    expect(event.toolCallId).toHaveLength(256);
    expect(event.toolName).toHaveLength(128);
    expect(event.text).toContain('[tool output truncated by desktop security limit]');
    expect(event.text.length).toBeLessThan(MAX_TOOL_OUTPUT_CHARACTERS + 100);
    expect(JSON.stringify(event.details).length).toBeLessThan(10_000);
  });

  it('handles hostile descriptors, prototypes, collisions, cycles, and proxies fail closed', () => {
    let arrayGetterCalled = false;
    const array: unknown[] = [];
    Object.defineProperty(array, '0', {
      enumerable: true,
      get: () => {
        arrayGetterCalled = true;
        return process.env;
      },
    });
    Object.defineProperty(array, 'length', { value: 1 });
    expect(boundJson(array)).toEqual({ value: ['[truncated]'], truncated: true });
    expect(arrayGetterCalled).toBe(false);

    const hostile = Object.create({ inherited: process.env }) as Record<string, unknown>;
    Object.defineProperties(hostile, {
      __proto__: { value: 'safe', enumerable: true },
      constructor: { value: 'also safe', enumerable: true },
      a: { value: 1, enumerable: true },
      'a\u0000': { value: 2, enumerable: true },
    });
    hostile['cycle'] = hostile;
    const bounded = boundJson(hostile);
    expect(Object.getPrototypeOf(bounded.value)).toBeNull();
    expect(bounded.value).toMatchObject({ __proto__: 'safe', constructor: 'also safe', a: 1 });
    expect((bounded.value as Record<string, unknown>)['inherited']).toBeUndefined();
    expect((bounded.value as Record<string, unknown>)['cycle']).toBe('[truncated]');
    expect(bounded.truncated).toBe(true);

    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('trap');
        },
      },
    );
    expect(() => boundJson(proxy)).not.toThrow();
    expect(boundJson(proxy)).toEqual({ value: '[truncated]', truncated: true });
  });

  it('enforces aggregate schema limits independently in the shared parser', () => {
    const catalog = (parameters: unknown) => ({
      tools: [
        {
          name: 'x',
          description: '',
          origin: 'test',
          active: true,
          parameters,
          schemaTruncated: false,
        },
      ],
      total: 1,
      truncated: false,
      diagnostics: [],
    });
    expect(
      toolCatalogSchema.safeParse(
        catalog(
          Object.fromEntries(
            Array.from({ length: INTROSPECTION_LIMITS.schemaObjectProperties + 1 }, (_, index) => [
              `p${index}`,
              index,
            ]),
          ),
        ),
      ).success,
    ).toBe(false);
    let deep: Record<string, unknown> = {};
    for (let index = 0; index <= INTROSPECTION_LIMITS.schemaDepth; index += 1) deep = { deep };
    expect(toolCatalogSchema.safeParse(catalog(deep)).success).toBe(false);
    expect(
      toolCatalogSchema.safeParse(catalog(Array.from({ length: 20 }, () => 'é'.repeat(2_000))))
        .success,
    ).toBe(false);
    expect(
      toolCatalogSchema.safeParse(
        catalog(Array.from({ length: 21 }, () => Array.from({ length: 100 }, () => null))),
      ).success,
    ).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(toolCatalogSchema.safeParse(catalog(cyclic)).success).toBe(false);
  });

  it('keeps the truncation marker inside the documented character limit', () => {
    const output = normalizeMessage({
      role: 'toolResult',
      content: 'x'.repeat(MAX_TOOL_OUTPUT_CHARACTERS + 1),
    });
    expect(output?.role).toBe('toolResult');
    if (output?.role !== 'toolResult') throw new Error('expected tool result');
    expect(output.text).toHaveLength(MAX_TOOL_OUTPUT_CHARACTERS);
    expect(output.text).toContain('[tool output truncated by desktop security limit]');
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
    expect(entry).not.toHaveProperty('raw');
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

  it('bounds complete restored entry and tree payloads without retaining raw SDK data', () => {
    const huge = 's'.repeat(2 * 1024 * 1024);
    const wire = {
      type: 'message',
      id: 'tool',
      message: {
        role: 'toolResult',
        toolCallId: 'call',
        toolName: 'read',
        content: huge,
        details: { nested: { secret: huge } },
      },
    };
    const entry = normalizeEntry(wire);
    const tree = normalizeTree([{ entry: wire, children: [] }]);
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThan(140 * 1024);
    expect(Buffer.byteLength(JSON.stringify(tree))).toBeLessThan(140 * 1024);
    expect(JSON.stringify(entry)).not.toContain(huge.slice(0, 100_000));
    expect(entry).not.toHaveProperty('raw');
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

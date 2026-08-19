import { describe, expect, it } from 'vitest';
import type { AgentMessage, AssistantMessage } from '../src/shared/domain.js';
import { deriveSessionUsage } from '../src/shared/session-usage.js';

function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: 'assistant',
    text: 'done',
    thinking: '',
    toolCalls: [],
    provider: 'anthropic',
    model: 'claude-test',
    usage: {
      input: 100,
      cacheRead: 800,
      cacheWrite: 100,
      output: 40,
      reasoning: 10,
      totalTokens: 1050,
      cost: 0.25,
    },
    stopReason: 'stop',
    errorMessage: null,
    timestamp: 1,
    ...overrides,
  };
}

describe('deriveSessionUsage', () => {
  it('matches Tau export prompt, cache, output, cost, tool, and compaction definitions', () => {
    const messages: AgentMessage[] = [
      assistant({ toolCalls: [{ id: '1', name: 'read', arguments: {} }] }),
      assistant({
        toolCalls: [
          { id: '2', name: 'read', arguments: {} },
          { id: '3', name: 'bash', arguments: {} },
        ],
        usage: {
          input: 200,
          cacheRead: 300,
          cacheWrite: 0,
          output: 60,
          reasoning: null,
          totalTokens: 560,
          cost: 0.5,
        },
      }),
      { role: 'compactionSummary', summary: 'shorter', tokensBefore: 1000, timestamp: 2 },
    ];

    const usage = deriveSessionUsage(messages);

    expect(usage.requests.map((request) => request.prompt)).toEqual([1000, 500]);
    expect(usage.totalFresh).toBe(300);
    expect(usage.totalCached).toBe(1100);
    expect(usage.totalCacheWrite).toBe(100);
    expect(usage.totalPrompt).toBe(1500);
    expect(usage.totalOutput).toBe(100);
    expect(usage.totalReasoning).toBe(10);
    expect(usage.cacheHitRate).toBeCloseTo(1100 / 1500);
    expect(usage.reportedCost).toBe(0.75);
    expect(usage.toolCalls).toEqual([
      { name: 'read', count: 2 },
      { name: 'bash', count: 1 },
    ]);
    expect(usage.compactions).toBe(1);
  });

  it('uses honest unavailable states when cache and cost were not reported', () => {
    const usage = deriveSessionUsage([
      assistant({
        usage: {
          input: 50,
          cacheRead: 0,
          cacheWrite: 0,
          output: 5,
          reasoning: null,
          totalTokens: 55,
          cost: null,
        },
      }),
    ]);

    expect(usage.cacheHitRate).toBeNull();
    expect(usage.reportedCost).toBeNull();
  });
});

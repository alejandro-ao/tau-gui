// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, AssistantMessage, SessionStats } from '../../src/shared/domain.js';
import { installFakeBridge, mount, query, type Mounted } from './harness.js';

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const messages: AgentMessage[] = [
  {
    role: 'assistant',
    text: 'complete',
    thinking: '',
    toolCalls: [{ id: 'call-1', name: 'read', arguments: {} }],
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
    timestamp: 1_700_000_000_000,
  },
];

async function render(
  messagesResult: AgentMessage[] = messages,
  stats: SessionStats | null = null,
): Promise<Mounted> {
  installFakeBridge({ stats, results: { 'agent.messages': messagesResult } });
  const { StoreProvider } = await import('../../src/renderer/src/state/store.js');
  const { App } = await import('../../src/renderer/src/App.js');
  const view = await mount(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
  mounted = view;
  await view.flush();
  return view;
}

describe('session usage tab', () => {
  it('switches accessibly between conversation and live usage data', async () => {
    const view = await render();
    const conversation = query<HTMLButtonElement>(view.container, '#tab-conversation');
    const usage = query<HTMLButtonElement>(view.container, '#tab-session-usage');

    expect(conversation.getAttribute('aria-selected')).toBe('true');
    expect(usage.getAttribute('aria-selected')).toBe('false');
    act(() => usage.click());

    expect(usage.getAttribute('aria-selected')).toBe('true');
    expect(
      query(view.container, '[role="tabpanel"]:not([hidden])').getAttribute('aria-labelledby'),
    ).toBe('tab-session-usage');
    expect(view.container.textContent).toContain('Session usage');
    expect(view.container.textContent).toContain('Visible model requests1');
    expect(view.container.textContent).toContain('Visible cache hit rate80.0%');
    expect(view.container.textContent).toContain('Visible prompt input by request');
    expect(view.container.textContent).toContain('Visible output and reasoning tokens');
    expect(view.container.textContent).toContain('Visible tool-name breakdown');
    expect(view.container.textContent).toContain('read1');

    act(() => {
      usage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(conversation.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(conversation);
  });

  it('distinguishes cumulative tool totals from the active transcript after repeated compaction', async () => {
    const stats: SessionStats = {
      sessionFile: '/tmp/session.jsonl',
      sessionId: 'compacted',
      userMessages: 8,
      assistantMessages: 9,
      toolCalls: 14,
      totalMessages: 17,
      tokens: { input: 900, output: 400, cacheRead: 2000, cacheWrite: 100, total: 3400 },
      cost: 1.25,
      contextUsage: { tokens: 3000, contextWindow: 200_000, percent: 1.5 },
    };
    const activeMessages: AgentMessage[] = [
      {
        role: 'compactionSummary',
        summary: 'Only the latest of several summaries remains.',
        tokensBefore: 20_000,
        timestamp: 2,
      },
      ...messages,
    ];
    const view = await render(activeMessages, stats);
    act(() => query<HTMLButtonElement>(view.container, '#tab-session-usage').click());

    expect(view.container.textContent).toContain('Total tool calls14');
    expect(view.container.textContent).toContain('Visible compaction summaries1');
    expect(view.container.textContent).toContain('1 calls remain in the active transcript');
    expect(view.container.textContent).toContain(
      'Older compactions and their per-tool names may have been compacted away.',
    );
  });

  it('bounds chart ticks and mounted table rows while paginating a large session', async () => {
    const largeSession = Array.from({ length: 500 }, (_, index): AssistantMessage => ({
      ...(messages[0] as AssistantMessage),
      toolCalls: [],
      timestamp: 1_700_000_000_000 + index,
    }));
    const view = await render(largeSession);
    act(() => query<HTMLButtonElement>(view.container, '#tab-session-usage').click());

    expect(view.container.querySelectorAll('.usage-x-tick')).toHaveLength(30);
    expect(view.container.querySelectorAll('.usage-table-wrap tbody tr')).toHaveLength(50);
    expect(view.container.textContent).toContain('Showing 1–50 of 500 visible requests');

    act(() =>
      query<HTMLButtonElement>(view.container, '.usage-pagination button:last-child').click(),
    );
    expect(view.container.querySelector('.usage-table-wrap tbody tr td')?.textContent).toBe('51');
    expect(view.container.querySelectorAll('.usage-table-wrap tbody tr')).toHaveLength(50);
    expect(view.container.textContent).toContain('Showing 51–100 of 500 visible requests');
  });

  it('keeps the tab available and explains an empty session', async () => {
    const view = await render([]);
    const usage = query<HTMLButtonElement>(view.container, '#tab-session-usage');
    act(() => usage.click());

    expect(view.container.textContent).toContain(
      'No assistant responses with token usage are available for this session yet.',
    );
  });
});

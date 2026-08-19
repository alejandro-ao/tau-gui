// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../src/shared/domain.js';
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

async function render(messagesResult: AgentMessage[] = messages): Promise<Mounted> {
  installFakeBridge({ results: { 'agent.messages': messagesResult } });
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
    expect(view.container.textContent).toContain('Model requests1');
    expect(view.container.textContent).toContain('Cache hit rate80.0%');
    expect(view.container.textContent).toContain('Prompt input by request');
    expect(view.container.textContent).toContain('Output and reasoning tokens');
    expect(view.container.textContent).toContain('read1');

    act(() => {
      usage.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(conversation.getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(conversation);
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

// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBridge, mount, query, texts, type Mounted } from './harness.js';
import type { AgentState, SessionStats, SidebarPosition } from '../../src/shared/domain.js';
import { versionLabel } from '../../src/renderer/src/components/Sidebar.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const AGENT: AgentState = {
  model: null,
  thinkingLevel: 'medium',
  isStreaming: true,
  isCompacting: false,
  sessionFile: null,
  sessionId: 'abc123',
  sessionName: null,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

const STATS: SessionStats = {
  sessionFile: '/work/project/.tau/session.jsonl',
  sessionId: 'abc123',
  userMessages: 3,
  assistantMessages: 4,
  toolCalls: 9,
  totalMessages: 7,
  tokens: { input: 1000, output: 500, cacheRead: 3000, cacheWrite: 250, total: 4750 },
  cost: null,
  contextUsage: { tokens: 12_000, contextWindow: 200_000, percent: 6 },
};

async function renderApp(options: {
  status?: 'idle' | 'failed';
  detail?: string | null;
  sidebarPosition?: SidebarPosition;
  stats?: SessionStats | null;
  results?: NonNullable<Parameters<typeof installFakeBridge>[0]>['results'];
}): Promise<Mounted> {
  const bridge = installFakeBridge({
    status: options.status ?? 'idle',
    detail: options.detail ?? null,
    settings: { sidebarPosition: options.sidebarPosition ?? 'right' },
    stats: options.stats ?? null,
    results: options.results,
  });
  const { StoreProvider } = await import('../../src/renderer/src/state/store.js');
  const { App } = await import('../../src/renderer/src/App.js');
  const view = await mount(
    <StoreProvider>
      <App />
    </StoreProvider>,
  );
  mounted = view;
  await view.flush();
  bridge.calls.length = 0;
  return view;
}

describe('app shell', () => {
  it('honours the sidebar position setting', async () => {
    const view = await renderApp({ sidebarPosition: 'left' });
    expect(query(view.container, '.app').getAttribute('data-sidebar')).toBe('left');
    expect(view.container.querySelector('.sidebar')).not.toBeNull();
  });

  it('omits the sidebar entirely when disabled', async () => {
    const view = await renderApp({ sidebarPosition: 'off' });
    expect(view.container.querySelector('.sidebar')).toBeNull();
  });

  it('follows the TUI section structure and omits unreported data', async () => {
    const view = await renderApp({});
    const sidebar = query(view.container, '[data-testid="sidebar"]');
    // Title falls back when the session is unnamed.
    expect(query(sidebar, '.sidebar-title').textContent).toContain('untitled session');
    const headers = texts(sidebar, 'h2');
    expect(headers).toContain('activity');
    // Usage/compaction/context wait for runtime data; nothing is fabricated.
    expect(headers).not.toContain('usage');
    expect(headers).not.toContain('context');
    expect(view.container.querySelector('.usage-bar')).toBeNull();
    // The version mark carries the runtime kind and probed version.
    expect(query(view.container, '.version-mark').textContent).toContain('τ = 2π');
    expect(query(view.container, '.version-mark').textContent).toContain('tau 9.9.9-fake');
    // `tau --version` prints "tau 0.3.12"; the footer must not double the name.
    expect(versionLabel('tau', 'tau 0.3.12')).toBe('tau 0.3.12');
    expect(versionLabel('pi', '0.84.2')).toBe('pi 0.84.2');
    expect(versionLabel('pi', null)).toBe('pi');
  });

  it('reports activity, usage, and context like the TUI', async () => {
    const view = await renderApp({ stats: STATS });
    const sidebar = query(view.container, '[data-testid="sidebar"]');
    expect(sidebar.textContent).toContain('3 turns, 9 tool calls');
    expect(sidebar.textContent).toContain('1.0k in, 500 out');
    // No cost reported by the runtime.
    expect(sidebar.textContent).toContain('$N/A');
    // Cache rate is derived locally and marked as estimated.
    expect(sidebar.textContent).toContain('cache: ~75% session');
    expect(query(sidebar, '.usage-context').textContent).toContain('12.0k/200.0k');
    expect(query(sidebar, '.usage-bar').getAttribute('aria-valuenow')).toBe('6');
  });

  it('collapses resource lists behind disclosures', async () => {
    const view = await renderApp({
      results: {
        'commands.list': [
          { name: 'compact', description: 'Compact the session', source: 'runtime' },
          { name: 'review', description: 'Review the tree', source: 'runtime' },
        ],
      },
    });
    const toggle = query<HTMLButtonElement>(view.container, '.disclosure-toggle');
    expect(toggle.textContent).toContain('commands');
    expect(toggle.textContent).toContain('(2)');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelector('.disclosure-body')).toBeNull();
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });
    expect(view.container.querySelector('.disclosure-body')?.textContent).toContain('/compact');
    expect(view.container.querySelector('.disclosure-body')?.textContent).toContain('/review');
  });

  it('shows failure detail with restart and open-directory actions', async () => {
    const view = await renderApp({ status: 'failed', detail: 'spawn tau ENOENT' });
    const notice = query(view.container, '.connection-notice');
    expect(notice.textContent).toContain('spawn tau ENOENT');
    expect(texts(notice, 'button')).toEqual(['open directory', 'restart']);
    expect(query(view.container, '.status-row').getAttribute('data-state')).toBe('failed');
    // The composer remains usable while the runtime is broken.
    expect(view.container.querySelector('textarea')).not.toBeNull();
  });

  it('shows queued steering and follow-up chips', async () => {
    const bridge = installFakeBridge({
      status: 'running',
      capabilities: { steering: true },
      agent: AGENT,
    });
    const { StoreProvider } = await import('../../src/renderer/src/state/store.js');
    const { App } = await import('../../src/renderer/src/App.js');
    const view = await mount(
      <StoreProvider>
        <App />
      </StoreProvider>,
    );
    mounted = view;
    await view.flush();

    await act(async () => {
      bridge.emit({
        type: 'agent',
        sessionId: AGENT.sessionId,
        runtime: 'tau',
        event: { type: 'queue_update', steering: ['use vitest'], followUp: ['then lint'] },
      });
      await Promise.resolve();
    });

    expect(texts(view.container, '.chip')).toEqual([
      'steering: use vitest',
      'follow-up: then lint',
    ]);
    expect(query(view.container, '.activity').textContent).toContain('working…');
  });
});

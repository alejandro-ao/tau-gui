// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBridge, mount, query, texts, type Mounted } from './harness.js';
import type { SessionStats, SidebarPosition } from '../../src/shared/domain.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

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
}): Promise<Mounted> {
  const bridge = installFakeBridge({
    status: options.status ?? 'idle',
    detail: options.detail ?? null,
    settings: { sidebarPosition: options.sidebarPosition ?? 'right' },
    stats: options.stats ?? null,
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

  it('omits sidebar rows the runtime does not report', async () => {
    const view = await renderApp({});
    const labels = texts(view.container, '.sidebar-row dt');
    expect(labels).toContain('runtime');
    expect(labels).not.toContain('name');
    expect(labels).not.toContain('id');
    // Usage only appears once stats exist.
    expect(view.container.querySelector('.usage-bar')).toBeNull();
    expect(query(view.container, '.version-mark').textContent).toContain('τ = 2π');
  });

  it('separates cumulative usage from the live context window', async () => {
    const view = await renderApp({ stats: STATS });
    expect(query(view.container, '.usage-cumulative').textContent).toContain('3/4');
    expect(query(view.container, '.usage-context').textContent).toContain('12.0k/200.0k');
    expect(query(view.container, '.usage-bar').getAttribute('aria-valuenow')).toBe('6');
    // No cost reported by the runtime.
    expect(view.container.textContent).toContain('$N/A');
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
    const bridge = installFakeBridge({ status: 'running', capabilities: { steering: true } });
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

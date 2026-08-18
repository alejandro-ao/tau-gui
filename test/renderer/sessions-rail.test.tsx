// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRef } from '../../src/shared/domain.js';
import { formatRelativeTime } from '../../src/renderer/src/components/format.js';
import { click, renderApp, settle, type RenderedApp } from './ui.js';

const session = (patch: Partial<SessionRef>): SessionRef => ({
  id: 'sess-1',
  name: null,
  path: null,
  cwd: '/work/project',
  runtime: 'tau',
  lastSeen: Date.now(),
  ...patch,
});

const render = (options: Parameters<typeof renderApp>[0]): Promise<RenderedApp> =>
  renderApp(options);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('SessionsRail', () => {
  it('is hidden when the directory has no recent sessions', async () => {
    const { view } = await render({ settings: { recentSessions: [] } });
    expect(view.container.querySelector('[data-testid="sessions-rail"]')).toBeNull();
  });

  it('lists only sessions recorded in the current directory', async () => {
    const { view } = await render({
      settings: {
        recentSessions: [
          session({ id: 'here-1', name: 'local work' }),
          session({ id: 'elsewhere', cwd: '/other/dir', name: 'other project' }),
          session({ id: 'unknown-cwd', cwd: null }),
        ],
      },
    });
    const rail = view.container.querySelector('[data-testid="sessions-rail"]');
    expect(rail?.textContent).toContain('local work');
    expect(rail?.textContent).not.toContain('other project');
    expect(rail?.textContent).not.toContain('unknown-cwd');
  });

  it('marks the active session and shows a runtime badge for foreign runtimes', async () => {
    const { view } = await render({
      agent: {
        model: null,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        sessionFile: null,
        sessionId: 'here-1',
        sessionName: null,
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
      settings: {
        recentSessions: [
          session({ id: 'here-1' }),
          session({ id: 'pi-one', runtime: 'pi', path: '/sessions/pi.jsonl' }),
        ],
      },
    });
    const active = view.container.querySelector('.sessions-rail-item[data-active="true"]');
    expect(active?.textContent).toContain('here-1');
    const items = [...view.container.querySelectorAll('.sessions-rail-item')];
    expect(items[1]?.textContent).toContain('pi ·');
  });

  it('resumes a session in the running runtime by id', async () => {
    const { bridge, view } = await render({
      status: 'idle',
      settings: { recentSessions: [session({ id: 'here-1' })] },
    });
    const item = view.container.querySelector<HTMLButtonElement>('.sessions-rail-item');
    if (!item) throw new Error('sessions rail item missing');
    await click(item);
    await settle(view);
    expect(bridge.payloads('session.switch')).toEqual([{ ref: 'here-1' }]);
    expect(bridge.payloads('runtime.start')).toEqual([]);
  });

  it('resumes a Pi session by path', async () => {
    const { bridge, view } = await render({
      status: 'idle',
      settings: {
        agentRuntime: 'pi',
        recentSessions: [session({ id: 'p1', runtime: 'pi', path: '/sessions/pi.jsonl' })],
      },
    });
    const item = view.container.querySelector<HTMLButtonElement>('.sessions-rail-item');
    if (!item) throw new Error('sessions rail item missing');
    await click(item);
    await settle(view);
    expect(bridge.payloads('session.switch')).toEqual([{ ref: '/sessions/pi.jsonl' }]);
  });

  it('switches the runtime before resuming a foreign-runtime session', async () => {
    const { bridge, view } = await render({
      status: 'idle',
      settings: {
        agentRuntime: 'tau',
        recentSessions: [session({ id: 'p1', runtime: 'pi', path: '/sessions/pi.jsonl' })],
      },
    });
    const item = view.container.querySelector<HTMLButtonElement>('.sessions-rail-item');
    if (!item) throw new Error('sessions rail item missing');
    await click(item);
    await settle(view);
    expect(bridge.payloads('settings.update')).toEqual([{ agentRuntime: 'pi' }]);
    // The fake bridge keeps the snapshot status at idle, so the session switch
    // happens in place rather than through a restart.
    expect(bridge.payloads('session.switch')).toEqual([{ ref: '/sessions/pi.jsonl' }]);
  });

  it('restarts the runtime with the session reference when it is not running', async () => {
    const { bridge, view } = await render({
      status: 'stopped',
      settings: { recentSessions: [session({ id: 'here-1' })] },
    });
    const item = view.container.querySelector<HTMLButtonElement>('.sessions-rail-item');
    if (!item) throw new Error('sessions rail item missing');
    await click(item);
    await settle(view);
    await view.flush();
    expect(bridge.payloads('session.switch')).toEqual([]);
    expect(bridge.payloads('runtime.start')).toEqual([
      { cwd: '/work/project', sessionRef: 'here-1' },
    ]);
  });

  it('forgets a session without resuming it', async () => {
    const { bridge, view } = await render({
      settings: { recentSessions: [session({ id: 'here-1', name: 'local work' })] },
    });
    const forget = view.container.querySelector<HTMLButtonElement>('.sessions-rail-forget');
    if (!forget) throw new Error('forget button missing');
    await click(forget);
    await settle(view);
    expect(bridge.payloads('settings.forgetSession')).toEqual([{ id: 'here-1' }]);
    expect(bridge.payloads('session.switch')).toEqual([]);
  });
});

describe('formatRelativeTime', () => {
  it('formats compact relative timestamps', () => {
    const now = 1_800_000_000_000;
    expect(formatRelativeTime(now - 5_000, now)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(formatRelativeTime(now - 2 * 86_400_000, now)).toBe('2d ago');
    expect(formatRelativeTime(now - 90 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

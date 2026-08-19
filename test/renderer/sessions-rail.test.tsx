// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionRef } from '../../src/shared/domain.js';
import { formatRelativeTime } from '../../src/renderer/src/components/format.js';
import { click, press, renderApp, settle, type RenderedApp } from './ui.js';

const session = (patch: Partial<SessionRef>): SessionRef => {
  const id = patch.id ?? 'sess-1';
  return {
    id,
    name: null,
    firstMessage: `Message for ${id}`,
    messageCount: 1,
    path: null,
    cwd: '/work/project',
    runtime: 'tau',
    lastSeen: Date.now(),
    ...patch,
  };
};

const render = (options: Parameters<typeof renderApp>[0]): Promise<RenderedApp> =>
  renderApp(options);

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('SessionsRail', () => {
  it('stays available for starting a session when there is no history', async () => {
    const { bridge, view } = await render({ settings: { recentSessions: [] } });
    const rail = view.container.querySelector('[data-testid="sessions-rail"]');
    expect(rail?.textContent).toContain('sessions · 0');
    const newSession = rail?.querySelector<HTMLButtonElement>('.sessions-rail-new');
    if (!newSession) throw new Error('new session button missing');
    await click(newSession);
    await settle(view);
    expect(bridge.payloads('session.new')).toEqual([undefined]);
  });

  it('can be resized with its accessible separator', async () => {
    const { view } = await render({ settings: { recentSessions: [] } });
    const rail = view.container.querySelector<HTMLElement>('[data-testid="sessions-rail"]');
    const separator = rail?.querySelector<HTMLElement>('[role="separator"]');
    if (!rail || !separator) throw new Error('resizable sessions rail missing');
    expect(rail.style.flexBasis).toBe('200px');
    await press(separator, 'ArrowRight');
    expect(rail.style.flexBasis).toBe('216px');
    expect(separator.getAttribute('aria-valuenow')).toBe('216');
  });

  it('lists only sessions recorded in the current directory', async () => {
    const { view } = await render({
      settings: {
        recentSessions: [
          session({ id: 'here-1', name: 'local work' }),
          session({ id: 'elsewhere', cwd: '/other/dir', name: 'other project' }),
          session({ id: 'unknown-cwd', cwd: null }),
          session({ id: 'empty', name: 'empty session', messageCount: 0 }),
        ],
      },
    });
    const rail = view.container.querySelector('[data-testid="sessions-rail"]');
    expect(rail?.textContent).toContain('local work');
    expect(rail?.textContent).not.toContain('other project');
    expect(rail?.textContent).not.toContain('unknown-cwd');
    expect(rail?.textContent).not.toContain('empty session');
  });

  it('uses the first user message when a session has no name', async () => {
    const { view } = await render({
      settings: {
        recentSessions: [
          session({
            id: 'opaque-session-id',
            firstMessage: 'Investigate   why the sidebar is slow and fix it',
            messageCount: 2,
          }),
        ],
      },
    });
    const item = view.container.querySelector('.sessions-rail-item');
    expect(item?.textContent).toContain('Investigate why the sidebar is slow and fix it');
    expect(item?.textContent).not.toContain('opaque-sess');
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
    expect(active?.closest('li')?.dataset['active']).toBe('true');
    const items = [...view.container.querySelectorAll('.sessions-rail-item')];
    expect(items[1]?.querySelector('.sessions-rail-runtime')?.textContent).toBe('pi');
    expect(items[1]?.querySelector('.sessions-rail-time')).not.toBeNull();
  });

  it('shows background work and unseen-response indicators', async () => {
    const { bridge, view } = await render({
      settings: {
        recentSessions: [session({ id: 'current' }), session({ id: 'background' })],
      },
    });

    await act(async () => {
      bridge.emit({
        type: 'sessionActivity',
        activity: {
          sessionId: 'background',
          runtime: 'tau',
          status: 'running',
          responseReady: null,
        },
      });
      await Promise.resolve();
    });
    const background = [...view.container.querySelectorAll('.sessions-rail-item')][1];
    const end = background?.querySelector('.sessions-rail-end');
    expect(end?.querySelector('[aria-label="assistant working"]')).not.toBeNull();
    expect(end?.querySelector('.sessions-rail-time')).toBeNull();

    await act(async () => {
      bridge.emit({
        type: 'sessionActivity',
        activity: {
          sessionId: 'background',
          runtime: 'tau',
          status: 'idle',
          responseReady: true,
        },
      });
      await Promise.resolve();
    });
    expect(background?.querySelector('[aria-label="assistant working"]')).toBeNull();
    expect(background?.querySelector('[aria-label="response ready"]')).not.toBeNull();
    expect(background?.querySelector('.sessions-rail-time')).not.toBeNull();
  });

  it('marks a clicked session active while it is opening', async () => {
    let finishSwitch: (() => void) | undefined;
    const switching = new Promise<null>((resolve) => {
      finishSwitch = () => resolve(null);
    });
    const { view } = await render({
      status: 'idle',
      agent: {
        model: null,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        sessionFile: null,
        sessionId: 'current',
        sessionName: null,
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      },
      settings: {
        recentSessions: [session({ id: 'current' }), session({ id: 'next' })],
      },
      results: { 'session.switch': switching },
    });
    const next = [...view.container.querySelectorAll<HTMLButtonElement>('.sessions-rail-item')][1];
    if (!next) throw new Error('next session missing');

    await click(next);

    expect(next.dataset['active']).toBe('true');
    expect(next.dataset['pending']).toBe('true');
    expect(next.getAttribute('aria-busy')).toBe('true');
    finishSwitch?.();
    await settle(view);
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

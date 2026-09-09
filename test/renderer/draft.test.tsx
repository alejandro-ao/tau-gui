// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/domain.js';
import { query, type Mounted } from './harness.js';
import { click, composer, press, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('composer draft persistence', () => {
  it('survives opening and closing a modal', async () => {
    const { view } = await renderApp({});
    mounted = view;
    await type(composer(view), 'half written prompt');

    await press(window, 'k', { ctrlKey: true });
    expect(view.container.querySelector('[data-modal-name="palette"]')).not.toBeNull();
    await press(window, 'Escape');

    expect(composer(view).value).toBe('half written prompt');
  });

  it('presents bundled Pi without a runtime selector and keeps GUI settings', async () => {
    const { view, bridge } = await renderApp({ settings: { theme: 'high-contrast' } });
    mounted = view;
    await type(composer(view), 'draft in embedded pi');

    await press(window, 'k', { ctrlKey: true });
    const picker = query<HTMLInputElement>(view.container, '.picker-input');
    await type(picker, '/settings');
    await press(picker, 'Enter');

    expect(view.container.querySelector('#setting-runtime')).toBeNull();
    expect(query(view.container, '[data-testid="embedded-runtime"]').textContent).toContain(
      'Pi SDK',
    );
    expect(bridge.payloads('settings.update')).toEqual([]);
    expect(composer(view).value).toBe('draft in embedded pi');
    expect(document.documentElement.dataset['theme']).toBe('high-contrast');
  });

  it('adds custom resource directories and restarts Pi so they are loaded', async () => {
    const { view, bridge } = await renderApp({});
    mounted = view;
    bridge.setResult('settings.addResourceDirectory', {
      ...DEFAULT_SETTINGS,
      customSkillDirectories: ['/shared/skills'],
    });

    await press(window, 'k', { ctrlKey: true });
    const picker = query<HTMLInputElement>(view.container, '.picker-input');
    await type(picker, '/settings');
    await press(picker, 'Enter');
    const add = [...view.container.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'add…',
    );
    if (!add) throw new Error('Missing add skills directory button');
    await click(add);
    await view.flush();

    expect(bridge.payloads('settings.addResourceDirectory')).toEqual([{ kind: 'skills' }]);
    expect(bridge.payloads('runtime.restart')).toEqual([undefined]);
  });

  it('keeps a separate draft for each session', async () => {
    const agent = (sessionId: string) => ({
      model: null,
      thinkingLevel: 'medium' as const,
      isStreaming: false,
      isCompacting: false,
      sessionFile: null,
      sessionId,
      sessionName: sessionId,
      autoCompactionEnabled: true,
      messageCount: 0,
      pendingMessageCount: 0,
    });
    const sessions = ['session-a', 'session-b'].map((id, index) => ({
      id,
      name: id,
      path: `/work/project/.tau/${id}.jsonl`,
      cwd: '/work/project',
      runtime: 'tau' as const,
      lastSeen: 1_760_000_000_000 + index,
    }));
    const { view, bridge } = await renderApp({
      agent: agent('session-a'),
      settings: { recentSessions: sessions },
    });
    mounted = view;
    bridge.setHandler('session.switch', (payload) => {
      const sessionId = String(payload?.['ref']);
      bridge.setResult('runtime.snapshot', { ...bridge.snapshot, state: agent(sessionId) });
    });
    const sessionButton = (id: string): HTMLButtonElement => {
      const button = [
        ...view.container.querySelectorAll<HTMLButtonElement>('.sessions-rail-item'),
      ].find((candidate) => candidate.textContent?.includes(id));
      if (!button) throw new Error(`Missing session button for ${id}`);
      return button;
    };

    await type(composer(view), 'draft for A');
    await click(sessionButton('session-b'));
    await view.flush();

    expect(composer(view).value).toBe('');
    await type(composer(view), 'draft for B');
    await click(sessionButton('session-a'));
    await view.flush();

    expect(composer(view).value).toBe('draft for A');
    await click(sessionButton('session-b'));
    await view.flush();

    expect(bridge.payloads('session.switch')).toEqual([
      { ref: 'session-b' },
      { ref: 'session-a' },
      { ref: 'session-b' },
    ]);
    expect(composer(view).value).toBe('draft for B');
  });
});

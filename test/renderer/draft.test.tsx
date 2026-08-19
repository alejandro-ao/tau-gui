// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
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

  it('survives a runtime switch and keeps GUI settings', async () => {
    const { view, bridge } = await renderApp({ settings: { theme: 'high-contrast' } });
    mounted = view;
    await type(composer(view), 'draft across runtimes');

    await press(window, 'k', { ctrlKey: true });
    const picker = query<HTMLInputElement>(view.container, '.picker-input');
    await type(picker, '/settings');
    await press(picker, 'Enter');
    const select = query<HTMLSelectElement>(view.container, '#setting-runtime');
    await act(async () => {
      select.value = 'pi';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await view.flush();

    expect(bridge.payloads('settings.update')).toEqual([{ agentRuntime: 'pi' }]);
    // The runtime is restarted, the transcript cleared, the draft untouched.
    expect(bridge.payloads('runtime.start')).toEqual([{ cwd: null }]);
    expect(composer(view).value).toBe('draft across runtimes');
    expect(document.documentElement.dataset['theme']).toBe('high-contrast');
  });

  it('survives a session switch', async () => {
    const { view, bridge } = await renderApp({
      settings: {
        recentSessions: [
          {
            id: 'session-9',
            name: 'earlier work',
            path: '/work/project/.tau/nine.jsonl',
            cwd: '/work/project',
            runtime: 'tau',
            lastSeen: 1_760_000_000_000,
          },
        ],
      },
    });
    mounted = view;
    await type(composer(view), 'keep this draft');

    await press(window, 'k', { ctrlKey: true });
    const picker = query<HTMLInputElement>(view.container, '.picker-input');
    await type(picker, '/resume');
    await press(picker, 'Enter');
    await click(query(view.container, '[data-modal-name="session"] [role="option"]'));
    await view.flush();

    expect(bridge.payloads('session.switch')).toEqual([{ ref: '/work/project/.tau/nine.jsonl' }]);
    expect(composer(view).value).toBe('keep this draft');
  });
});

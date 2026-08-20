// @vitest-environment jsdom
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

    expect(bridge.payloads('session.switch')).toEqual([{ ref: 'session-9' }]);
    expect(composer(view).value).toBe('keep this draft');
  });
});

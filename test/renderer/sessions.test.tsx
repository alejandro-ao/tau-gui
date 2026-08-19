// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { query, type Mounted } from './harness.js';
import { click, composer, press, renderApp, settle, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

/** Runs a slash command from the composer. */
async function runSlash(view: Mounted, command: string): Promise<void> {
  await type(composer(view), command);
  await press(composer(view), 'Enter');
  await view.flush();
}

describe('session and context flows', () => {
  it('reports compaction outcomes in the transcript', async () => {
    const { view, bridge } = await renderApp({
      results: {
        'session.compact': {
          summary: 'compacted earlier turns',
          firstKeptEntryId: 'e7',
          tokensBefore: 120_000,
          estimatedTokensAfter: 20_000,
        },
      },
    });
    mounted = view;
    await runSlash(view, '/compact');

    expect(bridge.calls.map((call) => call.action)).toContain('session.compact');
    expect(view.container.textContent).toContain('compacted earlier turns');
    expect(view.container.textContent).toContain('120000 → ~20000 tokens');
  });

  it('reports the export destination in the transcript', async () => {
    const { view } = await renderApp({
      results: { 'session.exportHtml': '/tmp/session.html' },
    });
    mounted = view;
    await runSlash(view, '/export');
    expect(view.container.textContent).toContain('Exported session to /tmp/session.html');
  });

  it('starts a new session and clears the transcript without the draft', async () => {
    const { view, bridge } = await renderApp({});
    mounted = view;
    await runSlash(view, '/new');
    expect(bridge.calls.map((call) => call.action)).toContain('session.new');
    expect(composer(view).value).toBe('');
  });

  it('focuses the composer after opening a new session', async () => {
    const { view } = await renderApp({});
    mounted = view;
    const button = query<HTMLButtonElement>(view.container, '.sessions-rail-new');
    button.focus();

    await click(button);
    await settle(view);

    expect(document.activeElement).toBe(composer(view));
  });

  it('focuses the composer after opening an existing session', async () => {
    const { view } = await renderApp({
      settings: {
        recentSessions: [
          {
            id: 'existing',
            name: 'Existing session',
            messageCount: 1,
            path: '/work/project/.tau/existing.jsonl',
            cwd: '/work/project',
            runtime: 'tau',
            lastSeen: Date.now(),
          },
        ],
      },
    });
    mounted = view;
    const button = query<HTMLButtonElement>(view.container, '.sessions-rail-item');
    button.focus();

    await click(button);
    await settle(view);

    expect(document.activeElement).toBe(composer(view));
  });

  it('lists bounded diagnostics with copy support', async () => {
    const { view } = await renderApp({
      results: { 'diagnostics.list': ['tau: started', 'tau: stderr noise'] },
    });
    mounted = view;
    await runSlash(view, '/diagnostics');
    const dialog = query(view.container, '[data-modal-name="diagnostics"]');
    expect(dialog.textContent).toContain('tau: stderr noise');
    expect(query(dialog, '.modal-footer button').textContent).toContain('copy diagnostics');
  });

  it('applies a theme from the theme picker', async () => {
    const { view, bridge } = await renderApp({});
    mounted = view;
    await runSlash(view, '/theme');
    const dialog = query(view.container, '[data-modal-name="theme"]');
    const rows = [...dialog.querySelectorAll('[role="option"]')];
    await click(rows[1]!);
    expect(bridge.payloads('settings.update')).toEqual([{ theme: 'tau-light' }]);
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { query, type Mounted } from './harness.js';
import { click, options, press, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const COMMANDS = [
  { name: 'review', description: 'Review the working tree', source: 'runtime' as const },
];

async function openPalette(capabilities: Record<string, boolean> = {}): Promise<Mounted> {
  const { view } = await renderApp({
    capabilities,
    results: { 'commands.list': COMMANDS },
  });
  mounted = view;
  await press(window, 'k', { ctrlKey: true });
  return view;
}

describe('command palette', () => {
  it('merges runtime, frontend, and quick-setting entries', async () => {
    const view = await openPalette();
    const dialog = query(view.container, '[data-modal-name="palette"]');
    const labels = options(dialog);
    // Runtime-discovered command.
    expect(labels.some((label) => label.startsWith('/review'))).toBe(true);
    // Frontend-only commands and quick settings.
    expect(labels.some((label) => label.startsWith('/hotkeys'))).toBe(true);
    expect(labels.some((label) => label.startsWith('theme: tau-light'))).toBe(true);
    expect(labels.some((label) => label.startsWith('sidebar: off'))).toBe(true);
  });

  it('distinguishes backend, frontend-only, and unavailable entries', async () => {
    const view = await openPalette();
    const rows = [...view.container.querySelectorAll('[role="option"]')];
    const tools = rows.find((row) => row.textContent?.startsWith('/tools'));
    expect(tools?.getAttribute('data-unavailable')).toBe('true');
    expect(tools?.textContent).toContain('tool catalog inspection needs runtime RPC support');
    const hotkeys = rows.find((row) => row.textContent?.startsWith('/hotkeys'));
    expect(hotkeys?.textContent).toContain('frontend');
    const review = rows.find((row) => row.textContent?.startsWith('/review'));
    expect(review?.textContent).toContain('backend');
  });

  it('refuses unavailable entries with the reason instead of failing silently', async () => {
    const view = await openPalette();
    const rows = [...view.container.querySelectorAll('[role="option"]')];
    const tools = rows.find((row) => row.textContent?.startsWith('/tools'));
    await click(tools!);
    // The palette stays open and the reason is surfaced in the transcript.
    expect(view.container.querySelector('[data-modal-name="palette"]')).not.toBeNull();
    expect(view.container.textContent).toContain('tool catalog inspection needs runtime RPC');
  });

  it('runs a frontend command and gates the tree entry on capabilities', async () => {
    const view = await openPalette({ sessionTree: false });
    const input = query<HTMLInputElement>(view.container, '.picker-input');
    await type(input, 'tree');
    const row = query(view.container, '[role="option"]');
    expect(row.getAttribute('data-unavailable')).toBe('true');

    await type(input, 'hotkeys');
    await press(input, 'Enter');
    expect(query(view.container, '[data-modal-name="hotkeys"]').textContent).toContain('Ctrl+K');
  });
});

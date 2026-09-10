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
    results: { 'commands.list': COMMANDS, 'thinking.list': ['medium'] },
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
    expect(labels.some((label) => label.startsWith('theme: pure-black'))).toBe(true);
    expect(labels.some((label) => label.startsWith('sidebar: off'))).toBe(true);
  });

  it('hides origin badges on slash rows while preserving other badges', async () => {
    const view = await openPalette();
    const dialog = query(view.container, '[data-modal-name="palette"]');
    const rows = [...dialog.querySelectorAll('[role="option"]')];
    const rowStartingWith = (label: string): Element | undefined =>
      rows.find((row) => row.textContent?.startsWith(label));
    const badge = (row: Element | undefined): string | null | undefined =>
      row?.querySelector('.picker-badge')?.textContent;

    const tools = rowStartingWith('/tools');
    expect(tools?.getAttribute('data-unavailable')).toBe('true');
    expect(badge(tools)).toBe('unavailable');
    expect(tools?.textContent).toContain(
      'tool catalog inspection is not exposed by the desktop application contract',
    );

    expect(badge(rowStartingWith('/hotkeys'))).toBeUndefined();
    expect(badge(rowStartingWith('/new'))).toBeUndefined();
    expect(badge(rowStartingWith('/review'))).toBe('unavailable');
    expect(badge(rowStartingWith('theme: tau-light'))).toBe('frontend');
    expect(badge(rowStartingWith('thinking: medium'))).toBe('backend');
    expect(dialog.textContent).not.toContain('backend entries need the runtime');
  });

  it('refuses unavailable entries with the reason instead of failing silently', async () => {
    const view = await openPalette();
    const rows = [...view.container.querySelectorAll('[role="option"]')];
    const tools = rows.find((row) => row.textContent?.startsWith('/tools'));
    await click(tools!);
    // The palette stays open and the reason is surfaced in the transcript.
    expect(view.container.querySelector('[data-modal-name="palette"]')).not.toBeNull();
    expect(view.container.textContent).toContain(
      'tool catalog inspection is not exposed by the desktop application contract',
    );
  });

  it('restores focus to the element that opened it', async () => {
    const { view } = await renderApp({});
    mounted = view;
    const input = query<HTMLTextAreaElement>(view.container, 'textarea.composer-input');
    input.focus();
    await press(window, 'k', { ctrlKey: true });
    expect(view.container.ownerDocument.activeElement).not.toBe(input);
    await press(window, 'Escape');
    expect(view.container.ownerDocument.activeElement).toBe(input);
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

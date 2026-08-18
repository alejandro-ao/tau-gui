// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { query, texts, type FakeBridge, type Mounted } from './harness.js';
import { click, composer, options, press, renderApp, selectedOption, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const COMMANDS = [
  { name: 'review', description: 'Review the working tree', source: 'runtime' as const },
];

async function open(): Promise<{ view: Mounted; bridge: FakeBridge; input: HTMLTextAreaElement }> {
  const { view, bridge } = await renderApp({
    capabilities: { directBash: true },
    results: { 'commands.list': COMMANDS },
  });
  mounted = view;
  return { view, bridge, input: composer(view) };
}

function actionsOf(bridge: FakeBridge): string[] {
  return bridge.calls.map((call) => call.action).filter((action) => !action.startsWith('ui.'));
}

describe('slash command completion', () => {
  it('merges runtime and frontend commands and filters fuzzily', async () => {
    const { view, input } = await open();
    await type(input, '/mod');
    const popup = query(view.container, '[data-testid="completion-slash"]');
    expect(options(popup)[0]).toContain('/model');

    await type(input, '/rev');
    expect(texts(view.container, '.completion-label')).toContain('/review');
  });

  it('navigates with Up/Down and accepts with Enter', async () => {
    const { view, input } = await open();
    await type(input, '/s');
    const first = selectedOption(view.container);
    await press(input, 'ArrowDown');
    expect(selectedOption(view.container)).not.toBe(first);
    await press(input, 'ArrowUp');
    expect(selectedOption(view.container)).toBe(first);

    await type(input, '/hotkeys');
    await press(input, 'Enter');
    expect(view.container.querySelector('[data-modal-name="hotkeys"]')).not.toBeNull();
    // Running a command clears the draft.
    expect(composer(view).value).toBe('');
  });

  it('completes the draft text with Tab without running the command', async () => {
    const { view, input } = await open();
    await type(input, '/mode');
    await press(input, 'Tab');
    expect(composer(view).value).toBe('/model ');
    expect(view.container.querySelector('[data-modal-name="model"]')).toBeNull();
  });

  it('accepts a mouse click', async () => {
    const { view, input } = await open();
    await type(input, '/theme');
    await click(query(view.container, '.completion-option'));
    expect(view.container.querySelector('[data-modal-name="theme"]')).not.toBeNull();
  });

  it('dismisses with Escape and keeps the draft', async () => {
    const { view, input } = await open();
    await type(input, '/mod');
    await press(input, 'Escape');
    expect(view.container.querySelector('[data-testid="completion-slash"]')).toBeNull();
    expect(composer(view).value).toBe('/mod');
  });

  it('reports the reason for capability-gated commands instead of failing silently', async () => {
    const { view, input, bridge } = await open();
    await type(input, '/tools');
    const row = query(view.container, '.completion-option');
    expect(row.getAttribute('data-unavailable')).toBe('true');
    await press(input, 'Enter');
    expect(view.container.textContent).toContain('tool catalog inspection needs runtime RPC');
    expect(actionsOf(bridge)).not.toContain('agent.prompt');
  });

  it('sends unknown slash input as a normal prompt', async () => {
    const { view, input, bridge } = await open();
    await type(input, '/definitely-not-a-command');
    expect(view.container.querySelector('[data-testid="completion-slash"]')).toBeNull();
    await press(input, 'Enter');
    expect(bridge.payloads('agent.prompt')).toEqual([{ text: '/definitely-not-a-command' }]);
  });
});

describe('@ file completion', () => {
  it('inserts the selected path at the cursor, quoting spaces', async () => {
    const { view, bridge } = await renderApp({
      results: {
        'fs.complete': [
          { path: 'src/a b.ts', isDirectory: false },
          { path: 'src/nested', isDirectory: true },
        ],
      },
    });
    mounted = view;
    const input = composer(view);
    await type(input, 'look at @a b');
    await moveCursor(input, 10);
    await waitForPopup(view);

    expect(bridge.payloads('fs.complete')).toEqual([{ query: 'a' }]);
    const popup = query(view.container, '[data-testid="completion-path"]');
    expect(options(popup)[0]).toContain('src/a b.ts');

    await press(input, 'Enter');
    // The `@a` token is replaced; the rest of the draft survives.
    expect(composer(view).value).toBe('look at "src/a b.ts" b');
  });

  it('keeps directories open for further completion', async () => {
    const { view } = await renderApp({
      results: { 'fs.complete': [{ path: 'src/nested', isDirectory: true }] },
    });
    mounted = view;
    const input = composer(view);
    await type(input, '@nest');
    await waitForPopup(view);
    await press(input, 'Tab');
    expect(composer(view).value).toBe('src/nested/');
  });
});

/** Moves the caret the way a click or arrow key would. */
async function moveCursor(input: HTMLTextAreaElement, position: number): Promise<void> {
  await act(async () => {
    input.setSelectionRange(position, position);
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    await Promise.resolve();
  });
}

/** The completion request is debounced in the renderer. */
async function waitForPopup(view: Mounted): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
  });
  await view.flush();
}

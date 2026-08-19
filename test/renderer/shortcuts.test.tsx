// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { query, type FakeBridge, type Mounted } from './harness.js';
import { composer, press, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function actionsOf(bridge: FakeBridge): string[] {
  return bridge.calls.map((call) => call.action).filter((action) => !action.startsWith('ui.'));
}

/** Dispatches Shift+Tab from a specific element and returns the event. */
async function dispatchTab(target: Element): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
  return event;
}

describe('global shortcuts', () => {
  it('dispatches every documented shortcut', async () => {
    const { view, bridge } = await renderApp({});
    mounted = view;

    await press(window, 'p', { ctrlKey: true });
    expect(actionsOf(bridge)).toContain('models.cycle');

    bridge.calls.length = 0;
    await press(window, 'Tab', { shiftKey: true });
    expect(actionsOf(bridge)).toContain('thinking.cycle');

    bridge.calls.length = 0;
    await press(window, 't', { ctrlKey: true });
    expect(bridge.payloads('settings.update')).toEqual([{ showThinking: false }]);

    bridge.calls.length = 0;
    bridge.setResult('fs.pickDirectory', '/work/shortcut');
    await press(window, 'n', { ctrlKey: true, shiftKey: true });
    expect(actionsOf(bridge)).toContain('fs.pickDirectory');
    expect(actionsOf(bridge)).toContain('settings.rememberWorkingDirectory');
    expect(bridge.payloads('runtime.start')).toContainEqual({ cwd: '/work/shortcut' });
    expect(actionsOf(bridge)).not.toContain('session.new');

    bridge.calls.length = 0;
    await press(window, 'r', { ctrlKey: true });
    expect(actionsOf(bridge)).toContain('runtime.start');
    // Ctrl+O has no IPC surface; expansion.test.tsx covers its transcript effect.
    expect(query(view.container, '.app')).toBeTruthy();
  });

  it('accepts Cmd as the accelerator on darwin', async () => {
    // The fake bridge reports platform 'darwin'.
    const { view, bridge } = await renderApp({});
    mounted = view;
    await press(window, 'p', { metaKey: true });
    expect(actionsOf(bridge)).toContain('models.cycle');
  });

  it('opens the palette with Ctrl+K and closes the top modal with Escape', async () => {
    const { view } = await renderApp({});
    mounted = view;
    await press(window, 'k', { ctrlKey: true });
    expect(view.container.querySelector('[data-modal-name="palette"]')).not.toBeNull();
    await press(window, 'Escape');
    expect(view.container.querySelector('[data-modal-name="palette"]')).toBeNull();
  });

  it('leaves runtime shortcuts alone while a modal owns the keyboard', async () => {
    const { view, bridge } = await renderApp({});
    mounted = view;
    await press(window, 'k', { ctrlKey: true });
    bridge.calls.length = 0;
    await press(window, 'n', { ctrlKey: true, shiftKey: true });
    await press(window, 'Tab', { shiftKey: true });
    expect(actionsOf(bridge)).toEqual([]);
  });

  it('keeps Escape aborting the run when no modal is open', async () => {
    const { view, bridge } = await renderApp({ status: 'running' });
    mounted = view;
    await press(composer(view), 'Escape');
    expect(actionsOf(bridge)).toContain('agent.abort');
  });

  it('cycles thinking on Shift+Tab from the composer but not from other controls', async () => {
    const { view, bridge } = await renderApp({});
    mounted = view;

    composer(view).focus();
    bridge.calls.length = 0;
    const fromComposer = await dispatchTab(composer(view));
    expect(actionsOf(bridge)).toContain('thinking.cycle');
    expect(fromComposer.defaultPrevented).toBe(true);

    // A focused button keeps native reverse tab navigation.
    const button = query<HTMLButtonElement>(view.container, '.sidebar .ghost-button');
    button.focus();
    bridge.calls.length = 0;
    const fromButton = await dispatchTab(button);
    expect(actionsOf(bridge)).toEqual([]);
    expect(fromButton.defaultPrevented).toBe(false);

    // Nothing focused (document.body) still cycles.
    button.blur();
    bridge.calls.length = 0;
    const fromBody = await dispatchTab(view.container.ownerDocument.body);
    expect(actionsOf(bridge)).toContain('thinking.cycle');
    expect(fromBody.defaultPrevented).toBe(true);
  });

  it('never binds Ctrl+C while a transcript selection exists', async () => {
    const { view } = await renderApp({});
    mounted = view;
    const input = composer(view);
    await type(input, 'keep me');
    const selection = window.getSelection();
    const node = view.container.ownerDocument.createTextNode('selected transcript text');
    view.container.append(node);
    const range = view.container.ownerDocument.createRange();
    range.selectNode(node);
    selection?.removeAllRanges();
    selection?.addRange(range);

    await press(input, 'c', { ctrlKey: true });
    expect(composer(view).value).toBe('keep me');
    selection?.removeAllRanges();
  });
});

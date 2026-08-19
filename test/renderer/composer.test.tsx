// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  installFakeBridge,
  mount,
  query,
  type FakeBridge,
  type InvokeCall,
  type Mounted,
} from './harness.js';
import type { RuntimeCapabilities } from '../../src/shared/domain.js';

const ALL_CAPABILITIES: Partial<RuntimeCapabilities> = {
  steering: true,
  followUps: true,
  directBash: true,
};

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function renderComposer(options: {
  status?: 'idle' | 'running';
  capabilities?: Partial<RuntimeCapabilities>;
}): Promise<{ bridge: FakeBridge; input: HTMLTextAreaElement; view: Mounted }> {
  const bridge = installFakeBridge({
    status: options.status ?? 'idle',
    capabilities: options.capabilities ?? ALL_CAPABILITIES,
  });
  // Imported lazily so the fake bridge exists before the store bootstraps.
  const { StoreProvider } = await import('../../src/renderer/src/state/store.js');
  const { Composer } = await import('../../src/renderer/src/components/Composer.js');
  const view = await mount(
    <StoreProvider>
      <Composer />
    </StoreProvider>,
  );
  mounted = view;
  await view.flush();
  bridge.calls.length = 0;
  return { bridge, input: query<HTMLTextAreaElement>(view.container, 'textarea'), view };
}

async function type(input: HTMLTextAreaElement, value: string): Promise<void> {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
  // The native setter is required so React's value tracker still emits onChange.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const setValue = descriptor?.set;
  await act(async () => {
    if (setValue) Reflect.apply(setValue, input, [value]);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function press(
  input: HTMLTextAreaElement,
  key: string,
  modifiers: Partial<KeyboardEventInit> = {},
): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...modifiers }));
    await Promise.resolve();
  });
}

/** Window-title refreshes are incidental to composer behaviour. */
function agentCalls(bridge: FakeBridge): InvokeCall[] {
  return bridge.calls.filter((call) => !call.action.startsWith('ui.'));
}

function actions(bridge: FakeBridge): string[] {
  return agentCalls(bridge).map((call) => call.action);
}

describe('Composer key handling', () => {
  it('submits a prompt on Enter and clears the editor', async () => {
    const { bridge, input } = await renderComposer({});
    await type(input, 'hello world');
    await press(input, 'Enter');

    expect(agentCalls(bridge)).toEqual([
      { action: 'agent.prompt', payload: { text: 'hello world' } },
    ]);
    expect(input.value).toBe('');
  });

  it('does not submit on Shift+Enter', async () => {
    const { bridge, input } = await renderComposer({});
    await type(input, 'line one');
    await press(input, 'Enter', { shiftKey: true });

    expect(actions(bridge)).not.toContain('agent.prompt');
    expect(input.value).toBe('line one');
  });

  it('steers with Enter while a run is active', async () => {
    const { bridge, input } = await renderComposer({ status: 'running' });
    await type(input, 'focus on tests');
    await press(input, 'Enter');

    expect(agentCalls(bridge)).toEqual([
      { action: 'agent.steer', payload: { text: 'focus on tests' } },
    ]);
  });

  it('queues a follow-up with Alt+Enter', async () => {
    const { bridge, input } = await renderComposer({ status: 'running' });
    await type(input, 'then run lint');
    await press(input, 'Enter', { altKey: true });

    expect(agentCalls(bridge)).toEqual([
      { action: 'agent.followUp', payload: { text: 'then run lint' } },
    ]);
  });

  it('falls back to follow-ups when steering is unsupported', async () => {
    const { bridge, input } = await renderComposer({
      status: 'running',
      capabilities: { steering: false, followUps: true, directBash: true },
    });
    await type(input, 'do this next');
    await press(input, 'Enter');

    expect(actions(bridge)).toEqual(['agent.followUp']);
  });

  it('aborts with Escape while running', async () => {
    const { bridge, input } = await renderComposer({ status: 'running' });
    await press(input, 'Escape');

    expect(actions(bridge)).toEqual(['agent.abort']);
  });

  it('replaces the tau prompt with a spinner and renders an icon-only abort while running', async () => {
    const { bridge, view } = await renderComposer({ status: 'running' });
    const abort = query<HTMLButtonElement>(view.container, '[aria-label="abort run"]');
    const prefix = query(view.container, '.composer-prefix');

    expect(prefix.querySelector('[aria-label="Model working"]')).not.toBeNull();
    expect(prefix.textContent).not.toContain('τ');
    expect(abort.textContent?.trim()).toBe('');
    expect(abort.querySelector('svg')).not.toBeNull();
    expect(
      view.container.querySelector('.composer-input')?.getAttribute('placeholder'),
    ).not.toContain('Esc');
    act(() => abort.click());
    expect(actions(bridge)).toEqual(['agent.abort']);
  });

  it('routes ! and !! through the shell action', async () => {
    const { bridge, input } = await renderComposer({});
    await type(input, '!ls -la');
    expect(query(input.ownerDocument.body, '.composer').getAttribute('data-shell')).toBe('true');
    expect(query(input.ownerDocument.body, '.composer-prefix').textContent).toBe('$');
    await press(input, 'Enter');
    expect(agentCalls(bridge)).toEqual([
      { action: 'shell.run', payload: { command: 'ls -la', excludeFromContext: false } },
    ]);

    bridge.calls.length = 0;
    await type(input, '!!git status');
    await press(input, 'Enter');
    expect(agentCalls(bridge)).toEqual([
      { action: 'shell.run', payload: { command: 'git status', excludeFromContext: true } },
    ]);
  });

  it('refuses shell mode when the runtime lacks direct bash', async () => {
    const { bridge, input, view } = await renderComposer({
      capabilities: { steering: true, followUps: true, directBash: false },
    });
    await type(input, '!ls');
    expect(query(view.container, '.composer-hint').textContent).toBe('shell unavailable');
    await press(input, 'Enter');

    expect(actions(bridge)).not.toContain('shell.run');
  });

  it('recalls the last submitted prompt with Up on an empty editor', async () => {
    const { input } = await renderComposer({});
    await type(input, 'first prompt');
    await press(input, 'Enter');
    expect(input.value).toBe('');

    await press(input, 'ArrowUp');
    expect(input.value).toBe('first prompt');
  });

  it('undoes and redoes an Up Arrow history replacement', async () => {
    const { input } = await renderComposer({});
    await type(input, 'first prompt');
    await press(input, 'Enter');
    await press(input, 'ArrowUp');
    expect(input.value).toBe('first prompt');

    await press(input, 'z', { ctrlKey: true });
    expect(input.value).toBe('');

    await press(input, 'y', { ctrlKey: true });
    expect(input.value).toBe('first prompt');
  });

  it('undoes deleted text with the platform modifier', async () => {
    const { input } = await renderComposer({});
    await type(input, 'accidental deletion');
    await type(input, 'accidental ');

    await press(input, 'z', { ctrlKey: true });
    expect(input.value).toBe('accidental deletion');
  });

  it('clears the editor with Ctrl+C when nothing is selected', async () => {
    const { bridge, input } = await renderComposer({});
    await type(input, 'scratch text');
    await press(input, 'c', { ctrlKey: true });

    expect(input.value).toBe('');
    expect(actions(bridge)).toHaveLength(0);
  });

  it('undoes a cleared draft and redoes it with the macOS shortcuts', async () => {
    const { input } = await renderComposer({});
    await type(input, 'scratch text');
    await press(input, 'c', { ctrlKey: true });

    await press(input, 'z', { metaKey: true });
    expect(input.value).toBe('scratch text');

    await press(input, 'z', { metaKey: true, shiftKey: true });
    expect(input.value).toBe('');
  });
});

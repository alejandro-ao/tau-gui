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
import type { AgentState, RuntimeCapabilities } from '../../src/shared/domain.js';

const AGENT: AgentState = {
  model: null,
  thinkingLevel: 'medium',
  isStreaming: false,
  isCompacting: false,
  sessionFile: null,
  sessionId: 'session-1',
  sessionName: null,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

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
  agent?: AgentState;
}): Promise<{ bridge: FakeBridge; input: HTMLTextAreaElement; view: Mounted }> {
  const bridge = installFakeBridge({
    status: options.status ?? 'idle',
    capabilities: options.capabilities ?? ALL_CAPABILITIES,
    agent: options.agent,
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

  it('keeps app-owned priority guidance when native steering is unsupported', async () => {
    const { bridge, input } = await renderComposer({
      status: 'running',
      capabilities: { steering: false, followUps: true, directBash: true },
    });
    await type(input, 'do this next');
    await press(input, 'Enter');

    expect(actions(bridge)).toEqual(['agent.steer']);
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

  it('atomically pops queued text for editing and only requeues it after Enter', async () => {
    const { bridge, input } = await renderComposer({ status: 'running', agent: AGENT });
    bridge.setHandler('queue.pop', () => ({
      id: 'prompt-7',
      kind: 'follow-up',
      text: 'queued draft',
    }));

    await press(input, 'ArrowUp');
    expect(input.value).toBe('queued draft');
    expect(actions(bridge)).toEqual(['queue.pop', 'queue.resolve']);
    expect(bridge.payloads('queue.resolve')).toEqual([{ id: 'prompt-7', outcome: 'accept' }]);

    await type(input, 'edited draft');
    expect(actions(bridge)).toEqual(['queue.pop', 'queue.resolve']);
    await press(input, 'Enter');
    expect(actions(bridge)).toEqual(['queue.pop', 'queue.resolve', 'agent.steer']);
    expect(bridge.payloads('agent.steer')).toEqual([{ text: 'edited draft' }]);
  });

  it('restores a claimed duplicate when newer draft input arrives before recall', async () => {
    const { bridge, input, view } = await renderComposer({ status: 'running', agent: AGENT });
    let release: ((item: unknown) => void) | undefined;
    bridge.setHandler(
      'queue.pop',
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    await press(input, 'ArrowUp');
    await type(input, 'duplicate');
    release?.({ id: 'prompt-8', kind: 'follow-up', text: 'duplicate' });
    await view.flush();

    expect(input.value).toBe('duplicate');
    expect(bridge.payloads('queue.resolve')).toEqual([{ id: 'prompt-8', outcome: 'restore' }]);
  });

  it('restores a claim when navigation completes while recall IPC is in flight', async () => {
    const { bridge, input, view } = await renderComposer({ status: 'running', agent: AGENT });
    let release: ((item: unknown) => void) | undefined;
    bridge.setHandler(
      'queue.pop',
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );

    await press(input, 'ArrowUp');
    act(() => {
      bridge.emit({
        type: 'status',
        snapshot: { ...bridge.snapshot, state: { ...AGENT, sessionId: 'session-2' } },
      });
    });
    release?.({ id: 'prompt-9', kind: 'steering', text: 'old session' });
    await view.flush();

    expect(input.value).toBe('');
    expect(bridge.calls.find((call) => call.action === 'queue.pop')?.session).toEqual({
      runtime: 'tau',
      sessionId: 'session-1',
    });
    expect(bridge.calls.find((call) => call.action === 'queue.resolve')?.session).toEqual({
      runtime: 'tau',
      sessionId: 'session-1',
    });
    expect(bridge.payloads('queue.resolve')).toEqual([{ id: 'prompt-9', outcome: 'restore' }]);
  });

  it('recalls the last submitted prompt with Up on an empty editor when the queue is empty', async () => {
    const { input } = await renderComposer({});
    await type(input, 'first prompt');
    await press(input, 'Enter');
    expect(input.value).toBe('');

    await press(input, 'ArrowUp');
    expect(input.value).toBe('first prompt');
  });

  it('clears the editor with Ctrl+C when nothing is selected', async () => {
    const { bridge, input } = await renderComposer({});
    await type(input, 'scratch text');
    await press(input, 'c', { ctrlKey: true });

    expect(input.value).toBe('');
    expect(actions(bridge)).toHaveLength(0);
  });
});

// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBridge, mount, query, type Mounted } from './harness.js';
import type { Action, TranscriptBlock } from '../../src/renderer/src/state/types.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function tool(id: string): TranscriptBlock {
  return {
    kind: 'tool',
    id,
    toolCallId: id,
    name: 'bash',
    args: { command: 'ls', description: 'List files' },
    output: 'a.ts',
    state: 'success',
    startedAt: 0,
    endedAt: 0,
    timestamp: 0,
  };
}

async function renderAppWithTools(ids: string[]): Promise<Mounted> {
  installFakeBridge({ status: 'idle', capabilities: { directBash: true } });
  const { StoreProvider, useStore } = await import('../../src/renderer/src/state/store.js');
  const { App } = await import('../../src/renderer/src/App.js');
  const captured: { dispatch: ((action: Action) => void) | null } = { dispatch: null };

  function Capture(): ReactNode {
    captured.dispatch = useStore().dispatch;
    return null;
  }

  const view = await mount(
    <StoreProvider>
      <Capture />
      <App />
    </StoreProvider>,
  );
  mounted = view;
  await view.flush();

  const dispatch = captured.dispatch;
  if (!dispatch) throw new Error('store dispatch was not captured');
  await act(async () => {
    for (const id of ids) dispatch({ type: 'localMessage', block: tool(id) });
    await Promise.resolve();
  });
  return view;
}

async function pressCtrlO(): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true }));
    await Promise.resolve();
  });
}

describe('tool expansion', () => {
  it('toggles one block on click and all blocks with Ctrl+O', async () => {
    const view = await renderAppWithTools(['tool-a', 'tool-b']);
    expect(view.container.querySelectorAll('.tool-args')).toHaveLength(0);

    await act(async () => {
      query(view.container, '.tool-run-header').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      query(view.container, '.block-header').dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(view.container.querySelectorAll('.tool-args')).toHaveLength(1);

    // Ctrl+O flips the global default and drops per-block overrides.
    await pressCtrlO();
    expect(view.container.querySelectorAll('.tool-args')).toHaveLength(2);

    await pressCtrlO();
    expect(view.container.querySelectorAll('.tool-args')).toHaveLength(0);
  });
});

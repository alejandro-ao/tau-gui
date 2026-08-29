// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionSummary } from '../../src/shared/domain.js';
import type { Actions } from '../../src/renderer/src/state/store.js';
import { installFakeBridge, mount, type Mounted } from './harness.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const persisted: SessionSummary = {
  id: `pi-${'a'.repeat(32)}`,
  source: 'native',
  runtime: 'pi',
  sessionId: 'persisted-session',
  exportable: true,
  name: 'saved work',
  firstMessage: null,
  cwd: '/private/project/path',
  createdAt: 1,
  modifiedAt: 2,
  messageCount: 1,
  parentSessionId: null,
};

describe('session activation routing', () => {
  it('bootstraps one fresh runtime under development StrictMode', async () => {
    const bridge = installFakeBridge({ status: 'stopped' });
    const { StoreProvider } = await import('../../src/renderer/src/state/store.js');
    const view = await mount(
      <StrictMode>
        <StoreProvider>
          <div />
        </StoreProvider>
      </StrictMode>,
    );
    mounted = view;
    await view.flush();

    expect(bridge.calls.filter((call) => call.action === 'runtime.start')).toHaveLength(1);
    expect(bridge.calls.filter((call) => call.action === 'session.switch')).toHaveLength(0);
  });

  it('blocks direct renderer activation helpers without IPC, runtime change, or pathname notice', async () => {
    const bridge = installFakeBridge({ runtime: 'pi', status: 'idle' });
    const { StoreProvider, useStore } = await import('../../src/renderer/src/state/store.js');
    const { ConnectionNotice } =
      await import('../../src/renderer/src/components/ConnectionNotice.js');
    let actions: Actions | null = null;

    function Capture(): ReactNode {
      actions = useStore().actions;
      return null;
    }

    const view = await mount(
      <StoreProvider>
        <Capture />
        <ConnectionNotice />
      </StoreProvider>,
    );
    mounted = view;
    await view.flush();
    bridge.calls.length = 0;

    const storeActions = actions as Actions | null;
    if (!storeActions) throw new Error('store actions were not captured');
    await act(async () => {
      await storeActions.switchSession('/stale/renderer/path.jsonl');
      await storeActions.resumeSession(persisted);
    });

    expect(bridge.calls).toEqual([]);
    expect(view.container.textContent).not.toContain('/stale/renderer/path.jsonl');
    expect(view.container.textContent).not.toContain('/private/project/path');
  });
});

// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import type { AuthFlow } from '../../src/shared/auth.js';
import { StoreProvider, useStore, type Store } from '../../src/renderer/src/state/store.js';
import { installFakeBridge, mount, type Mounted } from './harness.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const running: AuthFlow = {
  id: 'flow-1',
  providerId: 'fake',
  providerName: 'Fake Provider',
  authType: 'api_key',
  revision: 0,
  status: 'running',
  prompt: null,
  notices: [],
  message: 'Starting API key setup…',
};

function newerFlow(status: 'prompt' | 'succeeded' | 'failed' | 'cancelled'): AuthFlow {
  return {
    ...running,
    revision: 1,
    status,
    prompt:
      status === 'prompt' ? { id: 'prompt-1', type: 'secret', message: 'Enter API key' } : null,
    message:
      status === 'prompt'
        ? null
        : status === 'succeeded'
          ? 'Saved'
          : status === 'failed'
            ? 'Failed'
            : 'Cancelled',
  };
}

describe('renderer auth lifecycle', () => {
  it.each(['prompt', 'succeeded', 'failed', 'cancelled'] as const)(
    'does not regress a same-flow %s event when the start response arrives late',
    async (status) => {
      const bridge = installFakeBridge();
      let resolveStart!: (flow: AuthFlow) => void;
      bridge.setHandler(
        'auth.login.start',
        () =>
          new Promise<AuthFlow>((resolve) => {
            resolveStart = resolve;
          }),
      );
      let store!: Store;
      function Probe(): ReactNode {
        store = useStore();
        return <span data-testid="auth-status">{store.state.authFlow?.status ?? 'none'}</span>;
      }
      const view = await mount(
        <StoreProvider>
          <Probe />
        </StoreProvider>,
      );
      mounted = view;
      await view.flush();

      void store.actions.startLogin('fake', 'api_key');
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        bridge.emit({ type: 'auth', flow: newerFlow(status) });
        await Promise.resolve();
      });
      expect(view.container.textContent).toBe(status);

      await act(async () => {
        resolveStart(running);
        await Promise.resolve();
      });
      expect(view.container.textContent).toBe(status);
      if (status === 'prompt') {
        expect(store.state.authFlow?.prompt?.id).toBe('prompt-1');
      }
    },
  );

  it('does not regress newer same-flow running notices when the start response arrives late', async () => {
    const bridge = installFakeBridge();
    let resolveStart!: (flow: AuthFlow) => void;
    bridge.setHandler(
      'auth.login.start',
      () =>
        new Promise<AuthFlow>((resolve) => {
          resolveStart = resolve;
        }),
    );
    let store!: Store;
    function Probe(): ReactNode {
      store = useStore();
      return <span data-testid="auth-message">{store.state.authFlow?.message ?? 'none'}</span>;
    }
    const view = await mount(
      <StoreProvider>
        <Probe />
      </StoreProvider>,
    );
    mounted = view;
    await view.flush();

    void store.actions.startLogin('fake', 'api_key');
    await act(async () => {
      await Promise.resolve();
    });
    const updated: AuthFlow = {
      ...running,
      revision: 1,
      notices: [
        { type: 'auth_url', url: 'https://example.test/login' },
        {
          type: 'device_code',
          userCode: 'ABCD-EFGH',
          verificationUri: 'https://example.test/device',
        },
        { type: 'progress', message: 'Waiting for authorization' },
      ],
      message: 'Waiting for authorization',
    };
    await act(async () => {
      bridge.emit({ type: 'auth', flow: updated });
      await Promise.resolve();
    });

    await act(async () => {
      resolveStart(running);
      await Promise.resolve();
    });

    expect(store.state.authFlow).toEqual(updated);
    expect(view.container.textContent).toBe('Waiting for authorization');
  });
});

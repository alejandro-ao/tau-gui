// @vitest-environment jsdom
import { act, StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentMessage, AgentState, SessionRef } from '../../src/shared/domain.js';
import type { Actions } from '../../src/renderer/src/state/store.js';
import { installFakeBridge, mount, type Mounted } from './harness.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function agent(sessionId: string): AgentState {
  return {
    model: null,
    thinkingLevel: 'medium',
    isStreaming: false,
    isCompacting: false,
    sessionFile: null,
    sessionId,
    sessionName: sessionId,
    autoCompactionEnabled: true,
    messageCount: 1,
    pendingMessageCount: 0,
  };
}

function assistant(text: string): AgentMessage {
  return {
    role: 'assistant',
    text,
    thinking: '',
    toolCalls: [],
    provider: 'fake',
    model: 'fake',
    usage: null,
    stopReason: 'stop',
    errorMessage: null,
    timestamp: 1,
  };
}

describe('session hydration routing', () => {
  it('bootstraps one runtime under development StrictMode', async () => {
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
  });

  it('drops a tool event queued while another session is being selected', async () => {
    const first = agent('first-session');
    const second = agent('second-session');
    const bridge = installFakeBridge({ agent: first });
    const { StoreProvider, useStore } = await import('../../src/renderer/src/state/store.js');
    const { Transcript } = await import('../../src/renderer/src/components/Transcript.js');
    let actions: Actions | null = null;

    function Capture(): ReactNode {
      actions = useStore().actions;
      return null;
    }

    const view = await mount(
      <StoreProvider>
        <Capture />
        <Transcript />
      </StoreProvider>,
    );
    mounted = view;
    await view.flush();

    let resolveSwitch: (() => void) | null = null;
    bridge.setResult(
      'session.switch',
      new Promise<void>((resolve) => {
        resolveSwitch = resolve;
      }),
    );
    bridge.setResult('runtime.snapshot', { ...bridge.snapshot, state: second });
    bridge.setResult('agent.messages', [assistant('second session answer')]);
    const ref: SessionRef = {
      id: second.sessionId,
      name: second.sessionName,
      messageCount: 1,
      path: null,
      cwd: '/work/project',
      runtime: 'tau',
      lastSeen: Date.now(),
    };
    const storeActions = actions as Actions | null;
    if (!storeActions) throw new Error('store actions were not captured');

    let navigation: Promise<void> = Promise.resolve();
    await act(async () => {
      navigation = storeActions.resumeSession(ref);
      bridge.emit({
        type: 'agent',
        sessionId: first.sessionId,
        runtime: 'tau',
        event: {
          type: 'tool_start',
          toolCallId: 'cross-session-call',
          toolName: 'read',
          args: { path: 'must-not-leak.ts' },
        },
      });
      await Promise.resolve();
    });

    expect(view.container.textContent).not.toContain('must-not-leak.ts');
    await act(async () => {
      resolveSwitch?.();
      await navigation;
    });

    expect(view.container.textContent).toContain('second session answer');
    expect(view.container.textContent).not.toContain('must-not-leak.ts');
  });

  it('discards transcript reads that resolve after another session is selected', async () => {
    const first = agent('first-session');
    const second = agent('second-session');
    const bridge = installFakeBridge({ agent: first });
    const { StoreProvider, useStore } = await import('../../src/renderer/src/state/store.js');
    const { Transcript } = await import('../../src/renderer/src/components/Transcript.js');
    let actions: Actions | null = null;

    function Capture(): ReactNode {
      actions = useStore().actions;
      return null;
    }

    const view = await mount(
      <StoreProvider>
        <Capture />
        <Transcript />
      </StoreProvider>,
    );
    mounted = view;
    await view.flush();
    bridge.calls.length = 0;

    let resolveOld: ((messages: AgentMessage[]) => void) | null = null;
    const oldMessages = new Promise<AgentMessage[]>((resolve) => {
      resolveOld = resolve;
    });
    bridge.setResult('agent.messages', oldMessages);

    const storeActions = actions as Actions | null;
    if (!storeActions) throw new Error('store actions were not captured');
    let staleRefresh: Promise<void> = Promise.resolve();
    await act(async () => {
      staleRefresh = storeActions.refresh();
      await Promise.resolve();
    });
    expect(bridge.calls.some((call) => call.action === 'agent.messages')).toBe(true);

    const secondSnapshot = { ...bridge.snapshot, state: second };
    bridge.setResult('runtime.snapshot', secondSnapshot);
    bridge.setResult('agent.messages', [assistant('second session answer')]);
    const ref: SessionRef = {
      id: second.sessionId,
      name: second.sessionName,
      messageCount: 1,
      path: null,
      cwd: '/work/project',
      runtime: 'tau',
      lastSeen: Date.now(),
    };
    await act(async () => {
      await storeActions.resumeSession(ref);
    });

    const staleToolMessages: AgentMessage[] = [
      {
        role: 'assistant',
        text: 'stale tool call',
        thinking: '',
        toolCalls: [{ id: 'stale-call', name: 'read', arguments: { path: 'old.ts' } }],
        provider: 'fake',
        model: 'fake',
        usage: null,
        stopReason: 'toolUse',
        errorMessage: null,
        timestamp: 1,
      },
    ];
    await act(async () => {
      resolveOld?.(staleToolMessages);
      await staleRefresh;
    });
    await view.flush();

    expect(view.container.textContent).toContain('second session answer');
    expect(view.container.textContent).not.toContain('stale tool call');
    expect(view.container.textContent).not.toContain('old.ts');
  });
});

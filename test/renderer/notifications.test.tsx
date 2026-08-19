// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentState, AssistantMessage } from '../../src/shared/domain.js';
import type { BridgeEvent } from '../../src/shared/ipc.js';
import type { FakeBridge, Mounted } from './harness.js';
import { composer, renderApp, settle, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const AGENT: AgentState = {
  model: null,
  thinkingLevel: 'medium',
  isStreaming: false,
  isCompacting: false,
  sessionFile: null,
  sessionId: 's1',
  sessionName: 'refactor',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

function assistant(text: string): AssistantMessage {
  return {
    role: 'assistant',
    text,
    thinking: '',
    toolCalls: [],
    provider: 'fake',
    model: 'fake-large',
    usage: null,
    stopReason: 'stop',
    errorMessage: null,
    timestamp: 1,
  };
}

/** Pushes bridge events the way the main process would. */
async function emit(bridge: FakeBridge, view: Mounted, ...events: BridgeEvent[]): Promise<void> {
  await act(async () => {
    for (const event of events) bridge.emit(event);
    await Promise.resolve();
  });
  await settle(view);
}

/** Streams one answer and settles the turn. */
async function runTurn(bridge: FakeBridge, view: Mounted, text: string): Promise<void> {
  const events: AgentEvent[] = [
    { type: 'agent_start' },
    { type: 'message_end', message: assistant(text) },
    { type: 'agent_settled' },
  ];
  await emit(
    bridge,
    view,
    ...events.map((event) => ({
      type: 'agent' as const,
      sessionId: AGENT.sessionId,
      runtime: 'tau' as const,
      event,
    })),
  );
}

function titles(bridge: FakeBridge): string[] {
  return bridge.payloads('ui.setTitle').map((payload) => {
    const title = (payload as { title?: unknown } | undefined)?.title;
    return typeof title === 'string' ? title : '';
  });
}

describe('window title', () => {
  it('reports the session name while idle and marks running turns', async () => {
    const { view, bridge } = await renderApp({});
    mounted = view;
    await settle(view);

    bridge.calls.length = 0;
    await emit(bridge, view, { type: 'status', snapshot: { ...bridge.snapshot, state: AGENT } });
    expect(titles(bridge)).toEqual(['τ | refactor']);

    bridge.calls.length = 0;
    await emit(bridge, view, {
      type: 'status',
      snapshot: { ...bridge.snapshot, status: 'running', state: AGENT },
    });
    expect(titles(bridge)).toEqual(['τ | refactor | running']);
  });

  it('does not re-title on unrelated dispatches', async () => {
    const { view, bridge } = await renderApp({ agent: AGENT });
    mounted = view;
    await settle(view);
    bridge.calls.length = 0;
    await type(composer(view), 'a draft that does not change the title');
    await settle(view);
    expect(titles(bridge)).toEqual([]);
  });
});

describe('completion notifications', () => {
  it('notifies once per settle while unfocused', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      settings: { turnNotification: 'desktop' },
    });
    mounted = view;
    await emit(bridge, view, { type: 'focus', focused: false });

    bridge.calls.length = 0;
    await runTurn(bridge, view, 'all done');
    expect(bridge.payloads('ui.notify')).toEqual([{ title: 'τ | refactor', body: 'all done' }]);

    // An identical answer must still notify: the guard is the settle counter.
    await runTurn(bridge, view, 'all done');
    expect(bridge.payloads('ui.notify')).toHaveLength(2);
  });

  it('stays silent while the window is focused', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      settings: { turnNotification: 'desktop' },
    });
    mounted = view;
    await emit(bridge, view, { type: 'focus', focused: true });

    bridge.calls.length = 0;
    await runTurn(bridge, view, 'all done');
    expect(bridge.payloads('ui.notify')).toEqual([]);
  });

  it('stays silent when notifications are off', async () => {
    const { view, bridge } = await renderApp({
      agent: AGENT,
      settings: { turnNotification: 'off' },
    });
    mounted = view;
    await emit(bridge, view, { type: 'focus', focused: false });

    bridge.calls.length = 0;
    await runTurn(bridge, view, 'all done');
    expect(bridge.payloads('ui.notify')).toEqual([]);
  });
});

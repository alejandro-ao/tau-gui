// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentState } from '../../src/shared/domain.js';
import type { IpcAction } from '../../src/shared/ipc.js';
import type { Mounted } from './harness.js';
import { composer, press, renderApp, type } from './ui.js';

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
  sessionId: 'session-a',
  sessionName: null,
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
};

async function run(view: Mounted, command: string): Promise<void> {
  const input = composer(view);
  await type(input, command);
  await press(input, 'Enter');
  await view.flush();
}

describe('local-only Pi introspection', () => {
  it('renders /system locally without prompting or changing the draft transcript', async () => {
    const { view, bridge } = await renderApp({
      capabilities: { systemPromptInspection: true },
      agent: AGENT,
      results: {
        'agent.inspectSystemPrompt': {
          text: 'Private system instructions\nDo not leak.',
          totalCharacters: 40,
          truncated: false,
          origin: 'active Pi session',
        },
      },
    });
    mounted = view;

    await run(view, '/system');
    const modal = view.container.querySelector('[data-modal-name="system"]');
    expect(modal?.textContent).toContain('Private system instructions');
    expect(modal?.textContent).toContain('never sent to the model');
    expect(bridge.payloads('agent.inspectSystemPrompt')).toEqual([undefined]);
    expect(bridge.payloads('agent.prompt')).toEqual([]);
    expect(view.container.querySelector('[role="log"]')?.textContent).not.toContain(
      'Private system instructions',
    );
  });

  it('renders bounded tool metadata and schemas as text', async () => {
    const { view, bridge } = await renderApp({
      capabilities: { toolCatalog: true },
      agent: AGENT,
      results: {
        'tools.list': {
          tools: [
            {
              name: 'read',
              description: '<img src=x onerror=alert(1)>',
              origin: 'builtin',
              active: true,
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
              schemaTruncated: false,
            },
          ],
          total: 1,
          truncated: false,
          diagnostics: [],
        },
      },
    });
    mounted = view;

    await run(view, '/tools');
    const modal = view.container.querySelector('[data-modal-name="tools"]');
    expect(modal?.textContent).toContain('read');
    expect(modal?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(modal?.querySelector('img')).toBeNull();
    expect(modal?.textContent).toContain('"path"');
    expect(bridge.payloads('tools.list')).toEqual([undefined]);
  });

  it.each([
    ['agent.inspectSystemPrompt', '/system', 'system'],
    ['tools.list', '/tools', 'tools'],
    ['resources.reload', '/reload', 'reload'],
  ] as const)(
    'drops a delayed %s response after switching sessions',
    async (action: IpcAction, command, modalName) => {
      const { view, bridge } = await renderApp({
        capabilities: {
          systemPromptInspection: true,
          toolCatalog: true,
          resourceReload: true,
        },
        agent: AGENT,
      });
      mounted = view;
      let resolve!: (value: unknown) => void;
      bridge.setHandler(action, () => new Promise((done) => (resolve = done)));

      const input = composer(view);
      await type(input, command);
      await press(input, 'Enter');
      await view.flush();
      expect(bridge.calls.find((call) => call.action === action)?.session).toEqual({
        runtime: 'tau',
        sessionId: 'session-a',
      });
      await act(async () => {
        bridge.emit({
          type: 'status',
          snapshot: { ...bridge.snapshot, state: { ...AGENT, sessionId: 'session-b' } },
        });
        await Promise.resolve();
      });
      await act(async () => {
        resolve(
          action === 'agent.inspectSystemPrompt'
            ? { text: 'stale secret', totalCharacters: 12, truncated: false, origin: 'test' }
            : action === 'tools.list'
              ? { tools: [], total: 0, truncated: false, diagnostics: ['stale tools'] }
              : {
                  before: {
                    skills: 0,
                    prompts: 0,
                    themes: 0,
                    contextFiles: 0,
                    extensions: 0,
                    tools: 0,
                  },
                  after: {
                    skills: 1,
                    prompts: 0,
                    themes: 0,
                    contextFiles: 0,
                    extensions: 0,
                    tools: 0,
                  },
                  diagnostics: ['stale reload'],
                },
        );
        await Promise.resolve();
      });
      await view.flush();
      await view.flush();

      expect(view.container.querySelector(`[data-modal-name="${modalName}"]`)).toBeNull();
      expect(view.container.textContent).not.toContain('stale');
    },
  );

  it('runs /reload in place, shows category counts, and refreshes resource metadata', async () => {
    const { view, bridge } = await renderApp({
      capabilities: { resourceReload: true },
      agent: AGENT,
      results: {
        'resources.reload': {
          before: { skills: 1, prompts: 2, themes: 2, contextFiles: 1, extensions: 0, tools: 4 },
          after: { skills: 2, prompts: 3, themes: 2, contextFiles: 2, extensions: 0, tools: 4 },
          diagnostics: ['warning: duplicate prompt ignored'],
        },
      },
    });
    mounted = view;

    await run(view, '/reload');
    const modal = view.container.querySelector('[data-modal-name="reload"]');
    expect(modal?.textContent).toContain('1 → 2');
    expect(modal?.textContent).toContain('2 → 3');
    expect(modal?.textContent).toContain('duplicate prompt ignored');
    expect(bridge.payloads('resources.reload')).toEqual([undefined]);
    expect(bridge.payloads('resources.list').length).toBeGreaterThan(0);
    expect(bridge.payloads('agent.prompt')).toEqual([]);
  });
});

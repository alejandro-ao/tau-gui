// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { Mounted } from './harness.js';
import { composer, press, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

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

  it('runs /reload in place, shows category counts, and refreshes resource metadata', async () => {
    const { view, bridge } = await renderApp({
      capabilities: { resourceReload: true },
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

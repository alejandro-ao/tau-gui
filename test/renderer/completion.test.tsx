// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { query, texts, type FakeBridge, type Mounted } from './harness.js';
import { click, composer, options, press, renderApp, selectedOption, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const COMMANDS = [
  { name: 'review', description: 'Review the working tree', source: 'runtime' as const },
];

async function open(): Promise<{ view: Mounted; bridge: FakeBridge; input: HTMLTextAreaElement }> {
  const { view, bridge } = await renderApp({
    capabilities: { directBash: true },
    results: { 'commands.list': COMMANDS },
  });
  mounted = view;
  return { view, bridge, input: composer(view) };
}

function actionsOf(bridge: FakeBridge): string[] {
  return bridge.calls.map((call) => call.action).filter((action) => !action.startsWith('ui.'));
}

/** Finds a completion row by its label, failing loudly when it is absent. */
function optionByLabel(root: ParentNode, label: string): HTMLElement {
  const option = [...root.querySelectorAll('.completion-option')].find(
    (element) => element.querySelector('.completion-label')?.textContent === label,
  );
  if (!option) throw new Error(`No completion option labelled ${label}`);
  return option as HTMLElement;
}

describe('slash command completion', () => {
  it('merges runtime and frontend commands and filters fuzzily', async () => {
    const { view, input } = await open();
    await type(input, '/mod');
    const popup = query(view.container, '[data-testid="completion-slash"]');
    expect(options(popup)[0]).toContain('/model');

    await type(input, '/rev');
    expect(texts(view.container, '.completion-label')).toContain('/review');
  });

  it('navigates with Up/Down and accepts with Enter', async () => {
    const { view, input } = await open();
    await type(input, '/s');
    const first = selectedOption(view.container);
    await press(input, 'ArrowDown');
    expect(selectedOption(view.container)).not.toBe(first);
    await press(input, 'ArrowUp');
    expect(selectedOption(view.container)).toBe(first);

    await type(input, '/hotkeys');
    await press(input, 'Enter');
    expect(view.container.querySelector('[data-modal-name="hotkeys"]')).not.toBeNull();
    // Running a command clears the draft.
    expect(composer(view).value).toBe('');
  });

  it('keeps the top-ranked match selected as the query narrows', async () => {
    const { view } = await renderApp({ capabilities: { sessionTree: true } });
    mounted = view;
    const input = composer(view);
    // Typing incrementally is what users actually do, and it is what regressed:
    // a stale selection carried over from an earlier query when the previously
    // highlighted command still fuzzily matched the longer one.
    for (const draft of ['/', '/t', '/tr', '/tre', '/tree']) {
      await type(input, draft);
      const labels = texts(view.container, '.completion-label');
      expect(selectedOption(view.container)).toContain(labels[0]);
    }
    // The reported case: /tree must win over /new, /name and /commands.
    expect(texts(view.container, '.completion-label')[0]).toBe('/tree');
    expect(selectedOption(view.container)).toContain('/tree');

    // Enter therefore runs the command the user is looking at.
    await press(input, 'Enter');
    expect(view.container.querySelector('[data-modal-name="tree"]')).not.toBeNull();
  });

  it('keeps arrow-key selection until the query changes', async () => {
    const { view, input } = await open();
    await type(input, '/s');
    const top = selectedOption(view.container);
    await press(input, 'ArrowDown');
    const moved = selectedOption(view.container);
    expect(moved).not.toBe(top);

    // Re-rendering for an unrelated reason must not snap the highlight back.
    await press(input, 'ArrowRight');
    expect(selectedOption(view.container)).toBe(moved);

    // Typing a new character is a new query, so ranking takes over again.
    await type(input, '/se');
    const labels = texts(view.container, '.completion-label');
    expect(selectedOption(view.container)).toContain(labels[0]);
  });

  it('completes the draft text with Tab without running the command', async () => {
    const { view, input } = await open();
    await type(input, '/mode');
    await press(input, 'Tab');
    expect(composer(view).value).toBe('/model ');
    expect(view.container.querySelector('[data-modal-name="model"]')).toBeNull();
  });

  it('accepts a mouse click', async () => {
    const { view, input } = await open();
    await type(input, '/theme');
    await click(query(view.container, '.completion-option'));
    expect(view.container.querySelector('[data-modal-name="theme"]')).not.toBeNull();
  });

  it('dismisses with Escape and keeps the draft', async () => {
    const { view, input } = await open();
    await type(input, '/mod');
    await press(input, 'Escape');
    expect(view.container.querySelector('[data-testid="completion-slash"]')).toBeNull();
    expect(composer(view).value).toBe('/mod');
  });

  it('reports the reason for capability-gated commands instead of failing silently', async () => {
    const { view, input, bridge } = await open();
    await type(input, '/tools');
    const row = query(view.container, '.completion-option');
    expect(row.getAttribute('data-unavailable')).toBe('true');
    await press(input, 'Enter');
    expect(view.container.textContent).toContain('tool catalog inspection needs runtime RPC');
    expect(actionsOf(bridge)).not.toContain('agent.prompt');
  });

  it('runs registered commands with arguments instead of prompting the model', async () => {
    const { input, bridge } = await open();
    await type(input, '/name release prep');
    await press(input, 'Enter');

    expect(bridge.payloads('session.name')).toEqual([{ name: 'release prep' }]);
    expect(actionsOf(bridge)).not.toContain('agent.prompt');
  });

  it('completes skills and sends explicit invocations to Tau', async () => {
    const { view, bridge } = await renderApp({
      results: {
        'resources.list': {
          skills: [
            {
              name: 'security-review',
              description: 'Review for security issues',
              origin: '~/.agents/skills',
              disableModelInvocation: false,
              estimatedTokens: 120,
            },
          ],
          prompts: [],
          diagnostics: [],
        },
      },
    });
    mounted = view;
    const input = composer(view);
    await type(input, '/skill:sec');
    expect(options(query(view.container, '[data-testid="completion-slash"]'))[0]).toContain(
      '/skill:security-review',
    );
    await press(input, 'Enter');
    expect(input.value).toBe('/skill:security-review ');
    await type(input, '/skill:security-review check auth');
    await press(input, 'Enter');
    expect(bridge.payloads('agent.prompt')).toEqual([
      { text: '/skill:security-review check auth' },
    ]);
  });

  it('completes custom prompts and lets them override same-named GUI commands', async () => {
    const { view, bridge } = await renderApp({
      results: {
        'resources.list': {
          skills: [],
          prompts: [
            {
              name: 'model',
              description: 'Custom model audit',
              origin: './.tau/prompts',
            },
          ],
          diagnostics: [],
        },
      },
    });
    mounted = view;
    const input = composer(view);
    await type(input, '/mod');
    const labels = texts(view.container, '.completion-label');
    expect(labels.filter((label) => label === '/model')).toHaveLength(1);
    // The prompt sits in its own section below the commands; pick it directly.
    await click(optionByLabel(view.container, '/model'));
    expect(input.value).toBe('/model ');
    await type(input, '/model audit providers');
    await press(input, 'Enter');
    expect(bridge.payloads('agent.prompt')).toEqual([{ text: '/model audit providers' }]);
    expect(view.container.querySelector('[data-modal-name="model"]')).toBeNull();
  });

  it('lists builtin commands by default with custom prompts in their own section', async () => {
    const { view } = await renderApp({
      results: {
        'resources.list': {
          skills: [
            {
              name: 'security-review',
              description: 'Review for security issues',
              origin: '~/.agents/skills',
              disableModelInvocation: false,
              estimatedTokens: 120,
            },
          ],
          prompts: [
            {
              name: 'release-notes',
              description: 'Draft release notes',
              origin: './.tau/prompts',
            },
          ],
          diagnostics: [],
        },
      },
    });
    mounted = view;
    const input = composer(view);
    await type(input, '/');

    const popup = query(view.container, '[data-testid="completion-slash"]');
    const labels = texts(popup, '.completion-label');
    // Builtin commands come first, including the /skill: prefix entry.
    expect(labels[0]).toBe('/new');
    expect(labels).toContain('/model');
    expect(labels).toContain('/skill:');
    // Skills stay hidden until /skill: is typed.
    expect(labels).not.toContain('/skill:security-review');
    // Custom prompts sit in their own section after the commands.
    expect(texts(popup, '.completion-section')).toEqual(['Commands', 'Custom prompts']);
    expect(labels.indexOf('/release-notes')).toBeGreaterThan(labels.indexOf('/skill:'));
  });

  it('accepts /skill: as a prefix and then recommends skills', async () => {
    const { view } = await renderApp({
      results: {
        'resources.list': {
          skills: [
            {
              name: 'security-review',
              description: 'Review for security issues',
              origin: '~/.agents/skills',
              disableModelInvocation: false,
              estimatedTokens: 120,
            },
            {
              name: 'docs',
              description: 'Write documentation',
              origin: '~/.agents/skills',
              disableModelInvocation: true,
              estimatedTokens: 80,
            },
          ],
          prompts: [],
          diagnostics: [],
        },
      },
    });
    mounted = view;
    const input = composer(view);
    await type(input, '/skill');
    await click(optionByLabel(view.container, '/skill:'));
    // The prefix inserts without a trailing space so completion stays open.
    expect(input.value).toBe('/skill:');
    const labels = texts(view.container, '.completion-label');
    expect(labels).toContain('/skill:security-review');
    expect(labels).toContain('/skill:docs');
    // Skill recommendations render without section headers.
    expect(view.container.querySelector('.completion-section')).toBeNull();
  });

  it('sends unknown slash input as a normal prompt', async () => {
    const { view, input, bridge } = await open();
    await type(input, '/definitely-not-a-command');
    expect(view.container.querySelector('[data-testid="completion-slash"]')).toBeNull();
    await press(input, 'Enter');
    expect(bridge.payloads('agent.prompt')).toEqual([{ text: '/definitely-not-a-command' }]);
  });
});

describe('@ file completion', () => {
  it('inserts the selected path at the cursor, quoting spaces', async () => {
    const { view, bridge } = await renderApp({
      results: {
        'fs.complete': [
          { path: 'src/a b.ts', isDirectory: false },
          { path: 'src/nested', isDirectory: true },
        ],
      },
    });
    mounted = view;
    const input = composer(view);
    await type(input, 'look at @a b');
    await moveCursor(input, 10);
    await waitForPopup(view);

    expect(bridge.payloads('fs.complete')).toEqual([{ query: 'a' }]);
    const popup = query(view.container, '[data-testid="completion-path"]');
    expect(options(popup)[0]).toContain('src/a b.ts');

    await press(input, 'Enter');
    // The `@a` token is replaced; the rest of the draft survives.
    expect(composer(view).value).toBe('look at "src/a b.ts" b');
  });

  it('keeps directories open for further completion', async () => {
    const { view } = await renderApp({
      results: { 'fs.complete': [{ path: 'src/nested', isDirectory: true }] },
    });
    mounted = view;
    const input = composer(view);
    await type(input, '@nest');
    await waitForPopup(view);
    await press(input, 'Tab');
    expect(composer(view).value).toBe('src/nested/');
  });
});

/** Moves the caret the way a click or arrow key would. */
async function moveCursor(input: HTMLTextAreaElement, position: number): Promise<void> {
  await act(async () => {
    input.setSelectionRange(position, position);
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowLeft', bubbles: true }));
    await Promise.resolve();
  });
}

/** The completion request is debounced in the renderer. */
async function waitForPopup(view: Mounted): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 140));
  });
  await view.flush();
}

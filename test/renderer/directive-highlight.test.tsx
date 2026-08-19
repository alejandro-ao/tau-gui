// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { query, type Mounted } from './harness.js';
import { click, composer, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const RESOURCES = {
  skills: [
    {
      name: 'security-review',
      description: 'Review for security issues',
      origin: '~/.agents/skills',
      disableModelInvocation: false,
    },
  ],
  prompts: [
    { name: 'release-notes', description: 'Draft release notes', origin: './.tau/prompts' },
  ],
  diagnostics: [],
};

const COMMANDS = [
  { name: 'review', description: 'Review the working tree', source: 'runtime' as const },
];

async function open(): Promise<{ view: Mounted; input: HTMLTextAreaElement }> {
  const { view } = await renderApp({
    results: { 'resources.list': RESOURCES, 'commands.list': COMMANDS },
  });
  mounted = view;
  return { view, input: composer(view) };
}

function pill(view: Mounted): HTMLElement | null {
  return view.container.querySelector<HTMLElement>('.composer-directive');
}

function backdropText(view: Mounted): string {
  return query(view.container, '[data-testid="composer-highlight"]').textContent ?? '';
}

describe('composer directive highlighting', () => {
  it('marks a custom prompt and leaves its arguments plain', async () => {
    const { view, input } = await open();
    await type(input, '/release-notes for v2');

    const marked = pill(view);
    expect(marked?.textContent).toBe('/release-notes');
    expect(marked?.dataset.kind).toBe('prompt');
    expect(query(view.container, '[data-testid="composer"]').dataset.directive).toBe('prompt');
    // The backdrop must mirror the draft so the pill lines up with the glyphs.
    expect(backdropText(view)).toBe('/release-notes for v2');
  });

  it('marks skills with their own kind', async () => {
    const { view, input } = await open();
    await type(input, '/skill:security-review check auth');

    expect(pill(view)?.textContent).toBe('/skill:security-review');
    expect(pill(view)?.dataset.kind).toBe('skill');
    expect(query(view.container, '[data-testid="composer"]').dataset.directive).toBe('skill');
  });

  it('leaves GUI and runtime commands unmarked', async () => {
    const { view, input } = await open();
    await type(input, '/hotkeys');
    expect(pill(view)).toBeNull();

    await type(input, '/review the diff');
    expect(pill(view)).toBeNull();
    expect(query(view.container, '[data-testid="composer"]').dataset.directive).toBeUndefined();
  });

  it('marks a directive accepted from the completion popup', async () => {
    const { view, input } = await open();
    await type(input, '/rel');
    await click(query(view.container, '.completion-option[data-kind="prompt"]'));

    expect(composer(view).value).toBe('/release-notes ');
    expect(pill(view)?.textContent).toBe('/release-notes');
  });

  it('clears the highlight when the draft stops matching a resource', async () => {
    const { view, input } = await open();
    await type(input, '/release-notes');
    expect(pill(view)).not.toBeNull();

    await type(input, '/release-note');
    expect(pill(view)).toBeNull();

    await type(input, 'ask about /release-notes');
    expect(pill(view)).toBeNull();
    expect(backdropText(view)).toBe('ask about /release-notes');
  });

  it('colour-codes prompt and skill entries in the completion popup', async () => {
    const { view, input } = await open();
    await type(input, '/rel');
    const promptOption = query(view.container, '.completion-option[data-kind="prompt"]');
    expect(promptOption.textContent).toContain('/release-notes');

    await type(input, '/skill:sec');
    const skillOption = query(view.container, '.completion-option[data-kind="skill"]');
    expect(skillOption.textContent).toContain('/skill:security-review');

    await type(input, '/hotkeys');
    expect(view.container.querySelector('.completion-option[data-kind]')).toBeNull();
  });
});

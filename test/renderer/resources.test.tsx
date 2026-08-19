// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { query, type Mounted } from './harness.js';
import { composer, press, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const resources = {
  skills: [
    {
      name: 'weekly-report',
      description: 'Generate the weekly report',
      origin: '~/.tau/skills',
      disableModelInvocation: true,
      estimatedTokens: 120,
    },
  ],
  prompts: [{ name: 'worktree', description: 'Work in isolation', origin: './.agents/prompts' }],
  diagnostics: [],
};

describe('custom prompt and skill pickers', () => {
  it('opens /skills and inserts the selected invocation', async () => {
    const { view } = await renderApp({ results: { 'resources.list': resources } });
    mounted = view;
    const input = composer(view);
    await type(input, '/skills');
    await press(input, 'Enter');
    const modal = query(view.container, '[data-modal-name="skills"]');
    expect(modal.textContent).toContain('weekly-report');
    expect(modal.textContent).toContain('user only');
    await press(query<HTMLInputElement>(modal, '.picker-input'), 'Enter');
    expect(composer(view).value).toBe('/skill:weekly-report ');
  });

  it('opens /prompts and inserts the selected invocation', async () => {
    const { view } = await renderApp({ results: { 'resources.list': resources } });
    mounted = view;
    const input = composer(view);
    await type(input, '/prompts');
    await press(input, 'Enter');
    const modal = query(view.container, '[data-modal-name="prompts"]');
    expect(modal.textContent).toContain('Work in isolation');
    await press(query<HTMLInputElement>(modal, '.picker-input'), 'Enter');
    expect(composer(view).value).toBe('/worktree ');
  });
});

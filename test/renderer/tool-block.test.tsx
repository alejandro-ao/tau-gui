// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ToolBlockView } from '../../src/renderer/src/components/ToolBlockView.js';
import type { ToolBlock } from '../../src/renderer/src/state/types.js';
import { mount, query } from './harness.js';

function toolBlock(patch: Partial<ToolBlock> = {}): ToolBlock {
  return {
    kind: 'tool',
    id: 'tool-1',
    toolCallId: 'call-1',
    name: 'bash',
    args: { command: 'npm test\n--watch', description: 'Run the test suite' },
    output: 'all good',
    state: 'success',
    startedAt: 1000,
    endedAt: 4000,
    timestamp: 1000,
    ...patch,
  };
}

describe('ToolBlockView', () => {
  it('shows the bash description when collapsed and hides output', async () => {
    const view = await mount(
      <ToolBlockView block={toolBlock()} expanded={false} onToggle={() => {}} />,
    );
    expect(query(view.container, '.tool-intent').textContent).toBe('Run the test suite');
    expect(view.container.textContent).not.toContain('all good');
    expect(query(view.container, '.block-tool').getAttribute('data-state')).toBe('success');
    view.unmount();
  });

  it('falls back to the first command line without a description', async () => {
    const view = await mount(
      <ToolBlockView
        block={toolBlock({ args: { command: 'npm test\n--watch' } })}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(query(view.container, '.tool-intent').textContent).toBe('npm test');
    view.unmount();
  });

  it('summarizes unknown tools with bounded JSON arguments', async () => {
    const view = await mount(
      <ToolBlockView
        block={toolBlock({ name: 'acme_lookup', args: { query: 'x'.repeat(600) } })}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    const intent = query(view.container, '.tool-intent').textContent ?? '';
    expect(intent.startsWith('{"query":"xxx')).toBe(true);
    expect(intent.length).toBeLessThan(420);
    expect(intent.endsWith('…')).toBe(true);
    view.unmount();
  });

  it('exposes exact arguments and output when expanded', async () => {
    const view = await mount(<ToolBlockView block={toolBlock()} expanded onToggle={() => {}} />);
    expect(query(view.container, '.tool-args').textContent).toContain('"command"');
    expect(query(view.container, '.tool-output').textContent).toBe('all good');
    expect(query(view.container, '.block-header').getAttribute('aria-expanded')).toBe('true');
    view.unmount();
  });

  it('renders unified diffs with per-line coloring when expanded', async () => {
    const diff = [
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,2 +1,2 @@',
      '-old line',
      '+new line',
    ].join('\n');
    const view = await mount(
      <ToolBlockView
        block={toolBlock({ name: 'edit', output: diff })}
        expanded
        onToggle={() => {}}
      />,
    );
    const kinds = [...view.container.querySelectorAll('.diff-line')].map((line) =>
      line.getAttribute('data-kind'),
    );
    expect(kinds).toEqual(['meta', 'meta', 'hunk', 'del', 'add']);
    view.unmount();
  });

  it('uses running state colors and shows elapsed seconds past one second', async () => {
    const startedAt = Date.now() - 5_000;
    const view = await mount(
      <ToolBlockView
        block={toolBlock({ state: 'running', endedAt: null, startedAt, output: '' })}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(query(view.container, '.block-tool').getAttribute('data-state')).toBe('running');
    expect(query(view.container, '.tool-elapsed').textContent).toBe('5s');
    view.unmount();
  });

  it('omits elapsed seconds for sub-second calls', async () => {
    const view = await mount(
      <ToolBlockView
        block={toolBlock({ startedAt: 1000, endedAt: 1400 })}
        expanded={false}
        onToggle={() => {}}
      />,
    );
    expect(view.container.querySelector('.tool-elapsed')).toBeNull();
    view.unmount();
  });

  it('marks failures with the error state', async () => {
    const view = await mount(
      <ToolBlockView block={toolBlock({ state: 'error' })} expanded={false} onToggle={() => {}} />,
    );
    expect(query(view.container, '.block-tool').getAttribute('data-state')).toBe('error');
    view.unmount();
  });
});

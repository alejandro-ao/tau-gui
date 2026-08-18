// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { ToolGroupView } from '../../src/renderer/src/components/ToolGroupView.js';
import { groupBlocks } from '../../src/renderer/src/state/reducer.js';
import type { ToolBlock, TranscriptBlock } from '../../src/renderer/src/state/types.js';
import { mount } from './harness.js';

function read(id: string, path: string, contents: string): ToolBlock {
  return {
    kind: 'tool',
    id,
    toolCallId: id,
    name: 'read',
    args: { path },
    output: contents,
    state: 'success',
    startedAt: 0,
    endedAt: 0,
    timestamp: 0,
  };
}

describe('tool run rendering', () => {
  const blocks: TranscriptBlock[] = [
    read('t1', 'src/a.ts', 'contents of a'),
    read('t2', 'src/b.ts', 'contents of b'),
    read('t3', 'src/c.ts', 'contents of c'),
  ];

  it('groups adjacent calls through the reducer selector', () => {
    const groups = groupBlocks(blocks);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ kind: 'tools', settled: true });
  });

  it('shows compact calls during work instead of the final summary', async () => {
    const toggle = vi.fn();
    const view = await mount(
      <ToolGroupView
        blocks={blocks as ToolBlock[]}
        expanded={false}
        onToggle={() => {}}
        isBlockExpanded={() => false}
        onToggleBlock={toggle}
        settled={false}
      />,
    );

    expect(view.container.querySelectorAll('.tool-run-item')).toHaveLength(3);
    expect(view.container.textContent).toContain('src/a.ts');
    expect(view.container.textContent).not.toContain('Worked for');
    expect(view.container.textContent).not.toContain('contents of a');
    view.container.querySelector<HTMLElement>('.tool-run-item')?.click();
    expect(toggle).toHaveBeenCalledWith('t1');
    view.unmount();
  });

  it('shows one expandable summary only after settlement', async () => {
    const view = await mount(
      <ToolGroupView
        blocks={blocks as ToolBlock[]}
        expanded
        onToggle={() => {}}
        isBlockExpanded={(id) => id === 't2'}
        onToggleBlock={() => {}}
        settled
      />,
    );

    expect(view.container.textContent).toContain('Worked for <1 minute · 3 tools called');
    expect(view.container.querySelectorAll('.tool-run-item')).toHaveLength(0);
    expect(view.container.textContent).toContain('contents of b');
    expect(view.container.textContent).not.toContain('contents of a');
    view.unmount();
  });
});

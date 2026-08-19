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
    expect(groups[0]).toMatchObject({ kind: 'tools', settled: false });
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

    expect(view.container.querySelectorAll('.tool-run-row')).toHaveLength(1);
    expect(view.container.textContent).toContain('read 3 files');
    expect(view.container.querySelectorAll('.tool-cluster-path')).toHaveLength(3);
    expect(view.container.textContent).toContain('src/a.ts');
    expect(view.container.textContent).not.toContain('Worked for');
    expect(view.container.textContent).not.toContain('contents of a');
    view.container.querySelector<HTMLElement>('.tool-cluster-path')?.click();
    expect(toggle).toHaveBeenCalledWith('t1');
    view.unmount();
  });

  it('renders reasoning between tool rows on the same rail', async () => {
    const view = await mount(
      <ToolGroupView
        blocks={[blocks[0], blocks[1]] as ToolBlock[]}
        activity={[
          blocks[0] as ToolBlock,
          {
            kind: 'thinking',
            id: 'thought',
            text: 'Now checking the second file.',
            streaming: false,
            timestamp: 0,
          },
          blocks[1] as ToolBlock,
        ]}
        expanded={false}
        onToggle={() => {}}
        isBlockExpanded={() => false}
        onToggleBlock={() => {}}
        settled={false}
      />,
    );

    const items = view.container.querySelector('.tool-run-items');
    expect(items?.children).toHaveLength(3);
    expect(items?.children[1]?.classList.contains('tool-run-thinking')).toBe(true);
    expect(items?.textContent).toContain('Now checking the second file.');
    view.unmount();
  });

  it('renders narration as a rail note, not as an answer', async () => {
    const view = await mount(
      <ToolGroupView
        blocks={[blocks[0]] as ToolBlock[]}
        activity={[
          {
            kind: 'assistant',
            id: 'note',
            text: 'Exploring the repository.',
            streaming: false,
            aborted: false,
            timestamp: 0,
          },
          blocks[0] as ToolBlock,
        ]}
        expanded={false}
        onToggle={() => {}}
        isBlockExpanded={() => false}
        onToggleBlock={() => {}}
        settled={false}
      />,
    );

    const items = view.container.querySelector('.tool-run-items');
    expect(items?.children[0]?.classList.contains('tool-run-note')).toBe(true);
    expect(items?.textContent).toContain('Exploring the repository.');
    // Narration on the rail is never dressed up as a message block.
    expect(view.container.querySelector('.block-assistant')).toBeNull();
    view.unmount();
  });

  it('summarizes a tool-less reasoning turn by its duration alone', async () => {
    const view = await mount(
      <ToolGroupView
        blocks={[]}
        activity={[
          {
            kind: 'thinking',
            id: 'thought',
            text: 'Weighing the options.',
            streaming: false,
            timestamp: 0,
          },
        ]}
        expanded={false}
        onToggle={() => {}}
        isBlockExpanded={() => false}
        onToggleBlock={() => {}}
        settled
        turnStartedAt={0}
        turnEndedAt={4_000}
      />,
    );

    expect(view.container.textContent).toContain('Thought for <1 minute');
    expect(view.container.textContent).not.toContain('tool call');
    expect(view.container.textContent).not.toContain('Weighing the options.');
    view.unmount();
  });

  it('renders nothing when the rail is empty', async () => {
    const view = await mount(
      <ToolGroupView
        blocks={[]}
        activity={[]}
        expanded={false}
        onToggle={() => {}}
        isBlockExpanded={() => false}
        onToggleBlock={() => {}}
        settled
      />,
    );

    expect(view.container.querySelector('.tool-run')).toBeNull();
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

    expect(view.container.textContent).toContain('Worked for <1 minute · 3 tool calls');
    expect(view.container.querySelectorAll('.tool-run-row')).toHaveLength(1);
    expect(view.container.textContent).toContain('contents of b');
    expect(view.container.textContent).not.toContain('contents of a');
    view.unmount();
  });
});

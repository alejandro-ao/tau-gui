// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { ToolGroupView } from '../../src/renderer/src/components/ToolGroupView.js';
import { groupBlocks } from '../../src/renderer/src/state/reducer.js';
import type { ToolBlock, TranscriptBlock } from '../../src/renderer/src/state/types.js';
import { mount, texts } from './harness.js';

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

describe('grouped read rendering', () => {
  const blocks: TranscriptBlock[] = [
    read('t1', 'src/a.ts', 'contents of a'),
    read('t2', 'src/b.ts', 'contents of b'),
    read('t3', 'src/c.ts', 'contents of c'),
  ];

  it('groups adjacent reads through the reducer selector', () => {
    const groups = groupBlocks(blocks);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe('tools');
  });

  it('lists every path without repeating file contents', async () => {
    const group = groupBlocks(blocks)[0];
    if (group?.kind !== 'tools') throw new Error('expected a tool group');
    const view = await mount(
      <ToolGroupView
        name={group.name}
        blocks={group.blocks}
        expanded={false}
        onToggle={() => {}}
        isBlockExpanded={() => false}
        onToggleBlock={() => {}}
      />,
    );

    expect(texts(view.container, '.path-list li')).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(view.container.textContent).toContain('3 paths');
    expect(view.container.textContent).not.toContain('contents of a');
    expect(view.container.textContent).not.toContain('contents of c');
    view.unmount();
  });

  it('reveals per-call output only when the group and call are expanded', async () => {
    const group = groupBlocks(blocks)[0];
    if (group?.kind !== 'tools') throw new Error('expected a tool group');
    const view = await mount(
      <ToolGroupView
        name={group.name}
        blocks={group.blocks}
        expanded
        onToggle={() => {}}
        isBlockExpanded={(id) => id === 't2'}
        onToggleBlock={() => {}}
      />,
    );

    expect(view.container.textContent).toContain('contents of b');
    expect(view.container.textContent).not.toContain('contents of a');
    view.unmount();
  });
});

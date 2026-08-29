// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBridge, mount, query, type Mounted } from './harness.js';
import type { Action, TranscriptBlock } from '../../src/renderer/src/state/types.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const compaction: TranscriptBlock = {
  kind: 'compaction',
  id: 'compaction-1',
  summary: 'The user asked about the reducer and we refactored it.',
  detail: '900 → ~120 tokens',
  timestamp: 1,
};

async function renderTranscriptWith(block: TranscriptBlock): Promise<Mounted> {
  installFakeBridge({ status: 'idle' });
  const { StoreProvider, useStore } = await import('../../src/renderer/src/state/store.js');
  const { Transcript } = await import('../../src/renderer/src/components/Transcript.js');
  const captured: { dispatch: ((action: Action) => void) | null } = { dispatch: null };

  function Capture(): ReactNode {
    captured.dispatch = useStore().dispatch;
    return null;
  }

  const view = await mount(
    <StoreProvider>
      <Capture />
      <Transcript />
    </StoreProvider>,
  );
  mounted = view;
  await view.flush();
  const dispatch = captured.dispatch;
  if (!dispatch) throw new Error('store dispatch was not captured');
  await act(async () => {
    dispatch({
      type: 'localMessage',
      block: {
        kind: 'user',
        id: 'user-1',
        text: 'question that survives compaction',
        timestamp: 0,
      },
    });
    dispatch({ type: 'localMessage', block });
    await Promise.resolve();
  });
  return view;
}

async function click(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('summary blocks', () => {
  it('renders a compaction summary collapsed and expands it on click', async () => {
    const view = await renderTranscriptWith(compaction);

    const header = query(view.container, '.summary-header');
    expect(header.textContent).toContain('compaction summary');
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(view.container.querySelectorAll('.summary-body')).toHaveLength(0);
    expect(view.container.textContent).not.toContain('we refactored it');
    // Earlier messages stay readable next to the collapsed summary.
    expect(view.container.textContent).toContain('question that survives compaction');

    await click(header);
    expect(query(view.container, '.summary-header').getAttribute('aria-expanded')).toBe('true');
    expect(view.container.textContent).toContain('we refactored it');

    await click(query(view.container, '.summary-header'));
    expect(view.container.querySelectorAll('.summary-body')).toHaveLength(0);
  });

  it('renders branch summaries with their own label', async () => {
    const view = await renderTranscriptWith({
      kind: 'branch',
      id: 'branch-1',
      summary: 'branched from an earlier turn',
      detail: 'from entry-3',
      timestamp: 1,
    });
    const header = query(view.container, '.summary-header');
    expect(header.textContent).toContain('branch summary');
    expect(header.textContent).toContain('from entry-3');
  });
});

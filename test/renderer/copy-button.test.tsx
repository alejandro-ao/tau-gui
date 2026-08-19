// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBridge, mount, query, type Mounted } from './harness.js';
import type { TranscriptBlock } from '../../src/renderer/src/state/types.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

describe('CopyButton', () => {
  it('copies through the preload IPC bridge and renders as an icon', async () => {
    const bridge = installFakeBridge();
    const { CopyButton } = await import('../../src/renderer/src/components/CopyButton.js');
    mounted = await mount(<CopyButton text="message text" label="message" />);

    const button = query<HTMLButtonElement>(mounted.container, 'button');
    expect(button.getAttribute('aria-label')).toBe('Copy message');
    expect(button.textContent).toBe('');
    expect(button.querySelector('svg')).not.toBeNull();

    await act(async () => {
      button.click();
      await Promise.resolve();
    });

    expect(bridge.payloads('ui.copyText')).toEqual([{ text: 'message text' }]);
    expect(button.getAttribute('aria-label')).toBe('Copied message');
  });

  it('places message icons below and outside message blocks', async () => {
    installFakeBridge();
    const { BlockView } = await import('../../src/renderer/src/components/BlockView.js');
    const blocks: TranscriptBlock[] = [
      { kind: 'user', id: 'user-1', text: 'question', timestamp: 1 },
      {
        kind: 'assistant',
        id: 'assistant-1',
        text: 'answer',
        streaming: false,
        aborted: false,
        timestamp: 2,
      },
    ];

    mounted = await mount(
      <div>
        {blocks.map((block) => (
          <BlockView key={block.id} block={block} expanded={false} onToggle={() => undefined} />
        ))}
      </div>,
    );

    expect(mounted.container.querySelector('.block-user .copy-button')).toBeNull();
    expect(mounted.container.querySelector('.block-assistant .copy-button')).toBeNull();
    const actions = [...mounted.container.querySelectorAll('.message-actions')];
    expect(actions).toHaveLength(2);
    expect(actions.map((action) => action.previousElementSibling?.tagName)).toEqual([
      'ARTICLE',
      'ARTICLE',
    ]);
  });
});

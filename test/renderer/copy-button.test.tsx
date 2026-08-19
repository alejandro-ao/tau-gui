// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBridge, mount, query, type Mounted } from './harness.js';

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
});

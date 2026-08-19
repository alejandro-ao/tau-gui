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

function assistant(index: number): TranscriptBlock {
  return {
    kind: 'assistant',
    id: `assistant-${index}`,
    text: `message ${index}`,
    streaming: false,
    aborted: false,
    timestamp: index,
  };
}

interface Harness {
  view: Mounted;
  viewport: HTMLElement;
  dispatch: (action: Action) => void;
}

async function renderTranscript(count: number): Promise<Harness> {
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
  // Seeded after bootstrap so the store's initial hydrate does not clear it.
  await view.flush();
  const seed = captured.dispatch;
  if (!seed) throw new Error('store dispatch was not captured');
  await act(async () => {
    for (let index = 0; index < count; index += 1) {
      seed({ type: 'localMessage', block: assistant(index) });
    }
    await Promise.resolve();
  });

  const viewport = query(view.container, '.transcript');
  return { view, viewport, dispatch: seed };
}

/** jsdom has no layout, so scroll geometry is provided explicitly. */
function setGeometry(
  element: HTMLElement,
  geometry: { scrollTop: number; clientHeight: number; scrollHeight: number },
): void {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, { value, configurable: true, writable: true });
  }
}

async function scroll(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new Event('scroll'));
    await Promise.resolve();
  });
}

describe('transcript virtualization', () => {
  it('mounts only nearby blocks and marks the hidden tail', async () => {
    const { view, viewport } = await renderTranscript(200);

    const rendered = view.container.querySelectorAll('.block-assistant');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(60);
    expect(view.container.textContent).toContain('message 0');
    expect(view.container.textContent).not.toContain('message 199');
    expect(query(viewport, '.boundary[data-edge="bottom"]').textContent).toContain(
      'newer output below',
    );
    expect(viewport.querySelector('.boundary[data-edge="top"]')).toBeNull();
  });

  it('keeps state so far-away blocks remount when scrolled into view', async () => {
    const { view, viewport } = await renderTranscript(200);

    setGeometry(viewport, { scrollTop: 27_000, clientHeight: 600, scrollHeight: 28_000 });
    await scroll(viewport);

    expect(view.container.textContent).toContain('message 199');
    expect(view.container.textContent).not.toContain('message 0');
    expect(query(viewport, '.boundary[data-edge="top"]').textContent).toContain(
      'older output above',
    );
  });
});

describe('transcript scroll anchoring', () => {
  it('suppresses autoscroll and offers a jump affordance when scrolled up', async () => {
    const { view, viewport, dispatch } = await renderTranscript(20);
    expect(view.container.querySelector('.new-output')).toBeNull();

    setGeometry(viewport, { scrollTop: 0, clientHeight: 400, scrollHeight: 5_000 });
    await scroll(viewport);

    await act(async () => {
      dispatch({ type: 'localMessage', block: assistant(999) });
      await Promise.resolve();
    });

    const affordance = query(view.container, '.new-output');
    expect(affordance.textContent?.trim()).toBe('↓');
    expect(affordance.getAttribute('aria-label')).toBe('Go to bottom');

    await act(async () => {
      affordance.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.container.querySelector('.new-output')).toBeNull();
    expect(viewport.scrollTop).toBe(4_600);
  });

  it('jumps to the bottom when the user sends a message while scrolled up', async () => {
    const { view, viewport, dispatch } = await renderTranscript(20);

    setGeometry(viewport, { scrollTop: 0, clientHeight: 400, scrollHeight: 5_000 });
    await scroll(viewport);

    await act(async () => {
      dispatch({
        type: 'localMessage',
        block: { kind: 'user', id: 'user-1', text: 'hello', timestamp: 1 },
      });
      await Promise.resolve();
    });

    expect(viewport.scrollTop).toBe(4_600);
    expect(view.container.querySelector('.new-output')).toBeNull();
  });

  it('stays pinned when heights settle after the send jump', async () => {
    const { view, viewport, dispatch } = await renderTranscript(50);

    setGeometry(viewport, { scrollTop: 0, clientHeight: 400, scrollHeight: 5_000 });
    await scroll(viewport);

    await act(async () => {
      dispatch({
        type: 'localMessage',
        block: { kind: 'user', id: 'user-1', text: 'hello', timestamp: 1 },
      });
      await Promise.resolve();
    });
    expect(viewport.scrollTop).toBe(4_600);

    // Browsers clamp scrollTop to scrollHeight - clientHeight. The freshly
    // mounted tail then measures taller before the jump's scroll event arrives.
    setGeometry(viewport, { scrollTop: 4_600, clientHeight: 400, scrollHeight: 8_000 });
    await scroll(viewport);

    // Still pinned: further output follows the tail, no affordance appears.
    await act(async () => {
      dispatch({ type: 'localMessage', block: assistant(999) });
      await Promise.resolve();
    });
    expect(view.container.querySelector('.new-output')).toBeNull();
    expect(viewport.scrollTop).toBe(7_600);
  });

  it('keeps following the tail while already at the bottom', async () => {
    const { view, viewport, dispatch } = await renderTranscript(5);
    setGeometry(viewport, { scrollTop: 4_600, clientHeight: 400, scrollHeight: 5_000 });
    await scroll(viewport);

    await act(async () => {
      dispatch({ type: 'localMessage', block: assistant(42) });
      await Promise.resolve();
    });

    expect(view.container.querySelector('.new-output')).toBeNull();
    expect(view.container.textContent).toContain('message 42');
  });
});

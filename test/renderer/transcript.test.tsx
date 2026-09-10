// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeBridge, mount, query, type Mounted } from './harness.js';
import type { Action, TranscriptBlock } from '../../src/renderer/src/state/types.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.restoreAllMocks();
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

describe('welcome panel', () => {
  async function renderWelcome(): Promise<{
    view: Mounted;
    dispatch: (action: Action) => void;
    captured: { dispatch: ((action: Action) => void) | null; modal: string | null };
  }> {
    installFakeBridge({ status: 'idle' });
    const { StoreProvider, useStore } = await import('../../src/renderer/src/state/store.js');
    const { Transcript } = await import('../../src/renderer/src/components/Transcript.js');

    const captured: { dispatch: ((action: Action) => void) | null; modal: string | null } = {
      dispatch: null,
      modal: null,
    };

    function Capture(): ReactNode {
      const store = useStore();
      captured.dispatch = store.dispatch;
      captured.modal = store.state.modal;
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
    if (!captured.dispatch) throw new Error('store dispatch was not captured');
    return { view, dispatch: captured.dispatch, captured };
  }

  it('shows session context and starter actions for an empty transcript', async () => {
    const { view } = await renderWelcome();

    const welcome = view.container.querySelector('.welcome');
    expect(welcome).not.toBeNull();
    expect(welcome?.textContent).toContain('New session');
    expect(welcome?.textContent).toContain('/work/project');
    expect(welcome?.textContent).toContain('main');
    expect(welcome?.textContent).toContain('tau 9.9.9-fake');
    expect(welcome?.textContent).toContain('Type a prompt below to begin');
    const labels = [...welcome!.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).toEqual(['pick a model', 'skills', 'prompts', 'change directory']);
  });

  it('opens the model picker from a starter action', async () => {
    const { view, captured } = await renderWelcome();
    const { click } = await import('./ui.js');

    const pickModel = view.container.querySelector<HTMLButtonElement>('.welcome button');
    expect(pickModel?.textContent).toBe('pick a model');
    await click(pickModel!);

    // openModal is local UI state; the modal host is not mounted here, so the
    // captured store state is the observable result.
    expect(captured.modal).toBe('model');
  });

  it('hides once the first transcript block arrives', async () => {
    const { view, dispatch } = await renderWelcome();

    await act(async () => {
      dispatch({ type: 'localMessage', block: assistant(0) });
      await Promise.resolve();
    });

    expect(view.container.querySelector('.welcome')).toBeNull();
    expect(view.container.textContent).toContain('message 0');
  });
});

describe('transcript virtualization', () => {
  it('mounts only nearby blocks without boundary markers', async () => {
    const { view, viewport } = await renderTranscript(200);

    const rendered = view.container.querySelectorAll('.block-assistant');
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered.length).toBeLessThan(60);
    expect(view.container.textContent).toContain('message 0');
    expect(view.container.textContent).not.toContain('message 199');
    expect(view.container.textContent).not.toContain('newer output below');
    expect(viewport.querySelector('.boundary')).toBeNull();
  });

  it('keeps state so far-away blocks remount when scrolled into view', async () => {
    const { view, viewport } = await renderTranscript(200);

    setGeometry(viewport, { scrollTop: 27_000, clientHeight: 600, scrollHeight: 28_000 });
    await scroll(viewport);

    expect(view.container.textContent).toContain('message 199');
    expect(view.container.textContent).not.toContain('message 0');
    expect(view.container.textContent).not.toContain('older output above');
    expect(viewport.querySelector('.boundary')).toBeNull();
  });
});

describe('sticky user prompt', () => {
  it('tracks the prompt for the response being read in both scroll directions', async () => {
    const { view, viewport, dispatch } = await renderTranscript(0);
    await act(async () => {
      dispatch({
        type: 'localMessage',
        block: { kind: 'user', id: 'user-1', text: 'first prompt', timestamp: 1 },
      });
      dispatch({ type: 'localMessage', block: assistant(1) });
      dispatch({
        type: 'localMessage',
        block: { kind: 'user', id: 'user-2', text: 'second prompt', timestamp: 2 },
      });
      dispatch({ type: 'localMessage', block: assistant(2) });
      await Promise.resolve();
    });

    setGeometry(viewport, { scrollTop: 0, clientHeight: 300, scrollHeight: 800 });
    viewport.getBoundingClientRect = () => ({ top: 100 }) as DOMRect;
    const prompts = [...viewport.querySelectorAll<HTMLElement>('[data-user-group-index]')];
    expect(prompts).toHaveLength(2);
    const documentTops = [100, 500];
    prompts.forEach((prompt, index) => {
      prompt.getBoundingClientRect = () =>
        ({ top: (documentTops[index] ?? 0) - viewport.scrollTop }) as DOMRect;
    });

    viewport.scrollTop = 250;
    await scroll(viewport);
    expect(query(view.container, '.pinned-user-message').textContent).toContain('first prompt');

    viewport.scrollTop = 650;
    await scroll(viewport);
    expect(query(view.container, '.pinned-user-message').textContent).toContain('second prompt');

    viewport.scrollTop = 250;
    await scroll(viewport);
    expect(query(view.container, '.pinned-user-message').textContent).toContain('first prompt');
    expect(prompts[1]?.classList.contains('user-message-reveal')).toBe(true);

    viewport.scrollTop = 0;
    await scroll(viewport);
    expect(view.container.querySelector('.pinned-user-message')).toBeNull();
    expect(prompts[0]?.classList.contains('user-message-reveal')).toBe(true);
  });
});

describe('transcript scroll anchoring', () => {
  it('suppresses autoscroll and offers a jump affordance when scrolled up', async () => {
    const { view, viewport, dispatch } = await renderTranscript(20);
    expect(view.container.querySelector('.new-output')).toBeNull();

    viewport.dispatchEvent(new WheelEvent('wheel'));
    setGeometry(viewport, { scrollTop: 0, clientHeight: 400, scrollHeight: 5_000 });
    await scroll(viewport);

    // Scrolling away from the tail shows the plain (unhighlighted) arrow.
    const affordance = query(view.container, '.new-output');
    expect(affordance.textContent?.trim()).toBe('↓');
    expect(affordance.getAttribute('aria-label')).toBe('Go to bottom');
    expect(affordance.classList.contains('new-output-unread')).toBe(false);

    // Incoming output while away marks the arrow as unread.
    await act(async () => {
      dispatch({ type: 'localMessage', block: assistant(999) });
      await Promise.resolve();
    });
    expect(query(view.container, '.new-output').classList.contains('new-output-unread')).toBe(true);

    // Clicking the arrow hides it immediately, then scrolls smoothly toward
    // the tail over a short eased animation driven by requestAnimationFrame.
    const view_ = viewport.ownerDocument.defaultView!;
    const pending: FrameRequestCallback[] = [];
    vi.spyOn(view_, 'requestAnimationFrame').mockImplementation((callback) => {
      pending.push(callback);
      return pending.length;
    });

    await act(async () => {
      affordance.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(view.container.querySelector('.new-output')).toBeNull();

    // Mid-animation the scroll position is between the start and the tail.
    const step = (): void => {
      const callback = pending.shift();
      callback?.(pending.length * 16);
    };
    step();
    expect(viewport.scrollTop).toBeGreaterThan(0);
    expect(viewport.scrollTop).toBeLessThan(4_600);

    while (pending.length > 0) step();
    expect(viewport.scrollTop).toBe(4_600);
    expect(view.container.querySelector('.new-output')).toBeNull();
  });

  it('jumps to the bottom when the user sends a message while scrolled up', async () => {
    const { view, viewport, dispatch } = await renderTranscript(20);

    viewport.dispatchEvent(new WheelEvent('wheel'));
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

    viewport.dispatchEvent(new WheelEvent('wheel'));
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

  it('does not let settling override a user scroll away from the tail', async () => {
    const { view, viewport, dispatch } = await renderTranscript(50);

    viewport.dispatchEvent(new WheelEvent('wheel'));
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

    viewport.dispatchEvent(new WheelEvent('wheel'));
    setGeometry(viewport, { scrollTop: 0, clientHeight: 400, scrollHeight: 8_000 });
    await scroll(viewport);
    await act(async () => {
      dispatch({ type: 'localMessage', block: assistant(999) });
      await Promise.resolve();
    });

    expect(viewport.scrollTop).toBe(0);
    expect(view.container.querySelector('.new-output')).not.toBeNull();
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

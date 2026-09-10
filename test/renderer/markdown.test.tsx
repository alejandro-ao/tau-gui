// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { installFakeBridge, mount, type FakeBridge, type Mounted } from './harness.js';
import { click } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function renderMarkdown(text: string): Promise<{ view: Mounted; bridge: FakeBridge }> {
  const bridge = installFakeBridge();
  const { Markdown } = await import('../../src/renderer/src/markdown.js');
  const view = await mount(<Markdown text={text} />);
  mounted = view;
  bridge.calls.length = 0;
  return { view, bridge };
}

describe('streaming markdown', () => {
  it('renders every update immediately and keeps a visible trailing reveal', async () => {
    const { StreamingMarkdown } = await import('../../src/renderer/src/markdown.js');
    const view = await mount(<StreamingMarkdown text="Hello" streaming />);
    mounted = view;
    expect(view.container.querySelector('.stream-token')?.textContent).toBe('Hello');

    await act(async () => {
      view.root.render(<StreamingMarkdown text="Hello, streamed" streaming />);
      await Promise.resolve();
    });
    expect(view.container.textContent).toBe('Hello, streamed');
    expect(view.container.querySelector('.stream-token')?.textContent).toBe('Hello, streamed');

    await act(async () => {
      view.root.render(<StreamingMarkdown text="Hello, streamed output" streaming />);
      await Promise.resolve();
    });
    expect(view.container.textContent).toBe('Hello, streamed output');
    expect(view.container.querySelector('.stream-token')?.textContent).toBe(
      'Hello, streamed output',
    );

    await act(async () => {
      view.root.render(<StreamingMarkdown text="Hello, streamed output" streaming={false} />);
      await Promise.resolve();
    });
    expect(view.container.querySelector('.stream-token')).toBeNull();
  });

  it('keeps the animated DOM tail bounded for large chunks', async () => {
    installFakeBridge();
    const { Markdown } = await import('../../src/renderer/src/markdown.js');
    const view = await mount(
      <Markdown text={'a'.repeat(100)} revealCharacters={24} revealRevision={1} />,
    );
    mounted = view;

    expect(view.container.querySelector('.stream-token')?.textContent).toBe('a'.repeat(24));
    expect(view.container.textContent).toBe('a'.repeat(100));
  });
});

describe('markdown links', () => {
  it('keeps http, https, and mailto links navigable through the main process', async () => {
    const { view, bridge } = await renderMarkdown(
      '[web](https://example.com/docs) [plain](http://example.com) [mail](mailto:a@example.com)',
    );
    const anchors = [...view.container.querySelectorAll('a')];
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([
      'https://example.com/docs',
      'http://example.com/',
      'mailto:a@example.com',
    ]);

    await click(anchors[0]!);
    expect(bridge.payloads('ui.openExternal')).toEqual([{ url: 'https://example.com/docs' }]);
  });

  it('renders a javascript: link as inert text with no href', async () => {
    const { view, bridge } = await renderMarkdown('[click me](javascript:alert(1))');
    expect(view.container.querySelector('a')).toBeNull();
    const inert = view.container.querySelector('.inert-link');
    expect(inert?.textContent).toBe('click me');
    expect(view.container.innerHTML).not.toContain('javascript:');

    await click(inert!);
    expect(bridge.calls).toEqual([]);
  });

  it('renders a file: link as inert text with no href', async () => {
    const { view, bridge } = await renderMarkdown('[secrets](file:///etc/passwd)');
    expect(view.container.querySelector('a')).toBeNull();
    expect(view.container.querySelector('.inert-link')?.textContent).toBe('secrets');
    expect(view.container.innerHTML).not.toContain('file://');

    await click(view.container.querySelector('.inert-link')!);
    expect(bridge.calls).toEqual([]);
  });

  it('renders relative links as inert text', async () => {
    const { view } = await renderMarkdown('[readme](./README.md)');
    expect(view.container.querySelector('a')).toBeNull();
    expect(view.container.querySelector('.inert-link')?.textContent).toBe('readme');
  });
});

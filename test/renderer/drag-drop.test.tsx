// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Mounted } from './harness.js';
import { composer, renderApp, type } from './ui.js';

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

function fileWithPath(name: string, path: string): File {
  const file = new File(['content'], name);
  // Electron exposes the real path through the preload bridge, not File.path.
  Object.defineProperty(file, 'path', { value: path });
  return file;
}

async function drop(files: File[]): Promise<void> {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  await act(async () => {
    window.dispatchEvent(event);
    await Promise.resolve();
  });
}

describe('file drop', () => {
  it('inserts relativized paths at the cursor and quotes spaces', async () => {
    const { view, bridge } = await renderApp({
      results: { 'fs.relativize': ['src/app.ts', 'notes/a b.md'] },
    });
    mounted = view;
    await type(composer(view), 'please read');

    await drop([
      fileWithPath('app.ts', '/work/project/src/app.ts'),
      fileWithPath('a b.md', '/work/project/notes/a b.md'),
    ]);
    await view.flush();

    expect(bridge.payloads('fs.relativize')).toEqual([
      { paths: ['/work/project/src/app.ts', '/work/project/notes/a b.md'] },
    ]);
    expect(composer(view).value).toBe('please read src/app.ts "notes/a b.md"');
  });

  it('ignores drops without file paths', async () => {
    const { view, bridge } = await renderApp({});
    mounted = view;
    await drop([]);
    await view.flush();
    expect(bridge.payloads('fs.relativize')).toEqual([]);
  });
});

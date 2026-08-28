import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TauBridge } from '../src/preload/index.js';

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  exposed: null as TauBridge | null,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, bridge: TauBridge) => {
      mocks.exposed = bridge;
    },
  },
  ipcRenderer: {
    invoke: mocks.invoke,
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  webUtils: { getPathForFile: vi.fn(() => '') },
}));

beforeAll(async () => {
  await import('../src/preload/index.js');
});

describe('preload response validation', () => {
  it.each([
    ['agent.entries', { entries: [], leafId: 'x'.repeat(2 * 1024 * 1024) }],
    ['agent.tree', { tree: [], leafId: 'x'.repeat(2 * 1024 * 1024) }],
  ] as const)('rejects oversized %s wrappers returned by main', async (action, value) => {
    mocks.invoke.mockResolvedValueOnce({ ok: true, value });
    await expect(mocks.exposed!.invoke(action)).rejects.toThrow();
  });

  it('rejects oversized direct-shell output returned by main', async () => {
    mocks.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        command: 'huge',
        output: 'x'.repeat(64 * 1024 + 1),
        exitCode: 0,
        cancelled: false,
        truncated: false,
      },
    });

    await expect(mocks.exposed!.invoke('shell.run', { command: 'huge' })).rejects.toThrow();
  });

  it('independently rejects an aggregate-invalid tool schema returned by main', async () => {
    mocks.invoke.mockResolvedValueOnce({
      ok: true,
      value: {
        tools: [
          {
            name: 'hostile',
            description: '',
            origin: 'test',
            active: true,
            parameters: Object.fromEntries(
              Array.from({ length: 101 }, (_, index) => [`p${index}`, index]),
            ),
            schemaTruncated: false,
          },
        ],
        total: 1,
        truncated: false,
        diagnostics: [],
      },
    });

    await expect(mocks.exposed!.invoke('tools.list')).rejects.toThrow(
      'schema object property limit exceeded',
    );
  });
});

import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AppSettings, EntrySnapshot } from '../src/shared/domain.js';
import type { RuntimeProbe } from '../src/shared/ipc.js';

const electronMocks = vi.hoisted(() => ({ writeText: vi.fn(), showOpenDialog: vi.fn() }));

vi.mock('electron', () => ({
  clipboard: { writeText: electronMocks.writeText },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: electronMocks.showOpenDialog },
  Notification: { isSupported: () => false },
  shell: { openExternal: vi.fn() },
}));

const resourceMocks = vi.hoisted(() => ({
  discover: vi.fn(() => Promise.resolve({ skills: [], prompts: [], diagnostics: [] })),
}));
vi.mock('../src/main/services/resources.js', () => ({
  discoverTauResources: resourceMocks.discover,
}));

const { handleRequest } = await import('../src/main/ipc.js');
type Context = Parameters<typeof handleRequest>[0];

let binDir: string;
let script: string;

beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), 'tau-gui-handlers-'));
  script = join(binDir, 'configured-tau');
  writeFileSync(script, '#!/bin/sh\necho "configured tau 1.0.0"\n');
  chmodSync(script, 0o755);
});

interface Calls {
  abortShell: number;
  entries: (string | undefined)[];
  openedDirectories: string[];
}

function makeContext(settingsPatch: Partial<AppSettings> = {}): {
  context: Context;
  calls: Calls;
} {
  const settings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...settingsPatch,
    runtime: { ...DEFAULT_SETTINGS.runtime, ...(settingsPatch.runtime ?? {}) },
  };
  const calls: Calls = { abortShell: 0, entries: [], openedDirectories: [] };
  const snapshot: EntrySnapshot = { entries: [], leafId: 'entry-3' };

  const active = {
    abortShell: (): Promise<void> => {
      calls.abortShell += 1;
      return Promise.resolve();
    },
    getEntries: (cursor?: string): Promise<EntrySnapshot> => {
      calls.entries.push(cursor);
      return Promise.resolve(snapshot);
    },
  };

  const context = {
    settings: { current: settings } as Context['settings'],
    manager: {
      active,
      runtimeFor: () => active,
      openSession: (cwd: string) => {
        calls.openedDirectories.push(cwd);
        return Promise.resolve({ runtime: 'tau', cwd });
      },
      snapshot: () => ({ runtime: 'tau', cwd: '/project' }),
    } as unknown as Context['manager'],
    window: () => null,
  } as Context;
  return { context, calls };
}

describe('clipboard handler', () => {
  it('writes renderer text with Electron clipboard access', async () => {
    const { context } = makeContext();

    await handleRequest(context, { action: 'ui.copyText', payload: { text: 'copy me' } });

    expect(electronMocks.writeText).toHaveBeenCalledWith('copy me');
  });
});

describe('directory chooser handler', () => {
  it('uses the native directory-only dialog and returns its selected path', async () => {
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/work/chosen'],
    });
    const { context } = makeContext();

    await expect(handleRequest(context, { action: 'fs.pickDirectory' })).resolves.toBe(
      '/work/chosen',
    );
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openDirectory', 'createDirectory'] }),
    );
  });
});

describe('fresh directory session handler', () => {
  it('routes the validated cwd to the runtime pool operation', async () => {
    const { context, calls } = makeContext();

    await handleRequest(context, {
      action: 'runtime.openSession',
      payload: { cwd: '/work/chosen' },
    });

    expect(calls.openedDirectories).toEqual(['/work/chosen']);
  });
});

describe('runtime.probe handler', () => {
  it('always probes the binary from settings, ignoring renderer input', async () => {
    const { context } = makeContext({
      agentRuntime: 'tau',
      runtime: {
        tau: { binary: script, provider: null, model: null, extraArgs: [] },
        pi: { binary: script, provider: null, model: null, extraArgs: [] },
      },
    });

    // Even when a rogue renderer smuggles a binary through, it is not executed.
    const probe = (await handleRequest(context, {
      action: 'runtime.probe',
      payload: { kind: 'tau', binary: '/bin/sh' } as { kind: 'tau' },
    })) as RuntimeProbe;

    expect(probe.binary).toBe(script);
    expect(probe.resolved).toBe(script);
    expect(probe.version).toBe('configured tau 1.0.0');
    expect(probe.error).toBeNull();
  });

  it('defaults to the active runtime kind and reports missing binaries', async () => {
    const { context } = makeContext({
      agentRuntime: 'pi',
      runtime: {
        tau: { binary: script, provider: null, model: null, extraArgs: [] },
        pi: { binary: 'pi-not-installed-anywhere', provider: null, model: null, extraArgs: [] },
      },
    });
    const probe = (await handleRequest(context, { action: 'runtime.probe' })) as RuntimeProbe;
    expect(probe.binary).toBe('pi-not-installed-anywhere');
    expect(probe.resolved).toBeNull();
    expect(probe.error).toContain('was not found on PATH');
  });
});

describe('resources.list handler', () => {
  it.each([
    ['default', false],
    ['decline-once', false],
    ['approve-once', true],
  ] as const)('includes project paths for %s trust: %s', async (projectTrust, includeProject) => {
    resourceMocks.discover.mockResolvedValueOnce({ skills: [], prompts: [], diagnostics: [] });
    const { context } = makeContext({ projectTrust });

    await handleRequest(context, { action: 'resources.list' });

    expect(resourceMocks.discover).toHaveBeenLastCalledWith('/project', { includeProject });
  });

  it('rejects malformed discovery output before it crosses IPC', async () => {
    resourceMocks.discover.mockResolvedValueOnce({
      skills: [{ name: 'leak', description: null, origin: 'project', content: 'secret' }],
      prompts: [],
      diagnostics: [],
    } as never);
    const { context } = makeContext({ projectTrust: 'approve-once' });

    await expect(handleRequest(context, { action: 'resources.list' })).rejects.toThrow();
  });
});

describe('capability-gated and adapter-contract actions', () => {
  it('routes shell.abort to the adapter', async () => {
    const { context, calls } = makeContext();
    expect(await handleRequest(context, { action: 'shell.abort' })).toBeNull();
    expect(calls.abortShell).toBe(1);
  });

  it('routes agent.entries with and without a cursor', async () => {
    const { context, calls } = makeContext();
    expect(await handleRequest(context, { action: 'agent.entries' })).toMatchObject({
      leafId: 'entry-3',
    });
    await handleRequest(context, { action: 'agent.entries', payload: { cursor: 'entry-1' } });
    expect(calls.entries).toEqual([undefined, 'entry-1']);
  });
});

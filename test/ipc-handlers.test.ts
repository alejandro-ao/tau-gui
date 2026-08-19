import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AppSettings, EntrySnapshot } from '../src/shared/domain.js';
import type { RuntimeProbe } from '../src/shared/ipc.js';

const electronMocks = vi.hoisted(() => ({ writeText: vi.fn() }));

vi.mock('electron', () => ({
  clipboard: { writeText: electronMocks.writeText },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  Notification: { isSupported: () => false },
  shell: { openExternal: vi.fn() },
}));

const resourceMocks = vi.hoisted(() => ({
  discover: vi.fn(() => Promise.resolve({ skills: [], prompts: [], diagnostics: [] })),
}));
const contextFileMocks = vi.hoisted(() => ({
  discover: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../src/main/services/resources.js', () => ({
  discoverTauResources: resourceMocks.discover,
}));
vi.mock('../src/main/services/context-files.js', () => ({
  discoverContextFiles: contextFileMocks.discover,
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
}

function makeContext(settingsPatch: Partial<AppSettings> = {}): {
  context: Context;
  calls: Calls;
} {
  let appSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...settingsPatch,
    runtime: { ...DEFAULT_SETTINGS.runtime, ...(settingsPatch.runtime ?? {}) },
  };
  const launchProjectTrust = appSettings.projectTrust;
  const calls: Calls = { abortShell: 0, entries: [] };
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
    settings: {
      get current() {
        return appSettings;
      },
      update(patch: Partial<AppSettings>) {
        appSettings = { ...appSettings, ...patch };
        return appSettings;
      },
    } as Context['settings'],
    manager: {
      active,
      runtimeFor: () => active,
      snapshot: () => ({ runtime: 'tau', cwd: '/project' }),
      effectiveProjectTrust: launchProjectTrust,
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

  it('keeps resource discovery bound to launch-time trust after settings change', async () => {
    resourceMocks.discover.mockResolvedValueOnce({ skills: [], prompts: [], diagnostics: [] });
    const { context } = makeContext({ projectTrust: 'approve-once' });
    context.settings.update({ projectTrust: 'decline-once' });

    await handleRequest(context, { action: 'resources.list' });

    expect(resourceMocks.discover).toHaveBeenLastCalledWith('/project', { includeProject: true });
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

describe('context.list handler', () => {
  it.each([
    ['default', false],
    ['decline-once', false],
    ['approve-once', true],
  ] as const)('includes project paths for %s trust: %s', async (projectTrust, includeProject) => {
    contextFileMocks.discover.mockResolvedValueOnce([]);
    const { context } = makeContext({ projectTrust });

    await handleRequest(context, { action: 'context.list' });

    expect(contextFileMocks.discover).toHaveBeenLastCalledWith('/project', { includeProject });
  });

  it.each([
    ['approve-once', 'decline-once', true],
    ['decline-once', 'approve-once', false],
  ] as const)(
    'keeps context discovery bound to %s launch trust after settings change to %s',
    async (launchTrust, changedTrust, includeProject) => {
      contextFileMocks.discover.mockResolvedValueOnce([]);
      const { context } = makeContext({ projectTrust: launchTrust });
      context.settings.update({ projectTrust: changedTrust });

      await handleRequest(context, { action: 'context.list' });

      expect(contextFileMocks.discover).toHaveBeenLastCalledWith('/project', { includeProject });
    },
  );

  it('rejects extra or malformed metadata before it crosses IPC', async () => {
    contextFileMocks.discover.mockResolvedValueOnce([
      { label: './.tau/AGENTS.md', path: '/project/.tau/AGENTS.md', content: 'secret' },
    ] as never);
    const { context } = makeContext({ projectTrust: 'approve-once' });

    await expect(handleRequest(context, { action: 'context.list' })).rejects.toThrow();
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

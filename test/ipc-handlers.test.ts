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
  queued: { kind: string; text: string; target: unknown }[];
  popped: number;
  resolved: { id: string; outcome: string; target: unknown }[];
  openedDirectories: string[];
  resourceDirectories: { kind: 'skills' | 'prompts'; path: string }[];
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
  const calls: Calls = {
    abortShell: 0,
    entries: [],
    queued: [],
    popped: 0,
    resolved: [],
    openedDirectories: [],
    resourceDirectories: [],
  };
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
      addResourceDirectory(kind: 'skills' | 'prompts', path: string) {
        calls.resourceDirectories.push({ kind, path });
        const key = kind === 'skills' ? 'customSkillDirectories' : 'customPromptDirectories';
        appSettings = { ...appSettings, [key]: [...appSettings[key], path] };
        return appSettings;
      },
      removeResourceDirectory(kind: 'skills' | 'prompts', path: string) {
        const key = kind === 'skills' ? 'customSkillDirectories' : 'customPromptDirectories';
        appSettings = {
          ...appSettings,
          [key]: appSettings[key].filter((directory) => directory !== path),
        };
        return appSettings;
      },
    } as Context['settings'],
    manager: {
      active,
      runtimeFor: () => active,
      enqueuePrompt: (kind: string, text: string, target: unknown) =>
        calls.queued.push({ kind, text, target }),
      queueSnapshot: () => ({
        runtime: 'tau',
        sessionId: 'session-1',
        steering: [],
        followUp: [],
      }),
      popPrompt: () => {
        calls.popped += 1;
        return { id: 'prompt-1', kind: 'follow-up', text: 'edit me' };
      },
      resolvePromptRecall: (id: string, outcome: string, target: unknown) => {
        calls.resolved.push({ id, outcome, target });
        return true;
      },
      openSession: (cwd: string) => {
        calls.openedDirectories.push(cwd);
        return Promise.resolve({ runtime: 'tau', cwd });
      },
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

  it('persists a custom resource path only after native chooser selection', async () => {
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/work/shared-skills'],
    });
    const { context, calls } = makeContext();

    await handleRequest(context, {
      action: 'settings.addResourceDirectory',
      payload: { kind: 'skills' },
    });

    expect(calls.resourceDirectories).toEqual([{ kind: 'skills', path: '/work/shared-skills' }]);
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Add skills directory' }),
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

  it('routes editable submissions and atomic pop through the application queue', async () => {
    const { context, calls } = makeContext();
    const session = { runtime: 'tau' as const, sessionId: 'session-1' };
    await handleRequest(context, {
      action: 'agent.steer',
      payload: { text: 'priority' },
      session,
    });
    await handleRequest(context, {
      action: 'agent.followUp',
      payload: { text: 'later' },
      session,
    });
    expect(calls.queued).toEqual([
      { kind: 'steering', text: 'priority', target: session },
      { kind: 'follow-up', text: 'later', target: session },
    ]);
    expect(await handleRequest(context, { action: 'queue.pop', session })).toMatchObject({
      id: 'prompt-1',
      text: 'edit me',
    });
    expect(calls.popped).toBe(1);
    expect(
      await handleRequest(context, {
        action: 'queue.resolve',
        payload: { id: 'prompt-1', outcome: 'restore' },
        session,
      }),
    ).toBe(true);
    expect(calls.resolved).toEqual([{ id: 'prompt-1', outcome: 'restore', target: session }]);
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

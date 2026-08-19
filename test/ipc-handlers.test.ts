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
  queued: { kind: string; text: string; target: unknown }[];
  popped: number;
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
  const calls: Calls = { abortShell: 0, entries: [], queued: [], popped: 0 };
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

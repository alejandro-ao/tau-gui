import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAPABILITIES, DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AppSettings, EntrySnapshot } from '../src/shared/domain.js';
import { bridgeEventSchema, parseSessionIpcResult } from '../src/shared/ipc.js';

const electronMocks = vi.hoisted(() => ({
  writeText: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  showMessageBox: vi.fn(() => Promise.resolve({ response: 0 })),
}));

vi.mock('electron', () => ({
  clipboard: { writeText: electronMocks.writeText },
  dialog: {
    showSaveDialog: electronMocks.showSaveDialog,
    showOpenDialog: electronMocks.showOpenDialog,
    showMessageBox: electronMocks.showMessageBox,
  },
  Notification: { isSupported: () => false },
  shell: { openExternal: vi.fn() },
}));

const { handleRequest } = await import('../src/main/ipc.js');
type Context = Parameters<typeof handleRequest>[0];

interface Calls {
  abortShell: number;
  entries: (string | undefined)[];
  queued: { kind: string; text: string; target: unknown }[];
  popped: number;
  resolved: { id: string; outcome: string; target: unknown }[];
  openedDirectories: string[];
  prompts: { input: { text: string }; target: unknown }[];
  resourceDirectories: { kind: 'skills' | 'prompts'; path: string }[];
  labels: { entryId: string; label: string | null }[];
  clones: unknown[];
  imports: string[];
  jsonlExports: { path: string; sessionId?: string }[];
  names: string[];
  refreshed: number;
  imagePrepare: number;
}

function makeContext(settingsPatch: Partial<AppSettings> = {}): {
  context: Context;
  calls: Calls;
} {
  let appSettings: AppSettings = {
    ...DEFAULT_SETTINGS,
    ...settingsPatch,
  };
  const launchProjectTrust = appSettings.projectTrust;
  const calls: Calls = {
    abortShell: 0,
    entries: [],
    queued: [],
    popped: 0,
    resolved: [],
    openedDirectories: [],
    prompts: [],
    resourceDirectories: [],
    labels: [],
    clones: [],
    imports: [],
    jsonlExports: [],
    names: [],
    refreshed: 0,
    imagePrepare: 0,
  };
  const snapshot: EntrySnapshot = { entries: [], leafId: 'entry-3' };

  const active = {
    capabilities: { ...DEFAULT_CAPABILITIES, sessionList: true },
    kind: 'pi' as const,
    getState: () =>
      Promise.resolve({
        model: {
          id: 'text-model',
          name: 'Text Model',
          provider: 'fake',
          api: 'fake',
          reasoning: false,
          input: ['text'],
          contextWindow: 1_000,
          maxTokens: 100,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
        thinkingLevel: 'off' as const,
        isStreaming: false,
        isCompacting: false,
        persisted: true,
        sessionFile: '/private/session.jsonl',
        sessionId: 'session-1',
        sessionName: null,
        autoCompactionEnabled: true,
        messageCount: 1,
        pendingMessageCount: 0,
      }),
    abortShell: (): Promise<void> => {
      calls.abortShell += 1;
      return Promise.resolve();
    },
    getEntries: (cursor?: string): Promise<EntrySnapshot> => {
      calls.entries.push(cursor);
      return Promise.resolve(snapshot);
    },
    setLabel: (entryId: string, label: string | null) => {
      calls.labels.push({ entryId, label });
      return Promise.resolve();
    },
    listSessions: () =>
      Promise.resolve([
        {
          id: `pi-${'a'.repeat(32)}`,
          source: 'native' as const,
          runtime: 'pi' as const,
          sessionId: 'session-1',
          exportable: true,
          name: null,
          firstMessage: 'Task',
          cwd: '/project',
          createdAt: 1,
          modifiedAt: 2,
          messageCount: 1,
          parentSessionId: null,
        },
      ]),
    exportJsonl: (path: string, sessionId?: string) => {
      calls.jsonlExports.push({ path, ...(sessionId ? { sessionId } : {}) });
      return Promise.resolve(path);
    },
    getTree: () => Promise.resolve({ rows: [], leafId: snapshot.leafId, truncated: false }),
    inspectSystemPrompt: () =>
      Promise.resolve({
        text: 'private system prompt',
        totalCharacters: 21,
        truncated: false,
        origin: 'active Pi session',
      }),
    listTools: () =>
      Promise.resolve({
        tools: [
          {
            name: 'read',
            description: 'Read files',
            origin: 'builtin',
            active: true,
            parameters: { type: 'object' },
            schemaTruncated: false,
          },
        ],
        total: 1,
        truncated: false,
        diagnostics: [],
      }),
    runShell: (command: string) =>
      Promise.resolve({
        command,
        output: 'ok',
        exitCode: 0,
        cancelled: false,
        truncated: false,
      }),
    reloadResources: () =>
      Promise.resolve({
        before: { skills: 1, prompts: 1, themes: 2, contextFiles: 1, extensions: 0, tools: 4 },
        after: { skills: 2, prompts: 1, themes: 2, contextFiles: 1, extensions: 0, tools: 4 },
        diagnostics: [],
      }),
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
    importRecovery: {
      health: () => Promise.resolve({ retained: 2, capacity: 32 }),
      reveal: () => Promise.resolve(),
    },
    manager: {
      active,
      runtimeFor: () => active,
      readRuntime: (_target: unknown, operation: (runtime: typeof active) => Promise<unknown>) =>
        operation(active),
      mutateRuntime: (_target: unknown, operation: (runtime: typeof active) => Promise<unknown>) =>
        operation(active),
      prompt: (input: { text: string }, target: unknown) => {
        calls.prompts.push({ input, target });
        return Promise.resolve();
      },
      enqueuePrompt: (kind: string, text: string, target: unknown) =>
        calls.queued.push({ kind, text, target }),
      queueSnapshot: () => ({
        runtime: 'pi',
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
        return Promise.resolve({ runtime: 'pi', cwd });
      },
      cloneSession: (target: unknown) => {
        calls.clones.push(target);
        return Promise.resolve({ runtime: 'pi' });
      },
      importSession: (path: string) => {
        calls.imports.push(path);
        return Promise.resolve({ runtime: 'pi' });
      },
      nameSession: (name: string) => {
        calls.names.push(name);
        return Promise.resolve();
      },
      snapshot: () => ({ runtime: 'pi', cwd: '/project' }),
      effectiveProjectTrust: launchProjectTrust,
      refreshState: () => {
        calls.refreshed += 1;
        return Promise.resolve();
      },
      reloadResources: async () => {
        const result = await active.reloadResources();
        calls.refreshed += 1;
        return result;
      },
    } as unknown as Context['manager'],
    window: () => null,
    images: {
      prepare: () => {
        calls.imagePrepare += 1;
        return Promise.resolve([]);
      },
    } as unknown as Context['images'],
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

describe('Pi-owned resources and context handlers', () => {
  it('returns authoritative runtime metadata', async () => {
    const { context } = makeContext();
    const active = context.manager.runtimeFor();
    active.getResources = () => Promise.resolve({ skills: [], prompts: [], diagnostics: [] });
    active.getContextFiles = () =>
      Promise.resolve([{ label: 'AGENTS.md', path: '/project/AGENTS.md' }]);

    await expect(handleRequest(context, { action: 'resources.list' })).resolves.toEqual({
      skills: [],
      prompts: [],
      diagnostics: [],
    });
    await expect(handleRequest(context, { action: 'context.list' })).resolves.toEqual([
      { label: 'AGENTS.md', path: '/project/AGENTS.md' },
    ]);
  });

  it('rejects malformed runtime metadata before it crosses IPC', async () => {
    const { context } = makeContext();
    const active = context.manager.runtimeFor();
    active.getContextFiles = () =>
      Promise.resolve([
        { label: 'AGENTS.md', path: '/project/AGENTS.md', content: 'secret' },
      ] as never);
    await expect(handleRequest(context, { action: 'context.list' })).rejects.toThrow();
  });
});

describe('capability-gated and adapter-contract actions', () => {
  it('validates direct shell results in main before returning them', async () => {
    const { context } = makeContext();
    const active = context.manager.runtimeFor();
    active.runShell = () =>
      Promise.resolve({
        command: 'huge',
        output: 'x'.repeat(64 * 1024 + 1),
        exitCode: 0,
        cancelled: false,
        truncated: false,
      });

    await expect(
      handleRequest(context, {
        action: 'shell.run',
        payload: { command: 'huge', excludeFromContext: false },
      }),
    ).rejects.toThrow();
  });

  it('routes bounded local-only introspection and reload to the adapter', async () => {
    const { context, calls } = makeContext();
    const session = { runtime: 'pi' as const, sessionId: 'session-1' };

    await expect(
      handleRequest(context, { action: 'agent.inspectSystemPrompt', session }),
    ).resolves.toMatchObject({ text: 'private system prompt' });
    await expect(handleRequest(context, { action: 'tools.list', session })).resolves.toMatchObject({
      total: 1,
    });
    await expect(
      handleRequest(context, { action: 'resources.reload', session }),
    ).resolves.toMatchObject({ after: { skills: 2 } });
    expect(calls.refreshed).toBe(1);
  });

  it('rejects malformed introspection output at the main boundary', async () => {
    const { context } = makeContext();
    const active = context.manager.runtimeFor(null);
    active.inspectSystemPrompt = () => Promise.resolve({ text: process.env } as never);
    await expect(handleRequest(context, { action: 'agent.inspectSystemPrompt' })).rejects.toThrow();
  });

  it('routes shell.abort to the adapter', async () => {
    const { context, calls } = makeContext();
    expect(await handleRequest(context, { action: 'shell.abort' })).toBeNull();
    expect(calls.abortShell).toBe(1);
  });

  it('routes direct prompts through the pool work reservation', async () => {
    const { context, calls } = makeContext();
    const session = { runtime: 'pi' as const, sessionId: 'session-1' };
    await handleRequest(context, {
      action: 'agent.prompt',
      payload: { text: 'reserved direct work' },
      session,
    });
    expect(calls.prompts).toEqual([{ input: { text: 'reserved direct work' }, target: session }]);
  });

  it('routes editable submissions and atomic pop through the application queue', async () => {
    const { context, calls } = makeContext();
    const session = { runtime: 'pi' as const, sessionId: 'session-1' };
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

  it('redacts runtime-owned session paths from agent state', async () => {
    const { context } = makeContext();
    const state = await handleRequest(context, { action: 'agent.state' });
    expect(state).toMatchObject({ persisted: true, sessionId: 'session-1' });
    expect(state).not.toHaveProperty('sessionFile');
  });

  it('rejects oversized restored response identifiers at the main boundary', async () => {
    const { context } = makeContext();
    const active = context.manager.runtimeFor();
    const huge = 'x'.repeat(2 * 1024 * 1024);
    active.getEntries = () => Promise.resolve({ entries: [], leafId: huge });
    active.getTree = () => Promise.resolve({ rows: [], leafId: huge, truncated: false });

    await expect(handleRequest(context, { action: 'agent.entries' })).rejects.toThrow();
    await expect(handleRequest(context, { action: 'agent.tree' })).rejects.toThrow();
  });

  it.each([
    [
      'over-budget rows',
      {
        rows: Array.from({ length: 2_001 }, () => ({
          id: 'entry',
          parentId: null,
          depth: 0,
          kind: 'message',
          role: 'user',
          timestamp: '2026-01-01T00:00:00Z',
          preview: 'safe',
          label: null,
        })),
        leafId: null,
        truncated: true,
      },
    ],
    [
      'over-depth rows',
      {
        rows: [
          {
            id: 'entry',
            parentId: null,
            depth: 129,
            kind: 'message',
            role: 'user',
            timestamp: '2026-01-01T00:00:00Z',
            preview: 'safe',
            label: null,
          },
        ],
        leafId: null,
        truncated: true,
      },
    ],
  ] as const)('rejects a %s malformed adapter tree without stack overflow', async (_kind, tree) => {
    const { context } = makeContext();
    context.manager.runtimeFor().getTree = () => Promise.resolve(tree as never);

    const result = handleRequest(context, { action: 'agent.tree' });
    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toThrow(/maximum call stack|RangeError/i);
  });

  it('rejects image preparation when the active model is text-only', async () => {
    const { context, calls } = makeContext();
    await expect(
      handleRequest(context, {
        action: 'images.prepare',
        payload: { paths: ['/tmp/image.png'] },
      }),
    ).rejects.toThrow('does not support image prompts');
    expect(calls.imagePrepare).toBe(0);
  });

  it('routes agent.entries with and without a cursor', async () => {
    const { context, calls } = makeContext();
    expect(await handleRequest(context, { action: 'agent.entries' })).toMatchObject({
      leafId: 'entry-3',
    });
    await handleRequest(context, { action: 'agent.entries', payload: { cursor: 'entry-1' } });
    expect(calls.entries).toEqual([undefined, 'entry-1']);
  });

  it('routes bounded session catalog, labels, and clone through main ownership', async () => {
    const { context, calls } = makeContext();
    const target = { runtime: 'pi' as const, sessionId: 'session-1' };
    await expect(
      handleRequest(context, {
        action: 'session.list',
        payload: { scope: 'all' },
        session: target,
      }),
    ).resolves.toEqual([expect.objectContaining({ sessionId: 'session-1' })]);
    await handleRequest(context, {
      action: 'session.label',
      payload: { entryId: 'entry-1', label: 'bookmark' },
      session: target,
    });
    await handleRequest(context, { action: 'session.clone', session: target });
    expect(calls.labels).toEqual([{ entryId: 'entry-1', label: 'bookmark' }]);
    expect(calls.clones).toEqual([target]);
  });

  it('rejects a 501-character session name before mutation and preserves bounded outputs', async () => {
    const { context, calls } = makeContext();
    const event = { type: 'diagnostic', message: 'stable' } as const;
    const before = {
      settings: await handleRequest(context, { action: 'settings.get' }),
      state: await handleRequest(context, { action: 'agent.state' }),
      catalog: await handleRequest(context, {
        action: 'session.list',
        payload: { scope: 'all' },
      }),
      event,
    };

    await expect(
      handleRequest(context, {
        action: 'session.name',
        payload: { name: 'x'.repeat(501) },
      }),
    ).rejects.toThrow();

    expect(calls.names).toEqual([]);
    const after = {
      settings: await handleRequest(context, { action: 'settings.get' }),
      state: await handleRequest(context, { action: 'agent.state' }),
      catalog: await handleRequest(context, {
        action: 'session.list',
        payload: { scope: 'all' },
      }),
      event,
    };
    expect(after).toEqual(before);
    expect(() => parseSessionIpcResult('settings.get', after.settings)).not.toThrow();
    expect(() => parseSessionIpcResult('agent.state', after.state)).not.toThrow();
    expect(() => parseSessionIpcResult('session.list', after.catalog)).not.toThrow();
    expect(bridgeEventSchema.safeParse(after.event).success).toBe(true);

    await handleRequest(context, {
      action: 'session.name',
      payload: { name: '  release\u202E\nprep  ' },
    });
    expect(calls.names).toEqual(['release  prep']);
  });

  it('serves import recovery without resolving a selected runtime', async () => {
    const { context } = makeContext();
    context.manager.runtimeFor = () => {
      throw new Error('Session is no longer available: /private/failed-session');
    };

    await expect(handleRequest(context, { action: 'session.importHealth' })).resolves.toEqual({
      retained: 2,
      capacity: 32,
    });
    await expect(
      handleRequest(context, { action: 'session.revealImportRecovery' }),
    ).resolves.toBeNull();
  });

  it('explains create-new-only collisions and reopens the export dialog', async () => {
    electronMocks.showSaveDialog
      .mockResolvedValueOnce({ canceled: false, filePath: '/chosen/existing.jsonl' })
      .mockResolvedValueOnce({ canceled: false, filePath: '/chosen/new.jsonl' });
    const { context } = makeContext();
    const active = context.manager.runtimeFor(null);
    const originalExport = active.exportJsonl.bind(active);
    active.exportJsonl = vi.fn((path: string, sessionId?: string) => {
      if (path.endsWith('existing.jsonl')) {
        return Promise.reject(Object.assign(new Error('exists'), { code: 'EEXIST' }));
      }
      return originalExport(path, sessionId);
    });

    await expect(
      handleRequest(context, { action: 'session.exportJsonl', payload: {} }),
    ).resolves.toBe('/chosen/new.jsonl');
    const collisionOptions = electronMocks.showMessageBox.mock.calls[0]?.at(-1) as unknown;
    expect(collisionOptions).toMatchObject({
      message: 'That file already exists. Portable export creates new files only.',
    });
    expect(electronMocks.showSaveDialog).toHaveBeenCalledTimes(2);
  });

  it('gets import and export paths only from native dialogs', async () => {
    electronMocks.showOpenDialog.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/chosen/import.jsonl'],
    });
    electronMocks.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: '/chosen/export.jsonl',
    });
    const { context, calls } = makeContext();
    const target = { runtime: 'pi' as const, sessionId: 'session-1' };

    await handleRequest(context, { action: 'session.importJsonl', session: target });
    await handleRequest(context, {
      action: 'session.exportJsonl',
      payload: { sessionId: 'session-1' },
      session: target,
    });

    expect(calls.imports).toEqual(['/chosen/import.jsonl']);
    expect(calls.jsonlExports).toEqual([{ path: '/chosen/export.jsonl', sessionId: 'session-1' }]);
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ properties: ['openFile'] }),
    );
  });
});

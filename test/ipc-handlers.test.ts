import { vi, describe, expect, it } from 'vitest';
import { handleRequest } from '../src/main/ipc.js';
import { DEFAULT_SETTINGS } from '../src/shared/domain.js';
import type { AppSettings } from '../src/shared/domain.js';

const electron = vi.hoisted(() => ({ copy: vi.fn(), open: vi.fn() }));
vi.mock('electron', () => ({
  clipboard: { writeText: electron.copy },
  dialog: { showSaveDialog: vi.fn(), showOpenDialog: vi.fn() },
  Notification: { isSupported: () => false },
  shell: { openExternal: electron.open },
}));

type Context = Parameters<typeof handleRequest>[0];

function context() {
  let settings: AppSettings = { ...DEFAULT_SETTINGS, scopedModels: [] };
  const calls: string[] = [];
  const active = {
    prompt: ({ text }: { text: string }) => {
      calls.push(`prompt:${text}`);
      return Promise.resolve();
    },
    getResources: () => Promise.resolve({ skills: [], prompts: [], diagnostics: [] }),
    getContextFiles: () => Promise.resolve([]),
    getState: () =>
      Promise.resolve({
        model: null,
        thinkingLevel: 'off',
        isStreaming: false,
        isCompacting: false,
        sessionFile: null,
        sessionId: 'pi-session',
        sessionName: null,
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      }),
  };
  return {
    calls,
    value: {
      settings: {
        get current() {
          return settings;
        },
        update(patch: Partial<AppSettings>) {
          settings = { ...settings, ...patch };
          return settings;
        },
        toggleScopedModel(ref: { provider: string; modelId: string }) {
          settings = { ...settings, scopedModels: [JSON.stringify([ref.provider, ref.modelId])] };
          return settings;
        },
      },
      manager: {
        runtimeFor: () => active,
        snapshot: () => ({
          runtime: 'pi',
          status: 'idle',
          cwd: '/project',
          state: { sessionId: 'pi-session' },
        }),
        effectiveProjectTrust: 'default',
      },
      window: () => null,
    } as unknown as Context,
  };
}

describe('embedded Pi IPC handlers', () => {
  it('routes prompts to the injected Pi-domain runtime', async () => {
    const { value, calls } = context();
    await handleRequest(value, { action: 'agent.prompt', payload: { text: 'hello' } });
    expect(calls).toEqual(['prompt:hello']);
  });

  it('updates one Pi model scope without runtime selectors', async () => {
    const { value } = context();
    const result = await handleRequest(value, {
      action: 'settings.toggleScopedModel',
      payload: { provider: 'fake', modelId: 'model' },
    });
    expect(result).toMatchObject({ scopedModels: [JSON.stringify(['fake', 'model'])] });
  });

  it('uses only embedded runtime resource/context services', async () => {
    const { value } = context();
    await expect(handleRequest(value, { action: 'resources.list' })).resolves.toEqual({
      skills: [],
      prompts: [],
      diagnostics: [],
    });
    await expect(handleRequest(value, { action: 'context.list' })).resolves.toEqual([]);
  });

  it('keeps clipboard and external URLs behind main', async () => {
    const { value } = context();
    await handleRequest(value, { action: 'ui.copyText', payload: { text: 'copy' } });
    expect(electron.copy).toHaveBeenCalledWith('copy');
    await handleRequest(value, {
      action: 'ui.openExternal',
      payload: { url: 'https://example.com' },
    });
    expect(electron.open).toHaveBeenCalledWith('https://example.com/');
    await expect(
      handleRequest(value, { action: 'ui.openExternal', payload: { url: 'file:///etc/passwd' } }),
    ).rejects.toThrow('unsupported protocol');
  });
});

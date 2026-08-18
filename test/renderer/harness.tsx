import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type { AppSettings, RuntimeCapabilities, SessionStats } from '../../src/shared/domain.js';
import { DEFAULT_CAPABILITIES, DEFAULT_SETTINGS } from '../../src/shared/domain.js';
import type { BridgeEvent, IpcAction, RuntimeSnapshot } from '../../src/shared/ipc.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface InvokeCall {
  action: string;
  payload: Record<string, unknown> | undefined;
}

export interface FakeBridge {
  calls: InvokeCall[];
  emit: (event: BridgeEvent) => void;
  snapshot: RuntimeSnapshot;
}

export interface FakeBridgeOptions {
  status?: RuntimeSnapshot['status'];
  detail?: string | null;
  capabilities?: Partial<RuntimeCapabilities>;
  settings?: Partial<AppSettings>;
  stats?: SessionStats | null;
}

/** Installs a fake `window.tau` before renderer modules read the bridge. */
export function installFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const calls: InvokeCall[] = [];
  const snapshot: RuntimeSnapshot = {
    runtime: 'tau',
    status: options.status ?? 'idle',
    detail: options.detail ?? null,
    capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    cwd: '/work/project',
    gitBranch: 'main',
    state: null,
  };
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...options.settings };

  const results: Partial<Record<IpcAction, unknown>> = {
    'settings.get': settings,
    'settings.update': settings,
    'runtime.snapshot': snapshot,
    'runtime.start': snapshot,
    'runtime.stop': snapshot,
    'agent.messages': [],
    'agent.stats': options.stats ?? null,
    'models.list': [],
    'thinking.list': [],
    'commands.list': [],
    'agent.prompt': null,
    'agent.steer': null,
    'agent.followUp': null,
    'agent.abort': null,
    'shell.run': { command: '', output: 'ok', exitCode: 0, cancelled: false, truncated: false },
  };

  const bridge = {
    invoke: (action: string, payload?: Record<string, unknown>): Promise<unknown> => {
      calls.push({ action, payload });
      const value = results[action as IpcAction];
      return Promise.resolve(value === undefined ? null : value);
    },
    subscribe: (listener: (event: BridgeEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    platform: 'darwin',
  };

  // The bridge type is intentionally narrow; the fake satisfies it structurally.
  (window as unknown as { tau: unknown }).tau = bridge;

  return {
    calls,
    snapshot,
    emit: (event) => {
      for (const listener of listeners) listener(event);
    },
  };
}

export interface Mounted {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
  flush: () => Promise<void>;
}

export async function mount(ui: ReactNode): Promise<Mounted> {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(ui);
    await Promise.resolve();
  });
  return {
    container,
    root,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
    flush: async () => {
      await act(async () => {
        await Promise.resolve();
      });
    },
  };
}

export function query<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`No element matches ${selector}`);
  return element;
}

export function texts(root: ParentNode, selector: string): string[] {
  return [...root.querySelectorAll(selector)].map((element) => element.textContent ?? '');
}

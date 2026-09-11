import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import type {
  AgentState,
  AppSettings,
  RuntimeCapabilities,
  RuntimeKind,
  SessionStats,
} from '../../src/shared/domain.js';
import { DEFAULT_CAPABILITIES, DEFAULT_SETTINGS } from '../../src/shared/domain.js';
import type {
  BridgeEvent,
  IpcAction,
  RuntimeSnapshot,
  SessionTarget,
} from '../../src/shared/ipc.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export interface InvokeCall {
  action: string;
  payload: Record<string, unknown> | undefined;
  /** Transcript the renderer bound the call to, when it is session-scoped. */
  session?: SessionTarget | undefined;
}

export interface FakeBridge {
  calls: InvokeCall[];
  emit: (event: BridgeEvent) => void;
  snapshot: RuntimeSnapshot;
  /** Replaces the resolved value of one action for later calls. */
  setResult: (action: IpcAction, value: unknown) => void;
  /** Replaces one action with an async transport handler. */
  setHandler: (
    action: IpcAction,
    handler: (payload: Record<string, unknown> | undefined) => unknown,
  ) => void;
  payloads: (action: IpcAction) => (Record<string, unknown> | undefined)[];
}

export interface FakeBridgeOptions {
  runtime?: RuntimeKind;
  status?: RuntimeSnapshot['status'];
  detail?: string | null;
  capabilities?: Partial<RuntimeCapabilities>;
  cwd?: string | null;
  displayCwd?: string | null;
  settings?: Partial<AppSettings>;
  stats?: SessionStats | null;
  agent?: AgentState | null;
  /** Per-action result overrides, e.g. `{ 'models.list': [...] }`. */
  results?: Partial<Record<IpcAction, unknown>>;
}

/** Installs a fake `window.tau` before renderer modules read the bridge. */
export function installFakeBridge(options: FakeBridgeOptions = {}): FakeBridge {
  const listeners = new Set<(event: BridgeEvent) => void>();
  const calls: InvokeCall[] = [];
  const cwd = options.cwd === undefined ? '/work/project' : options.cwd;
  const snapshot: RuntimeSnapshot = {
    runtime: options.runtime ?? 'tau',
    status: options.status ?? 'idle',
    detail: options.detail ?? null,
    capabilities: { ...DEFAULT_CAPABILITIES, ...options.capabilities },
    cwd,
    displayCwd: options.displayCwd === undefined ? cwd : options.displayCwd,
    gitBranch: 'main',
    state: options.agent ?? null,
    runtimeVersion: '9.9.9-fake',
  };
  const settings: AppSettings = { ...DEFAULT_SETTINGS, ...options.settings };

  const results: Partial<Record<IpcAction, unknown>> = {
    'settings.get': settings,
    'settings.update': settings,
    'settings.rememberWorkingDirectory': settings,
    'runtime.snapshot': snapshot,
    'runtime.start': snapshot,
    'runtime.openSession': snapshot,
    'runtime.stop': snapshot,
    'runtime.restart': snapshot,
    'agent.messages': [],
    'agent.stats': options.stats ?? null,
    'models.list': [],
    'thinking.list': [],
    'commands.list': [],
    'resources.list': { skills: [], prompts: [], diagnostics: [] },
    'resources.reload': {
      before: { skills: 0, prompts: 0, themes: 2, contextFiles: 0, extensions: 0, tools: 4 },
      after: { skills: 0, prompts: 0, themes: 2, contextFiles: 0, extensions: 0, tools: 4 },
      diagnostics: [],
    },
    'agent.inspectSystemPrompt': {
      text: 'You are a coding agent.',
      totalCharacters: 23,
      truncated: false,
      origin: 'active Pi session',
    },
    'tools.list': { tools: [], total: 0, truncated: false, diagnostics: [] },
    'context.list': [],
    'agent.prompt': null,
    'agent.steer': null,
    'agent.followUp': null,
    'agent.abort': null,
    'shell.run': { command: '', output: 'ok', exitCode: 0, cancelled: false, truncated: false },
    'agent.state': options.agent ?? null,
    'agent.tree': { tree: [], leafId: null },
    'fs.complete': [],
    'fs.relativize': [],
    'diagnostics.list': [],
    'session.fork': '',
    ...options.results,
  };

  const handlers = new Map<IpcAction, (payload: Record<string, unknown> | undefined) => unknown>();
  const bridge = {
    invoke: (
      action: string,
      payload?: Record<string, unknown>,
      session?: SessionTarget,
    ): Promise<unknown> => {
      calls.push({ action, payload, session });
      const handler = handlers.get(action as IpcAction);
      if (handler) return Promise.resolve(handler(payload));
      const value = results[action as IpcAction];
      return Promise.resolve(value === undefined ? null : value);
    },
    subscribe: (listener: (event: BridgeEvent) => void): (() => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Electron exposes dropped-file paths through the preload bridge only.
    pathForFile: (file: File): string => (file as File & { path?: string }).path ?? '',
    platform: 'darwin',
  };

  // The bridge type is intentionally narrow; the fake satisfies it structurally.
  (window as unknown as { tau: unknown }).tau = bridge;

  return {
    calls,
    snapshot,
    setResult: (action, value) => {
      results[action] = value;
    },
    setHandler: (action, handler) => {
      handlers.set(action, handler);
    },
    payloads: (action) =>
      calls.filter((call) => call.action === action).map((call) => call.payload),
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

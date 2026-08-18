import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { ModelRef, RuntimeKind, ThinkingLevel, TreeSnapshot } from '../../../shared/domain.js';
import type { FileCompletion } from '../../../shared/ipc.js';
import { attempt, invoke, subscribe } from '../bridge.js';
import { INITIAL_STATE, isRunning, nextBlockId, reducer, windowTitle } from './reducer.js';
import type { Action, AppState, ModalKind } from './types.js';

export interface Store {
  state: AppState;
  dispatch: (action: Action) => void;
  actions: Actions;
}

export interface Actions {
  start: (cwd?: string | null, sessionRef?: string | null) => Promise<void>;
  stop: () => Promise<void>;
  submit: (text: string) => Promise<void>;
  steer: (text: string) => Promise<void>;
  followUp: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  runShell: (command: string, excludeFromContext: boolean) => Promise<void>;
  setModel: (ref: ModelRef) => Promise<void>;
  cycleModel: () => Promise<void>;
  setThinking: (level: ThinkingLevel) => Promise<void>;
  cycleThinking: () => Promise<void>;
  newSession: () => Promise<void>;
  switchSession: (ref: string) => Promise<void>;
  nameSession: (name: string) => Promise<void>;
  fork: (entryId: string) => Promise<string | null>;
  compact: (instructions?: string) => Promise<void>;
  exportHtml: () => Promise<void>;
  openDirectory: () => Promise<void>;
  updateSettings: (patch: Record<string, unknown>) => Promise<void>;
  /** Persists the runtime choice, then restarts it without losing the draft. */
  switchRuntime: (kind: RuntimeKind) => Promise<void>;
  restart: () => Promise<void>;
  quit: () => Promise<void>;
  forgetSession: (id: string) => Promise<void>;
  setAutoCompaction: (enabled: boolean) => Promise<void>;
  loadTree: () => Promise<TreeSnapshot | null>;
  loadDiagnostics: () => Promise<void>;
  completePaths: (query: string) => Promise<FileCompletion[]>;
  relativize: (paths: string[]) => Promise<string[]>;
  setDraft: (text: string) => void;
  openModal: (modal: ModalKind | null) => void;
  toggleExpandAll: () => void;
  notice: (message: string) => void;
  refresh: () => Promise<void>;
}

const StoreContext = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;

  const notice = useCallback((message: string) => {
    dispatch({ type: 'diagnostic', message });
    dispatch({
      type: 'localMessage',
      block: { kind: 'error', id: nextBlockId('error'), text: message, timestamp: Date.now() },
    });
  }, []);

  /** Reloads everything that describes the current session from the runtime. */
  const refresh = useCallback(async () => {
    const snapshot = await attempt('runtime.snapshot', undefined, notice);
    if (snapshot) dispatch({ type: 'snapshot', snapshot });
    if (!snapshot || snapshot.status === 'stopped' || snapshot.status === 'failed') return;

    const [messages, stats, models, levels, commands] = await Promise.all([
      attempt('agent.messages', undefined, notice),
      attempt('agent.stats', undefined, notice),
      attempt('models.list', undefined, notice),
      attempt('thinking.list', undefined, notice),
      attempt('commands.list', undefined, notice),
    ]);
    if (messages) dispatch({ type: 'hydrate', messages, now: Date.now() });
    if (stats) dispatch({ type: 'stats', stats });
    if (models) dispatch({ type: 'models', models });
    if (levels) dispatch({ type: 'thinkingLevels', levels });
    if (commands) dispatch({ type: 'commands', commands });
  }, [notice]);

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      switch (event.type) {
        case 'agent':
          dispatch({ type: 'event', event: event.event, now: Date.now() });
          if (event.event.type === 'agent_settled') {
            void attempt('agent.stats', undefined, notice).then((stats) => {
              if (stats) dispatch({ type: 'stats', stats });
            });
          }
          break;
        case 'status':
          dispatch({ type: 'snapshot', snapshot: event.snapshot });
          break;
        case 'settings':
          dispatch({ type: 'settings', settings: event.settings });
          break;
        case 'diagnostic':
          dispatch({ type: 'diagnostic', message: event.message });
          break;
        case 'focus':
          dispatch({ type: 'focus', focused: event.focused });
          break;
      }
    });
    return unsubscribe;
  }, [notice]);

  // Bootstrap: load settings, then connect to the configured runtime.
  useEffect(() => {
    void (async () => {
      const settings = await attempt('settings.get', undefined, notice);
      if (settings) dispatch({ type: 'settings', settings });
      const snapshot = await attempt('runtime.snapshot', undefined, notice);
      if (snapshot) dispatch({ type: 'snapshot', snapshot });
      if (snapshot?.status === 'stopped') {
        const started = await attempt('runtime.start', { cwd: settings?.cwd ?? null }, notice);
        if (started) {
          dispatch({ type: 'snapshot', snapshot: started });
          await refresh();
        }
      } else {
        await refresh();
      }
    })();
  }, [notice, refresh]);

  // Theme, window title, and completion notifications are derived from state.
  useEffect(() => {
    document.documentElement.dataset['theme'] = state.settings.theme;
  }, [state.settings.theme]);

  useEffect(() => {
    void invoke('ui.setTitle', { title: windowTitle(state, state.settings) }).catch(
      () => undefined,
    );
  }, [state]);

  const previousPreview = useRef<string | null>(null);
  useEffect(() => {
    const preview = state.lastCompletionPreview;
    if (!preview || preview === previousPreview.current) return;
    previousPreview.current = preview;
    if (state.windowFocused || state.settings.turnNotification !== 'desktop') return;
    const name = state.agent?.sessionName ?? 'Tau session';
    void invoke('ui.notify', { title: `τ | ${name}`, body: preview.slice(0, 200) }).catch(
      () => undefined,
    );
  }, [
    state.lastCompletionPreview,
    state.windowFocused,
    state.settings.turnNotification,
    state.agent,
  ]);

  const actions = useMemo<Actions>(() => {
    const run = async <T,>(work: () => Promise<T>): Promise<T | null> => {
      dispatch({ type: 'busy', busy: true });
      try {
        return await work();
      } catch (error) {
        notice((error as Error).message);
        return null;
      } finally {
        dispatch({ type: 'busy', busy: false });
      }
    };

    return {
      start: async (cwd, sessionRef) => {
        await run(async () => {
          const snapshot = await invoke('runtime.start', {
            cwd: cwd ?? null,
            sessionRef: sessionRef ?? null,
          });
          dispatch({ type: 'snapshot', snapshot });
          dispatch({ type: 'clearTranscript' });
          await refresh();
        });
      },
      stop: async () => {
        await run(async () => {
          const snapshot = await invoke('runtime.stop');
          dispatch({ type: 'snapshot', snapshot });
        });
      },
      submit: async (text) => {
        await attempt('agent.prompt', { text }, notice);
      },
      steer: async (text) => {
        await attempt('agent.steer', { text }, notice);
      },
      followUp: async (text) => {
        await attempt('agent.followUp', { text }, notice);
      },
      abort: async () => {
        await attempt('agent.abort', undefined, notice);
      },
      runShell: async (command, excludeFromContext) => {
        const id = nextBlockId('shell');
        dispatch({
          type: 'localMessage',
          block: {
            kind: 'shell',
            id,
            command,
            output: '',
            exitCode: null,
            excludeFromContext,
            running: true,
            timestamp: Date.now(),
          },
        });
        const result = await attempt('shell.run', { command, excludeFromContext }, notice);
        dispatch({
          type: 'updateBlock',
          id,
          patch: result
            ? { output: result.output, exitCode: result.exitCode, running: false }
            : { output: '(command failed)', exitCode: null, running: false },
        });
      },
      setModel: async (ref) => {
        await run(async () => {
          await invoke('models.set', { provider: ref.provider, modelId: ref.modelId });
          await attempt('agent.state', undefined, notice);
          const snapshot = await invoke('runtime.snapshot');
          dispatch({ type: 'snapshot', snapshot });
        });
      },
      cycleModel: async () => {
        const result = await attempt('models.cycle', undefined, notice);
        if (result) {
          const snapshot = await invoke('runtime.snapshot');
          dispatch({ type: 'snapshot', snapshot });
        }
      },
      setThinking: async (level) => {
        await attempt('thinking.set', { level }, notice);
        const snapshot = await invoke('runtime.snapshot');
        dispatch({ type: 'snapshot', snapshot });
      },
      cycleThinking: async () => {
        await attempt('thinking.cycle', undefined, notice);
        const snapshot = await invoke('runtime.snapshot');
        dispatch({ type: 'snapshot', snapshot });
      },
      newSession: async () => {
        await run(async () => {
          await invoke('session.new');
          dispatch({ type: 'clearTranscript' });
          await refresh();
        });
      },
      switchSession: async (ref) => {
        await run(async () => {
          await invoke('session.switch', { ref });
          dispatch({ type: 'clearTranscript' });
          await refresh();
        });
      },
      nameSession: async (name) => {
        await attempt('session.name', { name }, notice);
      },
      fork: async (entryId) => {
        const text = await attempt('session.fork', { entryId }, notice);
        if (text !== null) {
          dispatch({ type: 'clearTranscript' });
          await refresh();
        }
        return text;
      },
      compact: async (instructions) => {
        await run(async () => {
          const result = await invoke(
            'session.compact',
            instructions ? { instructions } : undefined,
          );
          // Rebuild first: the outcome block must outlive the hydration.
          await refresh();
          dispatch({
            type: 'localMessage',
            block: {
              kind: 'compaction',
              id: nextBlockId('compaction'),
              summary: result.summary,
              detail: `${result.tokensBefore} → ~${result.estimatedTokensAfter} tokens`,
              timestamp: Date.now(),
            },
          });
        });
      },
      exportHtml: async () => {
        const path = await attempt('session.exportHtml', undefined, notice);
        if (path) {
          dispatch({
            type: 'localMessage',
            block: {
              kind: 'status',
              id: nextBlockId('status'),
              text: `Exported session to ${path}`,
              tone: 'info',
              timestamp: Date.now(),
            },
          });
        }
      },
      openDirectory: async () => {
        const cwd = await attempt('fs.pickDirectory', undefined, notice);
        if (!cwd) return;
        const settings = await attempt('settings.update', { cwd }, notice);
        if (settings) dispatch({ type: 'settings', settings });
        await run(async () => {
          const snapshot = await invoke('runtime.start', { cwd });
          dispatch({ type: 'snapshot', snapshot });
          dispatch({ type: 'clearTranscript' });
          await refresh();
        });
      },
      updateSettings: async (patch) => {
        const settings = await attempt('settings.update', patch, notice);
        if (settings) dispatch({ type: 'settings', settings });
      },
      switchRuntime: async (kind) => {
        if (kind === stateRef.current.settings.agentRuntime) return;
        const settings = await attempt('settings.update', { agentRuntime: kind }, notice);
        if (!settings) return;
        dispatch({ type: 'settings', settings });
        // The draft and every GUI setting outlive the restart on purpose.
        await run(async () => {
          const snapshot = await invoke('runtime.start', { cwd: settings.cwd ?? null });
          dispatch({ type: 'snapshot', snapshot });
          dispatch({ type: 'clearTranscript' });
          await refresh();
        });
      },
      restart: async () => {
        await run(async () => {
          const snapshot = await invoke('runtime.start', {
            cwd: stateRef.current.settings.cwd ?? null,
          });
          dispatch({ type: 'snapshot', snapshot });
          dispatch({ type: 'clearTranscript' });
          await refresh();
        });
      },
      quit: async () => {
        await attempt('runtime.stop', undefined, notice);
        window.close();
      },
      forgetSession: async (id) => {
        const settings = await attempt('settings.forgetSession', { id }, notice);
        if (settings) dispatch({ type: 'settings', settings });
      },
      setAutoCompaction: async (enabled) => {
        await attempt('session.autoCompaction', { enabled }, notice);
        const snapshot = await attempt('runtime.snapshot', undefined, notice);
        if (snapshot) dispatch({ type: 'snapshot', snapshot });
      },
      loadTree: async () => attempt('agent.tree', undefined, notice),
      loadDiagnostics: async () => {
        const messages = await attempt('diagnostics.list', undefined, notice);
        if (messages) dispatch({ type: 'diagnostics', messages });
      },
      completePaths: async (query) => (await attempt('fs.complete', { query }, notice)) ?? [],
      relativize: async (paths) => (await attempt('fs.relativize', { paths }, notice)) ?? paths,
      setDraft: (text) => dispatch({ type: 'draft', text }),
      openModal: (modal) => dispatch({ type: 'modal', modal }),
      toggleExpandAll: () => dispatch({ type: 'toggleExpandAll' }),
      notice,
      refresh,
    };
  }, [notice, refresh]);

  const value = useMemo<Store>(() => ({ state, dispatch, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}

export function useRunning(): boolean {
  return isRunning(useStore().state);
}

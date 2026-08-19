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
import type {
  ModelRef,
  RuntimeKind,
  SessionRef,
  ThinkingLevel,
  TreeSnapshot,
} from '../../../shared/domain.js';
import type {
  FileCompletion,
  PromptQueueItem,
  RuntimeProbe,
  SessionTarget,
} from '../../../shared/ipc.js';
import { nextScopedModel } from '../../../shared/scoped-models.js';
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
  popQueued: () => Promise<PromptQueueItem | null>;
  abort: () => Promise<void>;
  runShell: (command: string, excludeFromContext: boolean) => Promise<void>;
  setModel: (ref: ModelRef) => Promise<void>;
  /** Cycles scoped models when at least two are scoped, else the runtime's own cycle. */
  cycleModel: () => Promise<void>;
  /** Adds or removes a model from the app-owned scoped list for the active runtime. */
  toggleScopedModel: (ref: ModelRef) => Promise<void>;
  setThinking: (level: ThinkingLevel) => Promise<void>;
  cycleThinking: () => Promise<void>;
  newSession: () => Promise<void>;
  switchSession: (ref: string) => Promise<void>;
  /** Resumes a recent session, switching runtime or restarting if needed. */
  resumeSession: (ref: SessionRef) => Promise<void>;
  nameSession: (name: string) => Promise<void>;
  fork: (entryId: string) => Promise<string | null>;
  compact: (instructions?: string) => Promise<void>;
  exportHtml: (destination?: string) => Promise<void>;
  openDirectory: () => Promise<void>;
  updateSettings: (patch: Record<string, unknown>) => Promise<void>;
  probeRuntime: (kind: RuntimeKind, binary: string) => Promise<RuntimeProbe | null>;
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

const OPENING_SESSION = 'Wait for the session to finish opening before sending a message.';

export function StoreProvider({ children }: { children: ReactNode }): ReactNode {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const stateRef = useRef(state);
  const scopedMutationRef = useRef(0);
  stateRef.current = state;
  // Invalidates in-flight transcript hydration whenever navigation starts.
  // RPC reads are asynchronous and may otherwise resolve after another
  // session has become active.
  const refreshEpoch = useRef(0);
  const navigationEpoch = useRef(0);
  const navigating = useRef(false);
  const invalidateRefresh = useCallback(() => {
    refreshEpoch.current += 1;
    navigationEpoch.current += 1;
  }, []);
  const beginNavigation = useCallback(
    (targetRuntime?: RuntimeKind) => {
      invalidateRefresh();
      navigating.current = true;
      dispatch({ type: 'sessionNavigation', active: true, targetRuntime });
      return navigationEpoch.current;
    },
    [invalidateRefresh],
  );
  const finishNavigation = useCallback((navigation: number) => {
    if (navigation !== navigationEpoch.current) return;
    navigating.current = false;
    dispatch({ type: 'sessionNavigation', active: false });
  }, []);

  const notice = useCallback((message: string) => {
    dispatch({ type: 'diagnostic', message });
    dispatch({
      type: 'localMessage',
      block: { kind: 'error', id: nextBlockId('error'), text: message, timestamp: Date.now() },
    });
  }, []);

  /** Transcript identity every session-scoped call is bound to. */
  const viewed = useCallback((): SessionTarget | undefined => {
    const snapshot = stateRef.current.snapshot;
    const sessionId = snapshot.state?.sessionId;
    return sessionId ? { runtime: snapshot.runtime, sessionId } : undefined;
  }, []);

  /** Reloads everything that describes the current session from the runtime. */
  const refresh = useCallback(
    async (expected?: { runtime: RuntimeKind; sessionId: string }) => {
      // A settle event can have been queued by the previously selected
      // session. Scoped reconciliation must not supersede hydration already
      // running for the newly selected session.
      const epoch = expected ? refreshEpoch.current : ++refreshEpoch.current;
      const snapshot = await attempt('runtime.snapshot', undefined, notice);
      if (epoch !== refreshEpoch.current) return;
      if (
        expected &&
        (snapshot?.runtime !== expected.runtime || snapshot.state?.sessionId !== expected.sessionId)
      ) {
        return;
      }
      if (snapshot) dispatch({ type: 'snapshot', snapshot });
      if (!snapshot || snapshot.status === 'stopped' || snapshot.status === 'failed') return;

      // Every read is bound to the transcript the snapshot just described, so a
      // session switch that starts mid-flight cannot answer with another
      // session's messages.
      const target: SessionTarget | undefined = snapshot.state?.sessionId
        ? { runtime: snapshot.runtime, sessionId: snapshot.state.sessionId }
        : undefined;
      const [messages, stats, models, levels, commands, resources, queue] = await Promise.all([
        attempt('agent.messages', undefined, notice, target),
        attempt('agent.stats', undefined, notice, target),
        attempt('models.list', undefined, notice, target),
        attempt('thinking.list', undefined, notice, target),
        attempt('commands.list', undefined, notice, target),
        attempt('resources.list', undefined, notice),
        attempt('queue.snapshot', undefined, notice, target),
      ]);
      if (epoch !== refreshEpoch.current) return;
      if (messages) dispatch({ type: 'hydrate', messages, now: Date.now(), ...target });
      if (stats) dispatch({ type: 'stats', stats });
      if (models) dispatch({ type: 'models', models });
      if (levels) dispatch({ type: 'thinkingLevels', levels });
      if (commands) dispatch({ type: 'commands', commands });
      if (resources) dispatch({ type: 'resources', resources });
      if (queue) dispatch({ type: 'queue', snapshot: queue });
    },
    [notice],
  );

  useEffect(() => {
    const unsubscribe = subscribe((event) => {
      switch (event.type) {
        case 'agent':
          // Selection changes immediately from the user's perspective, before
          // the main process has finished activating and hydrating the target.
          // Drop stream events during that gap; authoritative hydration below
          // reconstructs any target-session events emitted while switching.
          if (navigating.current) break;
          dispatch({
            type: 'event',
            event: event.event,
            sessionId: event.sessionId,
            runtime: event.runtime,
            now: Date.now(),
          });
          if (event.event.type === 'agent_settled') {
            // Reconcile from authoritative messages after the stream. A tool
            // end can cross an in-flight hydration response on Electron's
            // separate event/response channels; final hydration guarantees no
            // tool remains falsely running.
            void refresh({ runtime: event.runtime, sessionId: event.sessionId });
          }
          break;
        case 'queue':
          dispatch({ type: 'queue', snapshot: event.snapshot });
          break;
        case 'status':
          // Status is transcript-scoped too. Keeping the previous manager's
          // `running` snapshot here would carry its working label into the
          // session the user has just selected.
          if (navigating.current) break;
          dispatch({ type: 'snapshot', snapshot: event.snapshot });
          break;
        case 'settings':
          dispatch({ type: 'settings', settings: event.settings });
          break;
        case 'sessionActivity':
          dispatch({ type: 'sessionActivity', activity: event.activity });
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
  }, [refresh]);

  // Bootstrap exactly once. React development StrictMode replays effects;
  // without this guard both passes can race two runtime.start requests and
  // stop the process that owns an in-flight session.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;
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

  // Derived so the title IPC fires on real changes, not on every dispatch.
  const title = windowTitle(state, state.settings);
  useEffect(() => {
    void invoke('ui.setTitle', { title }).catch(() => undefined);
  }, [title]);

  // Keyed on the settle counter, so a repeated identical answer notifies again.
  const notifiedSettle = useRef(0);
  useEffect(() => {
    const settled = state.settledCount;
    if (settled === 0 || settled === notifiedSettle.current) return;
    notifiedSettle.current = settled;
    const preview = state.lastCompletionPreview;
    if (!preview) return;
    if (state.windowFocused || state.settings.turnNotification !== 'desktop') return;
    const name = state.agent?.sessionName ?? 'Tau session';
    void invoke('ui.notify', { title: `τ | ${name}`, body: preview.slice(0, 200) }).catch(
      () => undefined,
    );
  }, [
    state.settledCount,
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

    /**
     * Runs one navigation command and always reconciles afterwards, so the
     * cleared view is rebuilt from the session the runtime really holds. A
     * failure is reported after hydration, which replaces local blocks.
     */
    const navigate = async (navigation: number, work: () => Promise<unknown>): Promise<void> => {
      let failure: string | null = null;
      dispatch({ type: 'busy', busy: true });
      try {
        await work();
      } catch (error) {
        failure = (error as Error).message;
      } finally {
        dispatch({ type: 'busy', busy: false });
      }
      if (navigation !== navigationEpoch.current) return;
      await refresh();
      if (failure) notice(failure);
    };

    return {
      start: async (cwd, sessionRef) => {
        invalidateRefresh();
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
        invalidateRefresh();
        await run(async () => {
          const snapshot = await invoke('runtime.stop');
          dispatch({ type: 'snapshot', snapshot });
        });
      },
      // Submissions are refused while a session is opening: the transcript they
      // belong to is not yet known, and an unbound prompt would be delivered to
      // whichever runtime happens to be selected when it arrives.
      submit: async (text) => {
        if (stateRef.current.sessionTransitioning) return notice(OPENING_SESSION);
        await attempt('agent.prompt', { text }, notice, viewed());
      },
      steer: async (text) => {
        if (stateRef.current.sessionTransitioning) return notice(OPENING_SESSION);
        await attempt('agent.steer', { text }, notice, viewed());
      },
      followUp: async (text) => {
        if (stateRef.current.sessionTransitioning) return notice(OPENING_SESSION);
        await attempt('agent.followUp', { text }, notice, viewed());
      },
      popQueued: async () => {
        if (stateRef.current.sessionTransitioning) return null;
        return attempt('queue.pop', undefined, notice, viewed());
      },
      abort: async () => {
        await attempt('agent.abort', undefined, notice, viewed());
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
        const result = await attempt(
          'shell.run',
          { command, excludeFromContext },
          notice,
          viewed(),
        );
        dispatch({
          type: 'updateBlock',
          id,
          patch: result
            ? { output: result.output, exitCode: result.exitCode, running: false }
            : { output: '(command failed)', exitCode: null, running: false },
        });
      },
      setModel: async (ref) => {
        const target = viewed();
        await run(async () => {
          await invoke('models.set', { provider: ref.provider, modelId: ref.modelId }, target);
          await attempt('agent.state', undefined, notice, target);
          const snapshot = await invoke('runtime.snapshot');
          dispatch({ type: 'snapshot', snapshot });
        });
      },
      cycleModel: async () => {
        const current = stateRef.current;
        const runtime = current.settings.agentRuntime;
        const scoped = current.settings.scopedModels[runtime] ?? [];
        const nextModel = nextScopedModel(
          current.models,
          scoped,
          current.agent?.model
            ? { provider: current.agent.model.provider, modelId: current.agent.model.id }
            : null,
        );
        const target = viewed();
        if (nextModel) {
          // Scoped cycling stays inside the app: it only ever calls set_model.
          await attempt(
            'models.set',
            { provider: nextModel.provider, modelId: nextModel.modelId },
            notice,
            target,
          );
          const snapshot = await attempt('runtime.snapshot', undefined, notice);
          if (snapshot) dispatch({ type: 'snapshot', snapshot });
          return;
        }
        const result = await attempt('models.cycle', undefined, notice, target);
        if (result) {
          const snapshot = await invoke('runtime.snapshot');
          dispatch({ type: 'snapshot', snapshot });
        }
      },
      toggleScopedModel: async (ref) => {
        const runtime = stateRef.current.settings.agentRuntime;
        const mutation = ++scopedMutationRef.current;
        const updated = await attempt(
          'settings.toggleScopedModel',
          { runtime, provider: ref.provider, modelId: ref.modelId },
          notice,
        );
        // Ignore an older transport response that arrived after a newer toggle.
        if (updated && mutation === scopedMutationRef.current) {
          dispatch({ type: 'settings', settings: updated });
        }
      },
      setThinking: async (level) => {
        await attempt('thinking.set', { level }, notice, viewed());
        const snapshot = await invoke('runtime.snapshot');
        dispatch({ type: 'snapshot', snapshot });
      },
      cycleThinking: async () => {
        await attempt('thinking.cycle', undefined, notice, viewed());
        const snapshot = await invoke('runtime.snapshot');
        dispatch({ type: 'snapshot', snapshot });
      },
      newSession: async () => {
        const target = viewed();
        const navigation = beginNavigation(stateRef.current.snapshot.runtime);
        try {
          await navigate(navigation, () => invoke('session.new', undefined, target));
        } finally {
          finishNavigation(navigation);
        }
      },
      switchSession: async (ref) => {
        const navigation = beginNavigation(stateRef.current.snapshot.runtime);
        try {
          await navigate(navigation, () => invoke('session.switch', { ref }));
        } finally {
          finishNavigation(navigation);
        }
      },
      resumeSession: async (ref) => {
        const previousStatus = stateRef.current.snapshot.status;
        const navigation = beginNavigation(ref.runtime);
        try {
          // Tau resumes by indexed session id; Pi resumes by session path.
          const target = ref.runtime === 'pi' ? (ref.path ?? ref.id) : ref.id;
          if (ref.runtime !== stateRef.current.settings.agentRuntime) {
            const settings = await attempt(
              'settings.update',
              { agentRuntime: ref.runtime },
              notice,
            );
            if (!settings) return;
            dispatch({ type: 'settings', settings });
          }
          const started =
            previousStatus === 'idle' ||
            previousStatus === 'running' ||
            previousStatus === 'compacting' ||
            previousStatus === 'retrying';
          if (started) {
            await navigate(navigation, () => invoke('session.switch', { ref: target }));
            return;
          }
          await navigate(navigation, () =>
            invoke('runtime.start', {
              cwd: ref.cwd ?? stateRef.current.settings.cwd ?? null,
              sessionRef: target,
            }),
          );
        } finally {
          finishNavigation(navigation);
        }
      },
      nameSession: async (name) => {
        await attempt('session.name', { name }, notice, viewed());
      },
      fork: async (entryId) => {
        const target = viewed();
        invalidateRefresh();
        const text = await attempt('session.fork', { entryId }, notice, target);
        if (text !== null) {
          dispatch({ type: 'clearTranscript' });
          await refresh();
        }
        return text;
      },
      compact: async (instructions) => {
        const target = viewed();
        await run(async () => {
          const result = await invoke(
            'session.compact',
            instructions ? { instructions } : undefined,
            target,
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
      exportHtml: async (destination) => {
        const path = await attempt(
          'session.exportHtml',
          destination ? { destination } : undefined,
          notice,
          viewed(),
        );
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
        invalidateRefresh();
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
      probeRuntime: async (kind, binary) => attempt('runtime.probe', { kind, binary }, notice),
      updateSettings: async (patch) => {
        const settings = await attempt('settings.update', patch, notice);
        if (settings) dispatch({ type: 'settings', settings });
      },
      switchRuntime: async (kind) => {
        if (kind === stateRef.current.settings.agentRuntime) return;
        invalidateRefresh();
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
        invalidateRefresh();
        await run(async () => {
          const snapshot = await invoke('runtime.restart');
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
        await attempt('session.autoCompaction', { enabled }, notice, viewed());
        const snapshot = await attempt('runtime.snapshot', undefined, notice);
        if (snapshot) dispatch({ type: 'snapshot', snapshot });
      },
      loadTree: async () => attempt('agent.tree', undefined, notice, viewed()),
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
  }, [beginNavigation, finishNavigation, invalidateRefresh, notice, refresh, viewed]);

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

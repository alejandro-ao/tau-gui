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
  AppSettings,
  ModelRef,
  PiAgentPreferencesPatch,
  ProviderAuthMethod,
  SessionSummary,
  ThinkingLevel,
  TreeNavigateOptions,
  TreeSnapshot,
} from '../../../shared/domain.js';
import type { ExtensionPolicy } from '../../../shared/extensions.js';
import type { FileCompletion, PromptQueueItem, SessionTarget } from '../../../shared/ipc.js';
import { nextScopedModel } from '../../../shared/scoped-models.js';
import { attempt, invoke, subscribe } from '../bridge.js';
import {
  INITIAL_STATE,
  isRunning,
  nextBlockId,
  reducer,
  snapshotTarget,
  windowTitle,
} from './reducer.js';
import type { Action, AppState, ModalKind } from './types.js';

export interface Store {
  state: AppState;
  dispatch: (action: Action) => void;
  actions: Actions;
}

export interface QueueRecall extends PromptQueueItem {
  resolve: (outcome: 'accept' | 'restore') => Promise<void>;
}

export interface Actions {
  start: (cwd?: string | null) => Promise<void>;
  stop: () => Promise<void>;
  submit: (text: string) => Promise<void>;
  steer: (text: string) => Promise<void>;
  followUp: (text: string) => Promise<void>;
  addImagePaths: (paths: string[]) => Promise<void>;
  removeImage: (id: string) => Promise<void>;
  popQueued: () => Promise<QueueRecall | null>;
  abort: () => Promise<void>;
  runShell: (command: string, excludeFromContext: boolean) => Promise<void>;
  setModel: (ref: ModelRef) => Promise<void>;
  /** Cycles scoped models when at least two are scoped, else the runtime's own cycle. */
  cycleModel: () => Promise<void>;
  /** Adds or removes a model from the app-owned scoped list for the active runtime. */
  toggleScopedModel: (ref: ModelRef) => Promise<void>;
  setThinking: (level: ThinkingLevel) => Promise<void>;
  cycleThinking: () => Promise<void>;
  /** Creates a session in the active session's directory without prompting. */
  newSession: () => Promise<void>;
  /** Chooses, persists, and opens a directory with a fresh session. */
  newSessionFromDirectoryPicker: () => Promise<void>;
  switchSession: (ref: string) => Promise<void>;
  /** Resumes a recent session, switching runtime or restarting if needed. */
  resumeSession: (ref: SessionSummary) => Promise<void>;
  nameSession: (name: string) => Promise<void>;
  fork: (entryId: string, options: TreeNavigateOptions) => Promise<string | null>;
  setLabel: (entryId: string, label: string | null) => Promise<void>;
  cloneSession: () => Promise<void>;
  importJsonl: () => Promise<void>;
  importRecoveryHealth: () => Promise<{ retained: number; capacity: number } | null>;
  revealImportRecovery: () => Promise<void>;
  compact: (instructions?: string) => Promise<void>;
  exportHtml: () => Promise<void>;
  exportJsonl: (sessionId?: string) => Promise<void>;
  openDirectory: () => Promise<void>;
  addResourceDirectory: (kind: 'skills' | 'prompts') => Promise<void>;
  removeResourceDirectory: (kind: 'skills' | 'prompts', path: string) => Promise<void>;
  updateSettings: (patch: Record<string, unknown>) => Promise<void>;
  restart: () => Promise<void>;
  quit: () => Promise<void>;
  forgetSession: (id: string) => Promise<void>;
  setAutoCompaction: (enabled: boolean) => Promise<void>;
  loadProviderAuth: () => Promise<void>;
  loginProvider: (providerId: string, method: ProviderAuthMethod) => Promise<void>;
  respondProviderAuth: (flowId: string, challengeId: string, value: string) => Promise<void>;
  cancelProviderAuth: (flowId: string) => Promise<void>;
  logoutProvider: (providerId: string) => Promise<void>;
  loadPiPreferences: () => Promise<void>;
  updatePiPreferences: (patch: PiAgentPreferencesPatch) => Promise<void>;
  abortRetry: () => Promise<void>;
  loadTree: () => Promise<TreeSnapshot | null>;
  loadDiagnostics: () => Promise<void>;
  inspectSystemPrompt: () => Promise<void>;
  inspectTools: () => Promise<void>;
  reloadResources: () => Promise<void>;
  loadExtensions: () => Promise<void>;
  updateExtensionPolicy: (
    patch: Partial<Pick<ExtensionPolicy, 'userEnabled' | 'projectEnabled'>>,
  ) => Promise<void>;
  probeExtensionHost: () => Promise<void>;
  respondExtensionDialog: (requestId: string, value: string | boolean | null) => Promise<void>;
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
    (targetRuntime?: 'pi') => {
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
  const viewed = useCallback(
    (): SessionTarget | undefined => snapshotTarget(stateRef.current.snapshot),
    [],
  );
  const beginScopedOperation = useCallback(() => {
    const target = viewed();
    return target ? { target, navigation: navigationEpoch.current } : null;
  }, [viewed]);
  const scopedOperationIsCurrent = useCallback(
    (operation: { target: SessionTarget; navigation: number }): boolean => {
      const current = viewed();
      return (
        operation.navigation === navigationEpoch.current &&
        current?.runtime === operation.target.runtime &&
        current.sessionId === operation.target.sessionId
      );
    },
    [viewed],
  );

  /** Reloads everything that describes the current session from the runtime. */
  const refresh = useCallback(
    async (expected?: { runtime: 'pi'; sessionId: string }) => {
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
      if (!snapshot) return;

      // Every read is bound to the transcript the snapshot just described, so a
      // session switch that starts mid-flight cannot answer with another
      // session's messages. Failed restart snapshots retain this address even
      // though no process can provide agent state.
      const target = snapshotTarget(snapshot);
      const catalog = await attempt('session.list', { scope: 'all' }, notice, target ?? undefined);
      if (epoch === refreshEpoch.current && catalog)
        dispatch({ type: 'sessions', sessions: catalog });
      if (snapshot.status === 'stopped' || snapshot.status === 'failed') {
        if (target) {
          const queue = await attempt('queue.snapshot', undefined, notice, target);
          if (epoch === refreshEpoch.current && queue) dispatch({ type: 'queue', snapshot: queue });
        }
        return;
      }
      const [messages, stats, sessions, models, levels, commands, resources, contextFiles, queue] =
        await Promise.all([
          attempt('agent.messages', undefined, notice, target),
          attempt('agent.stats', undefined, notice, target),
          Promise.resolve(null),
          attempt('models.list', undefined, notice, target),
          attempt('thinking.list', undefined, notice, target),
          attempt('commands.list', undefined, notice, target),
          attempt('resources.list', undefined, notice),
          attempt('context.list', undefined, notice),
          attempt('queue.snapshot', undefined, notice, target),
        ]);
      if (epoch !== refreshEpoch.current) return;
      if (messages) dispatch({ type: 'hydrate', messages, now: Date.now(), ...target });
      if (stats) dispatch({ type: 'stats', stats });
      if (sessions) dispatch({ type: 'sessions', sessions });
      if (models) dispatch({ type: 'models', models });
      if (levels) dispatch({ type: 'thinkingLevels', levels });
      if (commands) dispatch({ type: 'commands', commands });
      if (resources) dispatch({ type: 'resources', resources });
      if (contextFiles) dispatch({ type: 'contextFiles', files: contextFiles });
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
        case 'auth':
          dispatch({ type: 'authFlow', event: event.event });
          dispatch({ type: 'modal', modal: 'auth' });
          if (event.event.type === 'complete') {
            void attempt('auth.providers', undefined, notice).then((providers) => {
              if (providers) dispatch({ type: 'providerAuth', providers });
            });
          }
          break;
        case 'extensionUi':
          dispatch({ type: 'extensionUi', event: event.event });
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
  }, [notice, refresh]);

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

    const chooseDirectoryAndStart = async (): Promise<void> => {
      const cwd = await attempt('fs.pickDirectory', undefined, notice);
      if (!cwd) return;
      const settings = await attempt('settings.rememberWorkingDirectory', { cwd }, notice);
      if (!settings) return;
      dispatch({ type: 'settings', settings });
      const navigation = beginNavigation(stateRef.current.snapshot.runtime);
      try {
        await navigate(navigation, () => invoke('runtime.openSession', { cwd }));
      } finally {
        finishNavigation(navigation);
      }
    };

    const reloadResourceSettings = async (settings: AppSettings | null): Promise<void> => {
      if (!settings) return;
      dispatch({ type: 'settings', settings });
      invalidateRefresh();
      await run(async () => {
        const snapshot = await invoke('runtime.restart');
        dispatch({ type: 'snapshot', snapshot });
        dispatch({ type: 'clearTranscript' });
        await refresh();
      });
    };

    return {
      start: async (cwd) => {
        invalidateRefresh();
        await run(async () => {
          const snapshot = await invoke('runtime.start', { cwd: cwd ?? null });
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
        const attachmentIds = stateRef.current.imageAttachments.map((image) => image.id);
        try {
          await invoke(
            'agent.prompt',
            { text, ...(attachmentIds.length ? { attachmentIds } : {}) },
            viewed(),
          );
          if (attachmentIds.length) dispatch({ type: 'imageAttachments', attachments: [] });
        } catch (error) {
          notice((error as Error).message);
        }
      },
      steer: async (text) => {
        if (stateRef.current.sessionTransitioning) return notice(OPENING_SESSION);
        const attachmentIds = stateRef.current.imageAttachments.map((image) => image.id);
        try {
          await invoke(
            'agent.steer',
            { text, ...(attachmentIds.length ? { attachmentIds } : {}) },
            viewed(),
          );
          if (attachmentIds.length) dispatch({ type: 'imageAttachments', attachments: [] });
        } catch (error) {
          notice((error as Error).message);
        }
      },
      followUp: async (text) => {
        if (stateRef.current.sessionTransitioning) return notice(OPENING_SESSION);
        const attachmentIds = stateRef.current.imageAttachments.map((image) => image.id);
        try {
          await invoke(
            'agent.followUp',
            { text, ...(attachmentIds.length ? { attachmentIds } : {}) },
            viewed(),
          );
          if (attachmentIds.length) dispatch({ type: 'imageAttachments', attachments: [] });
        } catch (error) {
          notice((error as Error).message);
        }
      },
      addImagePaths: async (paths) => {
        const current = stateRef.current.imageAttachments;
        if (current.length + paths.length > 8) {
          notice('A prompt can contain at most 8 images.');
          return;
        }
        const prepared = await attempt('images.prepare', { paths }, notice, viewed());
        if (prepared) {
          dispatch({ type: 'imageAttachments', attachments: [...current, ...prepared] });
        }
      },
      removeImage: async (id) => {
        await attempt('images.remove', { id }, notice, viewed());
        dispatch({
          type: 'imageAttachments',
          attachments: stateRef.current.imageAttachments.filter((image) => image.id !== id),
        });
      },
      popQueued: async () => {
        if (stateRef.current.sessionTransitioning) return null;
        const target = viewed();
        if (!target) return null;
        const item = await attempt('queue.pop', undefined, notice, target);
        if (!item) return null;
        return {
          ...item,
          resolve: async (outcome) => {
            await attempt('queue.resolve', { id: item.id, outcome }, notice, target);
          },
        };
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
        const scoped = current.settings.scopedModels;
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
        const mutation = ++scopedMutationRef.current;
        const updated = await attempt(
          'settings.toggleScopedModel',
          { provider: ref.provider, modelId: ref.modelId },
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
      newSessionFromDirectoryPicker: chooseDirectoryAndStart,
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
        const navigation = beginNavigation('pi');
        try {
          // Both native and remembered records expose only a main-owned opaque id.
          const target = ref.id;
          const started =
            previousStatus === 'idle' ||
            previousStatus === 'running' ||
            previousStatus === 'compacting' ||
            previousStatus === 'retrying';
          if (started) {
            await navigate(navigation, () => invoke('session.switch', { ref: target }));
            return;
          }
          await navigate(navigation, () => invoke('session.switch', { ref: target }));
        } finally {
          finishNavigation(navigation);
        }
      },
      nameSession: async (name) => {
        await attempt('session.name', { name }, notice, viewed());
      },
      fork: async (entryId, options) => {
        const target = viewed();
        invalidateRefresh();
        const result = await attempt('session.fork', { entryId, ...options }, notice, target);
        if (result === null || result.cancelled || result.aborted) return null;
        dispatch({ type: 'clearTranscript' });
        await refresh();
        if (result.editorTextTruncated) {
          notice('Editable message was truncated to 100,000 characters after navigation.');
        }
        return result.editorText;
      },
      setLabel: async (entryId, label) => {
        await attempt('session.label', { entryId, label }, notice, viewed());
      },
      cloneSession: async () => {
        const target = viewed();
        const navigation = beginNavigation(stateRef.current.snapshot.runtime);
        try {
          await navigate(navigation, () => invoke('session.clone', undefined, target));
        } finally {
          finishNavigation(navigation);
        }
      },
      importJsonl: async () => {
        const target = viewed();
        const navigation = beginNavigation(stateRef.current.snapshot.runtime);
        try {
          await navigate(navigation, () => invoke('session.importJsonl', undefined, target));
        } finally {
          finishNavigation(navigation);
        }
      },
      compact: async (instructions) => {
        const target = viewed();
        await run(async () => {
          const result = await invoke(
            'session.compact',
            instructions ? { instructions } : undefined,
            target,
          );
          // Compaction only shrinks the runtime's context: the conversation the
          // user already read stays on screen, with the hydrated tail merged
          // back on top of it.
          dispatch({ type: 'retainTranscript' });
          // Rebuild first: the outcome block must outlive the hydration.
          await refresh();
          dispatch({
            type: 'compactionSummary',
            summary: result.summary,
            detail: `${result.tokensBefore} → ~${result.estimatedTokensAfter} tokens`,
            now: Date.now(),
          });
        });
      },
      importRecoveryHealth: async () =>
        attempt('session.importHealth', undefined, notice, viewed()),
      revealImportRecovery: async () => {
        await attempt('session.revealImportRecovery', undefined, notice, viewed());
      },
      exportHtml: async () => {
        const path = await attempt('session.exportHtml', undefined, notice, viewed());
        if (path) announceExport(dispatch, path);
      },
      exportJsonl: async (sessionId) => {
        const path = await attempt(
          'session.exportJsonl',
          sessionId ? { sessionId } : {},
          notice,
          viewed(),
        );
        if (path) announceExport(dispatch, path);
      },
      openDirectory: chooseDirectoryAndStart,
      addResourceDirectory: async (kind) => {
        await reloadResourceSettings(
          await attempt('settings.addResourceDirectory', { kind }, notice),
        );
      },
      removeResourceDirectory: async (kind, path) => {
        await reloadResourceSettings(
          await attempt('settings.removeResourceDirectory', { kind, path }, notice),
        );
      },
      updateSettings: async (patch) => {
        const settings = await attempt('settings.update', patch, notice);
        if (settings) dispatch({ type: 'settings', settings });
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
      loadProviderAuth: async () => {
        const providers = await attempt('auth.providers', undefined, notice, viewed());
        if (providers) dispatch({ type: 'providerAuth', providers });
      },
      loginProvider: async (providerId, method) => {
        dispatch({ type: 'authFlow', event: null });
        try {
          await invoke('auth.login', { providerId, method }, viewed());
        } catch (error) {
          notice((error as Error).message);
        } finally {
          const providers = await attempt('auth.providers', undefined, notice, viewed());
          if (providers) dispatch({ type: 'providerAuth', providers });
        }
      },
      respondProviderAuth: async (flowId, challengeId, value) => {
        await attempt('auth.respond', { flowId, challengeId, value }, notice, viewed());
      },
      cancelProviderAuth: async (flowId) => {
        await attempt('auth.cancel', { flowId }, notice, viewed());
      },
      logoutProvider: async (providerId) => {
        await run(async () => {
          await invoke('auth.logout', { providerId }, viewed());
          const providers = await invoke('auth.providers', undefined, viewed());
          dispatch({ type: 'providerAuth', providers });
          await refresh();
        });
      },
      loadPiPreferences: async () => {
        const preferences = await attempt('pi.preferences.get', undefined, notice, viewed());
        if (preferences) dispatch({ type: 'piPreferences', preferences });
      },
      updatePiPreferences: async (patch) => {
        const preferences = await attempt('pi.preferences.update', { ...patch }, notice, viewed());
        if (preferences) dispatch({ type: 'piPreferences', preferences });
      },
      abortRetry: async () => {
        await attempt('retry.abort', undefined, notice, viewed());
        const preferences = await attempt('pi.preferences.get', undefined, notice, viewed());
        if (preferences) dispatch({ type: 'piPreferences', preferences });
      },
      loadTree: async () => attempt('agent.tree', undefined, notice, viewed()),
      loadDiagnostics: async () => {
        const messages = await attempt('diagnostics.list', undefined, notice);
        if (messages) dispatch({ type: 'diagnostics', messages });
      },
      inspectSystemPrompt: async () => {
        const operation = beginScopedOperation();
        if (!operation) return;
        const inspection = await attempt(
          'agent.inspectSystemPrompt',
          undefined,
          notice,
          operation.target,
        );
        if (!inspection || !scopedOperationIsCurrent(operation)) return;
        // Local UI state only: never create a transcript block or call agent.prompt.
        dispatch({ type: 'systemPromptInspection', inspection, target: operation.target });
        if (scopedOperationIsCurrent(operation)) dispatch({ type: 'modal', modal: 'system' });
      },
      inspectTools: async () => {
        const operation = beginScopedOperation();
        if (!operation) return;
        const catalog = await attempt('tools.list', undefined, notice, operation.target);
        if (!catalog || !scopedOperationIsCurrent(operation)) return;
        dispatch({ type: 'toolCatalog', catalog, target: operation.target });
        if (scopedOperationIsCurrent(operation)) dispatch({ type: 'modal', modal: 'tools' });
      },
      reloadResources: async () => {
        const operation = beginScopedOperation();
        if (!operation) return;
        const result = await run(() => invoke('resources.reload', undefined, operation.target));
        if (!result || !scopedOperationIsCurrent(operation)) return;
        dispatch({ type: 'resourceReload', result, target: operation.target });
        await refresh(operation.target);
        if (scopedOperationIsCurrent(operation)) dispatch({ type: 'modal', modal: 'reload' });
      },
      loadExtensions: async () => {
        const [resources, policy, host] = await Promise.all([
          attempt('extensions.list', undefined, notice),
          attempt('extensions.policy.get', undefined, notice),
          attempt('extensions.host.probe', undefined, notice),
        ]);
        if (resources) dispatch({ type: 'extensionResources', resources });
        if (policy) dispatch({ type: 'extensionPolicy', policy });
        if (host) dispatch({ type: 'extensionHost', host });
      },
      updateExtensionPolicy: async (patch) => {
        const policy = await attempt('extensions.policy.update', { ...patch }, notice);
        if (policy) dispatch({ type: 'extensionPolicy', policy });
        const resources = await attempt('extensions.list', undefined, notice);
        if (resources) dispatch({ type: 'extensionResources', resources });
      },
      probeExtensionHost: async () => {
        const host = await attempt('extensions.host.probe', undefined, notice);
        if (host) dispatch({ type: 'extensionHost', host });
      },
      respondExtensionDialog: async (requestId, value) => {
        await attempt('extensions.dialog.respond', { requestId, value }, notice);
      },
      completePaths: async (query) => (await attempt('fs.complete', { query }, notice)) ?? [],
      relativize: async (paths) => (await attempt('fs.relativize', { paths }, notice)) ?? paths,
      setDraft: (text) => dispatch({ type: 'draft', text }),
      openModal: (modal) => dispatch({ type: 'modal', modal }),
      toggleExpandAll: () => dispatch({ type: 'toggleExpandAll' }),
      notice,
      refresh,
    };
  }, [
    beginNavigation,
    beginScopedOperation,
    finishNavigation,
    invalidateRefresh,
    notice,
    refresh,
    scopedOperationIsCurrent,
    viewed,
  ]);

  const value = useMemo<Store>(() => ({ state, dispatch, actions }), [state, actions]);
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

function announceExport(dispatch: (action: Action) => void, path: string): void {
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

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error('useStore must be used inside StoreProvider');
  return store;
}

export function useRunning(): boolean {
  return isRunning(useStore().state);
}

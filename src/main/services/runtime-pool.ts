import type { AgentEvent, AgentState } from '../../shared/domain.js';
import type { BridgeEvent, RuntimeSnapshot, SessionTarget } from '../../shared/ipc.js';
import type { JsonlAgentRuntime } from '../runtime/agent-runtime.js';
import type { SettingsStore } from './settings.js';
import { PromptQueueService, type PromptQueueKind } from './prompt-queue.js';
import { RuntimeManager } from './runtime-manager.js';

/**
 * Owns one runtime process per live session and routes IPC to the session the
 * user is currently viewing. Inactive processes keep running; their stream
 * events are withheld so they cannot corrupt the active transcript.
 */
export class RuntimePool {
  private readonly managers = new Set<RuntimeManager>();
  private readonly sessions = new Map<string, RuntimeManager>();
  /** Stable ownership assigned at activation; never inferred from transient startup state. */
  private readonly owners = new Map<string, RuntimeManager>();
  /** Queue scheduling state is independent of RuntimeManager's presentation status. */
  private readonly runLifecycles = new Map<RuntimeManager, RunLifecycle>();
  private current: RuntimeManager | null = null;
  private starting: Promise<RuntimeSnapshot> | null = null;
  /** Serializes lifecycle transitions so rapid clicks cannot launch duplicate owners. */
  private transitions: Promise<void> = Promise.resolve();
  private readonly queues: PromptQueueService;

  constructor(
    private readonly settings: SettingsStore,
    private readonly broadcast: (event: BridgeEvent) => void,
  ) {
    this.queues = new PromptQueueService(broadcast, (message) =>
      broadcast({ type: 'diagnostic', message }),
    );
  }

  get active(): JsonlAgentRuntime {
    if (!this.current) throw new Error('Runtime is not started');
    return this.current.active;
  }

  /**
   * Resolves the runtime that owns `target`, falling back to the selected one
   * when the caller names no transcript.
   *
   * Session-scoped IPC is not serialized against lifecycle transitions, so
   * resolving through the selected runtime alone lets a switch that is already
   * in flight redirect a prompt or a transcript read into the wrong session.
   * Routing by identity keeps every command attached to the transcript the
   * renderer acted on, even when it is running in the background.
   */
  runtimeFor(target?: SessionTarget | null): JsonlAgentRuntime {
    return this.managerFor(target).active;
  }

  enqueuePrompt(kind: PromptQueueKind, text: string, target?: SessionTarget | null): void {
    const manager = this.managerFor(target);
    this.queues.enqueue(targetFor(manager), kind, text);
    // The turn may settle between the renderer observing `running` and this
    // request reaching main. Treat the now-idle process as the settle boundary.
    if (!isBusy(manager)) void this.schedule(manager);
  }

  popPrompt(target?: SessionTarget | null): ReturnType<PromptQueueService['pop']> {
    const manager = this.managerFor(target);
    return this.queues.pop(targetFor(manager));
  }

  resolvePromptRecall(
    id: string,
    outcome: 'accept' | 'restore',
    target?: SessionTarget | null,
  ): boolean {
    // Resolution is queue-owned and must outlive runtime navigation. An idle
    // `new session` can replace the old transcript in its process while the
    // renderer response is in flight, so an explicit target is authoritative
    // even when no live RuntimeManager owns it anymore.
    const resolvedTarget = target ?? targetFor(this.managerFor());
    return this.queues.resolveRecall(resolvedTarget, id, outcome);
  }

  queueSnapshot(target?: SessionTarget | null): ReturnType<PromptQueueService['snapshot']> {
    const manager = this.managerFor(target);
    return this.queues.snapshot(targetFor(manager));
  }

  private managerFor(target?: SessionTarget | null): RuntimeManager {
    if (!target) {
      if (!this.current) throw new Error('Runtime is not started');
      return this.current;
    }
    const owner = this.ownerOf(target);
    if (owner) return owner;
    throw new Error(`Session is no longer available: ${target.sessionId}`);
  }

  private ownerOf(target: SessionTarget): RuntimeManager | null {
    const current = this.current;
    if (current && matches(current, target)) return current;
    const key = sessionKey(target.runtime, target.sessionId);
    const routed = this.owners.get(key) ?? this.sessions.get(key);
    if (routed?.isStarted) return routed;
    return (
      [...this.managers].find((manager) => manager.isStarted && matches(manager, target)) ?? null
    );
  }

  snapshot(): RuntimeSnapshot {
    return (
      this.current?.snapshot() ?? new RuntimeManager(this.settings, () => undefined).snapshot()
    );
  }

  listDiagnostics(): string[] {
    return [...this.managers]
      .flatMap((manager) => manager.listDiagnostics())
      .sort((left, right) => left.localeCompare(right));
  }

  /** Explicit starts/restarts replace only the viewed process, not background sessions. */
  async start(
    options: { cwd?: string | null; sessionRef?: string | null } = {},
  ): Promise<RuntimeSnapshot> {
    if (options.sessionRef) return this.activateSession(options.sessionRef, options.cwd);
    // React development StrictMode can bootstrap twice before the first
    // runtime handshake completes. Share that handshake rather than letting
    // the second call stop the process the first call just launched.
    if (this.starting) return this.starting;
    const starting = this.enqueueTransition(() => this.startFresh(options));
    this.starting = starting;
    try {
      return await starting;
    } finally {
      if (this.starting === starting) this.starting = null;
    }
  }

  private async startFresh(
    options: { cwd?: string | null; sessionRef?: string | null },
    { replaceCurrent = true }: { replaceCurrent?: boolean } = {},
  ): Promise<RuntimeSnapshot> {
    if (replaceCurrent && this.current) await this.remove(this.current);
    const manager = this.createManager();
    this.current = manager;
    try {
      const snapshot = await manager.start(options);
      this.index(manager);
      this.claimSnapshot(manager);
      void this.schedule(manager);
      return snapshot;
    } catch (error) {
      this.managers.delete(manager);
      this.runLifecycles.delete(manager);
      throw error;
    }
  }

  /** Restarts the viewed transcript and lets its retained queue resume draining. */
  async restart(): Promise<RuntimeSnapshot> {
    return this.enqueueTransition(async () => {
      const snapshot = this.current?.snapshot();
      const state = snapshot?.state;
      const sessionRef =
        snapshot?.runtime === 'pi' ? (state?.sessionFile ?? state?.sessionId) : state?.sessionId;
      return this.startFresh({ cwd: snapshot?.cwd ?? null, sessionRef: sessionRef ?? null });
    });
  }

  /** Selects an existing process or launches a new process for the session. */
  async activateSession(ref: string, cwd?: string | null): Promise<RuntimeSnapshot> {
    return this.enqueueTransition(() => this.activateSessionNow(ref, cwd));
  }

  /**
   * Opens an empty session. A runtime that is mid-run keeps its transcript:
   * `new_session` swaps the session underneath the live agent, so the rest of
   * that turn would be written into the new session and both transcripts would
   * end up corrupted. Busy runtimes are therefore left in the background and
   * the empty session gets a dedicated process.
   */
  async newSession(target?: SessionTarget | null): Promise<RuntimeSnapshot> {
    return this.enqueueTransition(async () => {
      const manager = target ? this.ownerOf(target) : this.current;
      if (manager?.isStarted && !isBusy(manager)) {
        this.current = manager;
        await manager.active.newSession();
        await manager.refreshState();
        this.removeOwnership(manager);
        this.index(manager);
        this.claimSnapshot(manager);
        return manager.snapshot();
      }
      // A busy runtime keeps both its transcript and its process; a stopped or
      // failed one is replaced rather than left behind.
      return this.startFresh(
        { cwd: manager?.snapshot().cwd ?? null },
        { replaceCurrent: !manager || !isBusy(manager) },
      );
    });
  }

  private async activateSessionNow(ref: string, cwd?: string | null): Promise<RuntimeSnapshot> {
    const kind = this.settings.current.agentRuntime;
    const recent = this.settings.current.recentSessions.find(
      (session) => session.runtime === kind && (session.id === ref || session.path === ref),
    );
    const keys = [
      sessionKey(kind, recent?.id ?? ref),
      recent?.path && sessionKey(kind, recent.path),
    ].filter((key): key is string => Boolean(key));
    const owned = keys.map((key) => this.owners.get(key)).find(Boolean);
    const indexed = keys.map((key) => this.sessions.get(key)).find(Boolean);
    const candidates = [...this.managers].filter((manager) => {
      if (manager.kind !== kind) return false;
      const state = manager.snapshot().state;
      return (
        state?.sessionId === (recent?.id ?? ref) ||
        (recent?.path !== null && recent?.path !== undefined && state?.sessionFile === recent.path)
      );
    });
    // Prefer a background candidate when returning from another process. A
    // process being launched for the current selection can briefly expose the
    // runtime's default session id, which may equal the requested background
    // id even though that process does not own its transcript.
    const discovered = candidates.find((manager) => manager !== this.current) ?? candidates[0];
    const existing = owned ?? indexed ?? discovered;
    if (existing) {
      this.current = existing;
      const snapshot = existing.snapshot();
      this.broadcast({ type: 'status', snapshot });
      this.broadcastActivity(existing, snapshot.status, false);
      return snapshot;
    }

    const previous = this.current;
    const manager = this.createManager();
    this.current = manager;
    for (const key of keys) this.owners.set(key, manager);
    try {
      let snapshot = await manager.start({ cwd: cwd ?? recent?.cwd ?? null, sessionRef: ref });
      // Tau normally resumes from its launch argument. This fallback also
      // supports compatible runtimes that accept the argument but ignore it.
      if (kind === 'tau' && recent && snapshot.state?.sessionId !== recent.id) {
        await manager.active.switchSession(ref);
        await manager.refreshState();
        snapshot = manager.snapshot();
      }
      this.index(manager);
      this.claimSnapshot(manager);
      void this.schedule(manager);
      return snapshot;
    } catch (error) {
      // A failed resume may happen after the subprocess has started. Always
      // close it; otherwise a detached process can keep writing the same
      // session while a later click launches another owner.
      await this.remove(manager);
      if (this.current === null || this.current === manager) this.current = previous;
      if (this.current) this.broadcast({ type: 'status', snapshot: this.current.snapshot() });
      throw error;
    }
  }

  async stop(): Promise<RuntimeSnapshot> {
    if (!this.current) return this.snapshot();
    const manager = this.current;
    const snapshot = await manager.stop();
    this.removeIndexes(manager);
    this.removeOwnership(manager);
    this.managers.delete(manager);
    this.runLifecycles.delete(manager);
    this.current = null;
    return snapshot;
  }

  async stopAll(): Promise<void> {
    const managers = [...this.managers];
    this.current = null;
    this.sessions.clear();
    this.owners.clear();
    this.managers.clear();
    this.runLifecycles.clear();
    await Promise.allSettled(managers.map((manager) => manager.stop()));
  }

  async nameSession(name: string, target?: SessionTarget | null): Promise<void> {
    await this.managerFor(target).nameSession(name);
  }

  async refreshState(touch = false, target?: SessionTarget | null): Promise<AgentState | null> {
    const manager = target ? this.ownerOf(target) : this.current;
    if (!manager) return null;
    const state = await manager.refreshState(touch);
    if (manager !== this.current) return state;
    this.removeOwnership(manager);
    this.index(manager);
    this.claimSnapshot(manager);
    return state;
  }

  private enqueueTransition<T>(work: () => Promise<T>): Promise<T> {
    const result = this.transitions.then(work, work);
    this.transitions = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private createManager(): RuntimeManager {
    const manager = new RuntimeManager(this.settings, (event) => this.handleEvent(manager, event));
    this.managers.add(manager);
    this.runLifecycles.set(manager, freshLifecycle(null));
    return manager;
  }

  private handleEvent(manager: RuntimeManager, event: BridgeEvent): void {
    if (event.type === 'status') {
      if (['stopped', 'failed', 'disconnected'].includes(event.snapshot.status)) {
        this.lifecycleFor(manager).phase = 'blocked';
      }
      this.broadcastActivity(
        manager,
        event.snapshot.status,
        manager === this.current ? false : null,
      );
    }
    if (event.type === 'agent') {
      const settled = this.advanceLifecycle(manager, event.event);
      if (event.event.type === 'agent_settled') {
        this.broadcastActivity(manager, manager.snapshot().status, manager !== this.current);
        if (settled) void this.schedule(manager);
      }
    }
    // Settings are application-global. Every other transcript event is shown
    // only while that transcript is selected. Session activity is separately
    // broadcast above so the rail can monitor background runtimes.
    if (event.type === 'settings' || manager === this.current) this.broadcast(event);
  }

  /**
   * Advances the queue's authoritative run gate from normalized stream evidence.
   * RuntimeManager separately protects presentation status; this scheduling
   * gate accepts a settle only after the current run closed its final
   * turn and emitted agent_end (or an explicit runtime error). A stale settle
   * therefore cannot drain another item after a new prompt has started.
   */
  private advanceLifecycle(manager: RuntimeManager, event: AgentEvent): boolean {
    const lifecycle = this.lifecycleFor(manager);
    switch (event.type) {
      case 'agent_start':
        lifecycle.phase = 'running';
        lifecycle.turnOpen = false;
        lifecycle.turnEnded = false;
        return false;
      case 'turn_start':
        lifecycle.phase = 'running';
        lifecycle.turnOpen = true;
        lifecycle.turnEnded = false;
        return false;
      case 'turn_end':
        if (lifecycle.phase === 'running') {
          lifecycle.turnOpen = false;
          lifecycle.turnEnded = true;
        }
        return false;
      case 'agent_end':
        if (event.willRetry) {
          lifecycle.phase = 'running';
          lifecycle.turnEnded = false;
        } else if (lifecycle.phase === 'running' && !lifecycle.turnOpen && lifecycle.turnEnded) {
          lifecycle.phase = 'ended';
        }
        return false;
      case 'retry_start':
        lifecycle.phase = 'running';
        lifecycle.turnEnded = false;
        return false;
      case 'runtime_error':
        if (lifecycle.phase === 'running') lifecycle.phase = 'ended';
        return false;
      case 'agent_settled':
        if (lifecycle.phase !== 'ready' && lifecycle.phase !== 'ended') return false;
        lifecycle.phase = 'ready';
        lifecycle.turnOpen = false;
        lifecycle.turnEnded = false;
        return true;
      default:
        return false;
    }
  }

  private lifecycleFor(manager: RuntimeManager): RunLifecycle {
    const sessionId = manager.snapshot().state?.sessionId ?? null;
    let lifecycle = this.runLifecycles.get(manager);
    if (!lifecycle || lifecycle.sessionId !== sessionId) {
      lifecycle = freshLifecycle(sessionId);
      this.runLifecycles.set(manager, lifecycle);
    }
    return lifecycle;
  }

  private async schedule(manager: RuntimeManager): Promise<void> {
    const snapshot = manager.snapshot();
    const lifecycle = this.lifecycleFor(manager);
    if (
      !manager.isStarted ||
      snapshot.status !== 'idle' ||
      !snapshot.state?.sessionId ||
      lifecycle.phase !== 'ready'
    ) {
      return;
    }
    await this.queues.dispatchNext(targetFor(manager), async (text) => {
      lifecycle.phase = 'handoff';
      try {
        await manager.active.prompt({ text });
      } catch (error) {
        // A rejected RPC never started a run, so the reinstated item may be
        // attempted again at the next idle scheduling boundary.
        if (lifecycle.phase === 'handoff') lifecycle.phase = 'ready';
        throw error;
      }
    });
  }

  private broadcastActivity(
    manager: RuntimeManager,
    status: ReturnType<RuntimeManager['snapshot']>['status'],
    responseReady: boolean | null,
  ): void {
    const snapshot = manager.snapshot();
    const sessionId = snapshot.state?.sessionId;
    if (!sessionId) return;
    this.broadcast({
      type: 'sessionActivity',
      activity: { sessionId, runtime: snapshot.runtime, status, responseReady },
    });
  }

  /**
   * Updates routing only at explicit lifecycle boundaries. RuntimeManager emits
   * settings while starting and may still describe its temporary default
   * session; indexing those events can let a new process steal another live
   * session's route before its requested session has been applied.
   */
  private index(manager: RuntimeManager): void {
    const snapshot = manager.snapshot();
    const state = snapshot.state;
    if (!state?.sessionId) return;
    this.removeIndexes(manager);
    this.setIndex(sessionKey(snapshot.runtime, state.sessionId), manager);
    if (state.sessionFile) this.setIndex(sessionKey(snapshot.runtime, state.sessionFile), manager);
  }

  private setIndex(key: string, manager: RuntimeManager): void {
    // A newly launched adapter may briefly report its default session before
    // applying the requested resume. Never let that transient state steal an
    // already-live session's routing entry.
    if (!this.sessions.has(key) || this.sessions.get(key) === manager) {
      this.sessions.set(key, manager);
    }
  }

  private claimSnapshot(manager: RuntimeManager): void {
    const snapshot = manager.snapshot();
    const state = snapshot.state;
    if (!state?.sessionId) return;
    this.claimKey(sessionKey(snapshot.runtime, state.sessionId), manager);
    if (state.sessionFile) this.claimKey(sessionKey(snapshot.runtime, state.sessionFile), manager);
  }

  private claimKey(key: string, manager: RuntimeManager): void {
    if (!this.owners.has(key) || this.owners.get(key) === manager) this.owners.set(key, manager);
  }

  private removeIndexes(manager: RuntimeManager): void {
    for (const [key, value] of this.sessions) if (value === manager) this.sessions.delete(key);
  }

  private removeOwnership(manager: RuntimeManager): void {
    for (const [key, value] of this.owners) if (value === manager) this.owners.delete(key);
  }

  private async remove(manager: RuntimeManager): Promise<void> {
    await manager.stop();
    this.removeIndexes(manager);
    this.removeOwnership(manager);
    this.managers.delete(manager);
    this.runLifecycles.delete(manager);
    if (this.current === manager) this.current = null;
  }
}

interface RunLifecycle {
  sessionId: string | null;
  phase: 'ready' | 'handoff' | 'running' | 'ended' | 'blocked';
  turnOpen: boolean;
  turnEnded: boolean;
}

function freshLifecycle(sessionId: string | null): RunLifecycle {
  return { sessionId, phase: 'ready', turnOpen: false, turnEnded: false };
}

function targetFor(manager: RuntimeManager): SessionTarget {
  const snapshot = manager.snapshot();
  const sessionId = snapshot.state?.sessionId;
  if (!sessionId) throw new Error('Runtime session is not ready');
  return { runtime: snapshot.runtime, sessionId };
}

function sessionKey(kind: string, ref: string): string {
  return `${kind}:${ref}`;
}

function isBusy(manager: RuntimeManager): boolean {
  const status = manager.snapshot().status;
  return (
    status === 'starting' ||
    status === 'running' ||
    status === 'compacting' ||
    status === 'retrying'
  );
}

function matches(manager: RuntimeManager, target: SessionTarget): boolean {
  const snapshot = manager.snapshot();
  return snapshot.runtime === target.runtime && snapshot.state?.sessionId === target.sessionId;
}

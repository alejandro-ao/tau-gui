import type { AgentState } from '../../shared/domain.js';
import type { BridgeEvent, RuntimeSnapshot } from '../../shared/ipc.js';
import type { JsonlAgentRuntime } from '../runtime/agent-runtime.js';
import type { SettingsStore } from './settings.js';
import { RuntimeManager } from './runtime-manager.js';

/**
 * Owns one runtime process per live session and routes IPC to the session the
 * user is currently viewing. Inactive processes keep running; their stream
 * events are withheld so they cannot corrupt the active transcript.
 */
export class RuntimePool {
  private readonly managers = new Set<RuntimeManager>();
  private readonly sessions = new Map<string, RuntimeManager>();
  private current: RuntimeManager | null = null;

  constructor(
    private readonly settings: SettingsStore,
    private readonly broadcast: (event: BridgeEvent) => void,
  ) {}

  get active(): JsonlAgentRuntime {
    if (!this.current) throw new Error('Runtime is not started');
    return this.current.active;
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
    if (this.current) await this.remove(this.current);
    const manager = this.createManager();
    this.current = manager;
    try {
      const snapshot = await manager.start(options);
      this.index(manager);
      return snapshot;
    } catch (error) {
      this.managers.delete(manager);
      throw error;
    }
  }

  /** Selects an existing process or launches a new process for the session. */
  async activateSession(ref: string, cwd?: string | null): Promise<RuntimeSnapshot> {
    const kind = this.settings.current.agentRuntime;
    const recent = this.settings.current.recentSessions.find(
      (session) => session.runtime === kind && (session.id === ref || session.path === ref),
    );
    const keys = [
      sessionKey(kind, recent?.id ?? ref),
      recent?.path && sessionKey(kind, recent.path),
    ].filter((key): key is string => Boolean(key));
    const existing = keys.map((key) => this.sessions.get(key)).find(Boolean);
    if (existing) {
      this.current = existing;
      const snapshot = existing.snapshot();
      this.broadcast({ type: 'status', snapshot });
      return snapshot;
    }

    const previous = this.current;
    const manager = this.createManager();
    this.current = manager;
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
      return snapshot;
    } catch (error) {
      this.managers.delete(manager);
      this.current = previous;
      if (previous) this.broadcast({ type: 'status', snapshot: previous.snapshot() });
      throw error;
    }
  }

  async stop(): Promise<RuntimeSnapshot> {
    if (!this.current) return this.snapshot();
    const manager = this.current;
    const snapshot = await manager.stop();
    this.removeIndexes(manager);
    this.managers.delete(manager);
    this.current = null;
    return snapshot;
  }

  async stopAll(): Promise<void> {
    const managers = [...this.managers];
    this.current = null;
    this.sessions.clear();
    this.managers.clear();
    await Promise.allSettled(managers.map((manager) => manager.stop()));
  }

  async refreshState(touch = false): Promise<AgentState | null> {
    if (!this.current) return null;
    const state = await this.current.refreshState(touch);
    this.index(this.current);
    return state;
  }

  private createManager(): RuntimeManager {
    const manager = new RuntimeManager(this.settings, (event) => this.handleEvent(manager, event));
    this.managers.add(manager);
    return manager;
  }

  private handleEvent(manager: RuntimeManager, event: BridgeEvent): void {
    if (event.type === 'settings') this.index(manager);
    // Settings are application-global. Every other event belongs to one
    // transcript and is shown only while that transcript is selected.
    if (event.type === 'settings' || manager === this.current) this.broadcast(event);
  }

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

  private removeIndexes(manager: RuntimeManager): void {
    for (const [key, value] of this.sessions) if (value === manager) this.sessions.delete(key);
  }

  private async remove(manager: RuntimeManager): Promise<void> {
    await manager.stop();
    this.removeIndexes(manager);
    this.managers.delete(manager);
    if (this.current === manager) this.current = null;
  }
}

function sessionKey(kind: string, ref: string): string {
  return `${kind}:${ref}`;
}

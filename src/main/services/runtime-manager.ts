import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentEvent,
  AgentState,
  RuntimeKind,
  RuntimeLaunchConfig,
  RuntimeStatus,
  ProjectTrust,
} from '../../shared/domain.js';
import type { BridgeEvent, RuntimeSnapshot } from '../../shared/ipc.js';
import {
  JsonlAgentRuntime,
  type AgentRuntime,
  type RuntimeSink,
} from '../runtime/agent-runtime.js';
import { CAPABILITIES } from '../runtime/spec.js';
import { probeRuntime } from './discovery.js';
import type { SettingsStore } from './settings.js';

const execFileAsync = promisify(execFile);
const MAX_DIAGNOSTICS = 500;
const SESSION_NAME_POLL_INTERVAL_MS = 100;
const SESSION_NAME_POLL_LIMIT = 300;

/**
 * Owns the runtime subprocess lifecycle and the derived process state machine:
 * starting → idle → running → compacting/retrying → idle (on agent_settled)
 * → failed/disconnected.
 */
export type RuntimeFactory = (kind: RuntimeKind, sink: RuntimeSink) => AgentRuntime;

const legacyRpcRuntimeFactory: RuntimeFactory = (kind, sink) => new JsonlAgentRuntime(kind, sink);

export interface RuntimeManagerOptions {
  runtimeFactory?: RuntimeFactory;
  /** The legacy test adapter needs executable discovery; embedded Pi does not. */
  probeExecutable?: boolean;
}

export class RuntimeManager {
  private runtime: AgentRuntime | null = null;
  private status: RuntimeStatus = 'stopped';
  private detail: string | null = null;
  private cwd: string | null = null;
  private gitBranch: string | null = null;
  private state: AgentState | null = null;
  private runtimeVersion: string | null = null;
  private runtimeKind: RuntimeKind | null = null;
  private launchProjectTrust: ProjectTrust | null = null;
  private firstMessage: string | null = null;
  /** Prevents stale duplicate settles from changing an active run's UI status. */
  private settleExpected = true;
  private loadingFirstMessageFor: string | null = null;
  private watchingSessionNameFor: string | null = null;
  /** Manual name accepted before Tau indexes an empty session. */
  private pendingSessionName: { sessionId: string; name: string } | null = null;
  private readonly diagnostics: string[] = [];

  private readonly runtimeFactory: RuntimeFactory;
  private readonly probeExecutable: boolean;

  constructor(
    private readonly settings: SettingsStore,
    private readonly broadcast: (event: BridgeEvent) => void,
    options: RuntimeManagerOptions = {},
  ) {
    this.runtimeFactory = options.runtimeFactory ?? legacyRpcRuntimeFactory;
    this.probeExecutable = options.probeExecutable ?? true;
  }

  get kind(): RuntimeKind {
    // A manager keeps the runtime kind it was launched with. Settings may
    // change while this process continues in the background.
    return this.runtimeKind ?? this.settings.current.agentRuntime;
  }

  get active(): AgentRuntime {
    if (!this.runtime) throw new Error('Runtime is not started');
    return this.runtime;
  }

  get isStarted(): boolean {
    return this.runtime !== null;
  }

  /** Trust passed to the active subprocess, unaffected by later settings edits. */
  get effectiveProjectTrust(): ProjectTrust | null {
    return this.runtime ? this.launchProjectTrust : null;
  }

  snapshot(): RuntimeSnapshot {
    return {
      runtime: this.kind,
      status: this.status,
      detail: this.detail,
      runtimeVersion: this.runtimeVersion,
      capabilities: this.runtime?.capabilities ?? CAPABILITIES[this.kind],
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      state: this.state,
    };
  }

  listDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  async start(
    options: {
      cwd?: string | null;
      sessionRef?: string | null;
      runtime?: RuntimeKind;
    } = {},
  ): Promise<RuntimeSnapshot> {
    if (this.runtime) await this.stop();
    const settings = this.settings.current;
    const cwd = options.cwd ?? settings.cwd ?? process.cwd();
    const kind = options.runtime ?? settings.agentRuntime;
    const runtimeSettings = settings.runtime[kind];
    const config: RuntimeLaunchConfig = {
      kind,
      binary: runtimeSettings.binary,
      cwd,
      provider: runtimeSettings.provider,
      model: runtimeSettings.model,
      sessionRef: options.sessionRef ?? null,
      extraArgs: runtimeSettings.extraArgs,
      projectTrust: settings.projectTrust,
    };

    // Executable probing remains only for the injected JSONL fake used by
    // deterministic tests. The packaged app embeds Pi and needs no binary.
    if (this.probeExecutable) {
      const probe = await probeRuntime(config.kind, config.binary);
      if (!probe.resolved) {
        this.cwd = cwd;
        const message = probe.error ?? `Runtime executable not found: ${config.binary}`;
        this.setStatus('failed', message);
        this.addDiagnostic(message);
        throw new Error(message);
      }
      this.runtimeVersion = probe.version;
      if (probe.version) this.addDiagnostic(`${config.kind} ${probe.version}`);
    } else {
      this.runtimeVersion = null;
    }
    this.runtimeKind = kind;

    this.cwd = cwd;
    this.gitBranch = await readGitBranch(cwd);
    const runtime = this.runtimeFactory(kind, {
      event: (event) => this.handleEvent(event),
      status: (status, detail) => this.setStatus(status, detail ?? null),
      diagnostic: (line) => this.addDiagnostic(line),
    });
    this.runtime = runtime;
    this.launchProjectTrust = config.projectTrust;

    try {
      await runtime.start(config);
    } catch (error) {
      this.runtime = null;
      this.launchProjectTrust = null;
      const message = describeStartFailure(config, error as Error);
      this.setStatus('failed', message);
      this.addDiagnostic(message);
      throw new Error(message);
    }

    await this.refreshState();
    return this.snapshot();
  }

  async stop(): Promise<RuntimeSnapshot> {
    const runtime = this.runtime;
    this.runtime = null;
    this.launchProjectTrust = null;
    if (runtime) await runtime.stop();
    this.state = null;
    this.watchingSessionNameFor = null;
    this.pendingSessionName = null;
    this.runtimeVersion = null;
    this.settleExpected = true;
    this.setStatus('stopped', null);
    return this.snapshot();
  }

  /**
   * `touch` marks real session activity (a settled run): the session climbs
   * the recent list. Plain refreshes — resume, rename, model changes — leave
   * the list order alone.
   */
  async refreshState(touch = false): Promise<AgentState | null> {
    if (!this.runtime) return null;
    try {
      let state = await this.runtime.getState();
      if (state.sessionId !== this.state?.sessionId) {
        this.firstMessage = null;
        if (this.pendingSessionName?.sessionId !== state.sessionId) this.pendingSessionName = null;
      }
      // Tau does not index an empty session until its first prompt. Preserve a
      // name queued for that session across authoritative refreshes meanwhile.
      if (this.pendingSessionName?.sessionId === state.sessionId) {
        state = { ...state, sessionName: this.pendingSessionName.name };
      }
      this.state = state;
      if (!state.sessionName && state.messageCount > 0 && !this.firstMessage) {
        void this.loadFirstMessage(state.sessionId);
      }
      if (state.sessionId) this.rememberCurrentSession(touch);
      this.broadcast({ type: 'status', snapshot: this.snapshot() });
      return state;
    } catch (error) {
      this.addDiagnostic(`Failed to refresh runtime state: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Name the active session. Tau rejects this for a newly-created, empty
   * session because its index entry does not exist until the first prompt.
   * Accept that narrow case locally and persist it once the first turn settles.
   */
  async nameSession(name: string): Promise<void> {
    if (!this.runtime || !this.state?.sessionId) throw new Error('Runtime is not started');
    try {
      await this.runtime.nameSession(name);
    } catch (error) {
      if (
        this.kind !== 'tau' ||
        this.state.messageCount > 0 ||
        !/unknown session/i.test((error as Error).message)
      ) {
        throw error;
      }
      this.pendingSessionName = { sessionId: this.state.sessionId, name };
      this.state = { ...this.state, sessionName: name };
      this.rememberCurrentSession(false);
      this.broadcast({ type: 'status', snapshot: this.snapshot() });
      return;
    }
    this.pendingSessionName = null;
    await this.refreshState();
  }

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
        this.settleExpected = false;
        this.setStatus('running', null);
        break;
      case 'message_start':
        if (
          event.message.role === 'user' &&
          !this.firstMessage &&
          (this.state?.messageCount ?? 0) === 0
        ) {
          this.firstMessage = event.message.text.trim() || null;
          this.rememberCurrentSession(false, 1);
          void this.watchSessionName(this.state?.sessionId ?? '');
        }
        break;
      case 'compaction_start':
        this.setStatus('compacting', null);
        break;
      case 'retry_start':
        this.settleExpected = false;
        this.setStatus('retrying', event.message || null);
        break;
      case 'compaction_end':
      case 'retry_end':
        if (this.status === 'compacting' || this.status === 'retrying') {
          this.setStatus('running', null);
        }
        break;
      case 'agent_end':
        this.settleExpected = !event.willRetry;
        break;
      case 'agent_settled':
        // Idle depends on an agent_end/agent_settled pair. A delayed duplicate
        // from the previous run must not make the current streaming run idle.
        if (this.settleExpected) {
          this.settleExpected = false;
          this.setStatus('idle', null);
          void this.persistPendingSessionName();
        }
        break;
      case 'runtime_error':
        this.settleExpected = true;
        this.setStatus('idle', event.message);
        break;
      default:
        break;
    }
    // Stream events carry their immutable session identity. Main-process
    // filtering prevents normal background delivery; the identity also lets
    // the renderer reject an event already queued before a session switch.
    const sessionId = this.state?.sessionId;
    if (sessionId) this.broadcast({ type: 'agent', sessionId, runtime: this.kind, event });
  }

  private async persistPendingSessionName(): Promise<void> {
    const pending = this.pendingSessionName;
    if (!pending || !this.runtime || this.state?.sessionId !== pending.sessionId) {
      await this.refreshState(true);
      return;
    }
    try {
      await this.runtime.nameSession(pending.name);
      if (this.pendingSessionName === pending) this.pendingSessionName = null;
    } catch (error) {
      this.addDiagnostic(`Failed to persist session name: ${(error as Error).message}`);
    }
    await this.refreshState(true);
  }

  /**
   * Tau generates the first-turn title with the active model while the agent
   * run continues. Poll its authoritative state so that title reaches the UI
   * as soon as that parallel request finishes, rather than at agent_settled.
   * Pi and older Tau versions simply remain on the immediate first-message
   * label until the run settles.
   */
  private async watchSessionName(sessionId: string): Promise<void> {
    if (!sessionId || !this.runtime || this.watchingSessionNameFor === sessionId) return;
    this.watchingSessionNameFor = sessionId;
    try {
      for (let attempt = 0; attempt < SESSION_NAME_POLL_LIMIT; attempt += 1) {
        await delay(SESSION_NAME_POLL_INTERVAL_MS);
        if (!this.runtime || this.state?.sessionId !== sessionId) return;
        const state = await this.refreshState();
        if (!state || state.sessionName || this.status === 'idle') return;
      }
    } finally {
      if (this.watchingSessionNameFor === sessionId) this.watchingSessionNameFor = null;
    }
  }

  private async loadFirstMessage(sessionId: string): Promise<void> {
    if (!this.runtime || this.loadingFirstMessageFor === sessionId) return;
    this.loadingFirstMessageFor = sessionId;
    try {
      const messages = await this.runtime.getMessages();
      if (this.state?.sessionId !== sessionId) return;
      this.firstMessage = messages.find((message) => message.role === 'user')?.text.trim() ?? null;
      this.rememberCurrentSession(false);
    } catch (error) {
      this.addDiagnostic(`Failed to load session label: ${(error as Error).message}`);
    } finally {
      if (this.loadingFirstMessageFor === sessionId) this.loadingFirstMessageFor = null;
    }
  }

  private rememberCurrentSession(touch: boolean, minimumMessageCount = 0): void {
    const state = this.state;
    if (!state?.sessionId) return;
    this.settings.rememberSession(
      {
        id: state.sessionId,
        name: state.sessionName,
        firstMessage: this.firstMessage,
        messageCount: Math.max(state.messageCount, minimumMessageCount),
        path: state.sessionFile,
        cwd: this.cwd,
        runtime: this.kind,
        lastSeen: Date.now(),
      },
      touch,
    );
    this.broadcast({ type: 'settings', settings: this.settings.current });
  }

  private setStatus(status: RuntimeStatus, detail: string | null = null): void {
    this.status = status;
    this.detail = detail;
    this.broadcast({ type: 'status', snapshot: this.snapshot() });
  }

  private addDiagnostic(line: string): void {
    this.diagnostics.push(`${new Date().toISOString()} ${line}`);
    if (this.diagnostics.length > MAX_DIAGNOSTICS) this.diagnostics.shift();
    this.broadcast({ type: 'diagnostic', message: line });
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function describeStartFailure(config: RuntimeLaunchConfig, error: Error): string {
  const message = error.message;
  if (message.includes('ENOENT')) {
    return `Runtime executable not found: ${config.binary}. Set the ${config.kind} binary path in settings.`;
  }
  return `Failed to start ${config.kind}: ${message}`;
}

export async function readGitBranch(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      timeout: 3_000,
    });
    const branch = stdout.trim();
    return branch.length > 0 ? branch : null;
  } catch {
    return null;
  }
}

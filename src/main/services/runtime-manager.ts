import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentEvent,
  AgentState,
  RuntimeKind,
  RuntimeLaunchConfig,
  RuntimeStatus,
} from '../../shared/domain.js';
import type { BridgeEvent, RuntimeSnapshot } from '../../shared/ipc.js';
import { JsonlAgentRuntime } from '../runtime/agent-runtime.js';
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
export class RuntimeManager {
  private runtime: JsonlAgentRuntime | null = null;
  private status: RuntimeStatus = 'stopped';
  private detail: string | null = null;
  private cwd: string | null = null;
  private gitBranch: string | null = null;
  private state: AgentState | null = null;
  private runtimeVersion: string | null = null;
  private runtimeKind: RuntimeKind | null = null;
  private firstMessage: string | null = null;
  private loadingFirstMessageFor: string | null = null;
  private watchingSessionNameFor: string | null = null;
  private readonly diagnostics: string[] = [];

  constructor(
    private readonly settings: SettingsStore,
    private readonly broadcast: (event: BridgeEvent) => void,
  ) {}

  get kind(): RuntimeKind {
    // A manager keeps the runtime kind it was launched with. Settings may
    // change while this process continues in the background.
    return this.runtimeKind ?? this.settings.current.agentRuntime;
  }

  get active(): JsonlAgentRuntime {
    if (!this.runtime) throw new Error('Runtime is not started');
    return this.runtime;
  }

  get isStarted(): boolean {
    return this.runtime !== null;
  }

  snapshot(): RuntimeSnapshot {
    return {
      runtime: this.kind,
      status: this.status,
      detail: this.detail,
      runtimeVersion: this.runtimeVersion,
      capabilities: CAPABILITIES[this.kind],
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      state: this.state,
    };
  }

  listDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  async start(
    options: { cwd?: string | null; sessionRef?: string | null } = {},
  ): Promise<RuntimeSnapshot> {
    if (this.runtime) await this.stop();
    const settings = this.settings.current;
    const cwd = options.cwd ?? settings.cwd ?? process.cwd();
    const kind = settings.agentRuntime;
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

    // First-run check: fail fast with an actionable message when the runtime
    // binary is missing, instead of surfacing a raw spawn ENOENT.
    const probe = await probeRuntime(config.kind, config.binary);
    if (!probe.resolved) {
      this.cwd = cwd;
      const message = probe.error ?? `Runtime executable not found: ${config.binary}`;
      this.setStatus('failed', message);
      this.addDiagnostic(message);
      throw new Error(message);
    }
    this.runtimeKind = kind;
    this.runtimeVersion = probe.version;
    if (probe.version) this.addDiagnostic(`${config.kind} ${probe.version}`);

    this.cwd = cwd;
    this.gitBranch = await readGitBranch(cwd);
    const runtime = new JsonlAgentRuntime(kind, {
      event: (event) => this.handleEvent(event),
      status: (status, detail) => this.setStatus(status, detail ?? null),
      diagnostic: (line) => this.addDiagnostic(line),
    });
    this.runtime = runtime;

    try {
      await runtime.start(config);
    } catch (error) {
      this.runtime = null;
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
    if (runtime) await runtime.stop();
    this.state = null;
    this.watchingSessionNameFor = null;
    this.runtimeVersion = null;
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
      const state = await this.runtime.getState();
      if (state.sessionId !== this.state?.sessionId) this.firstMessage = null;
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

  private handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'agent_start':
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
        this.setStatus('retrying', event.message || null);
        break;
      case 'compaction_end':
      case 'retry_end':
        if (this.status === 'compacting' || this.status === 'retrying') {
          this.setStatus('running', null);
        }
        break;
      case 'agent_settled':
        // Idle depends on agent_settled, never merely agent_end.
        this.setStatus('idle', null);
        void this.refreshState(true);
        break;
      case 'runtime_error':
        this.setStatus('idle', event.message);
        break;
      default:
        break;
    }
    this.broadcast({ type: 'agent', event });
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

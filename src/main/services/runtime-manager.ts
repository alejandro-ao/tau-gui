import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentEvent,
  RuntimeLaunchConfig,
  RuntimeStatus,
  ProjectTrust,
} from '../../shared/domain.js';
import { authFlowEventSchema, type BridgeEvent, type RuntimeSnapshot } from '../../shared/ipc.js';
import type { AgentRuntime, RuntimeAgentState, RuntimeSink } from '../runtime/agent-runtime.js';
import { DEFAULT_CAPABILITIES } from '../../shared/domain.js';
import type { SettingsStore } from './settings.js';
import { rendererSettings } from './session-identity.js';

const execFileAsync = promisify(execFile);
const MAX_DIAGNOSTICS = 500;
const SESSION_NAME_POLL_INTERVAL_MS = 100;
const SESSION_NAME_POLL_LIMIT = 300;

/**
 * Owns the embedded session lifecycle and the derived state machine:
 * starting → idle → running → compacting/retrying → idle (on agent_settled)
 * → failed/disconnected.
 */
export type RuntimeFactory = (sink: RuntimeSink) => AgentRuntime;

export interface RuntimeManagerOptions {
  runtimeFactory: RuntimeFactory;
  /** Pool-owned synchronous claim around non-lifecycle AgentSession mutations. */
  claimSessionMutation?: () => () => void;
}

export class RuntimeManager {
  private runtime: AgentRuntime | null = null;
  private status: RuntimeStatus = 'stopped';
  private detail: string | null = null;
  private cwd: string | null = null;
  private gitBranch: string | null = null;
  private state: RuntimeAgentState | null = null;
  private runtimeVersion: string | null = null;
  private launchProjectTrust: ProjectTrust | null = null;
  private firstMessage: string | null = null;
  /** Prevents stale duplicate settles from changing an active run's UI status. */
  private settleExpected = true;
  private loadingFirstMessageFor: string | null = null;
  private watchingSessionNameFor: string | null = null;
  private readonly diagnostics: string[] = [];

  private readonly runtimeFactory: RuntimeFactory;
  private readonly claimSessionMutation: () => () => void;

  constructor(
    private readonly settings: SettingsStore,
    private readonly broadcast: (event: BridgeEvent) => void,
    options: RuntimeManagerOptions,
  ) {
    this.runtimeFactory = options.runtimeFactory;
    this.claimSessionMutation = options.claimSessionMutation ?? (() => () => undefined);
  }

  get kind(): 'pi' {
    return 'pi';
  }

  get active(): AgentRuntime {
    if (!this.runtime) throw new Error('Runtime is not started');
    return this.runtime;
  }

  get isStarted(): boolean {
    return this.runtime !== null;
  }

  /** Trust passed to the active session, unaffected by later settings edits. */
  get effectiveProjectTrust(): ProjectTrust | null {
    return this.runtime ? this.launchProjectTrust : null;
  }

  get internalState(): RuntimeAgentState | null {
    return this.state;
  }

  snapshot(): RuntimeSnapshot {
    const state = this.state;
    return {
      runtime: this.kind,
      status: this.status,
      detail: this.detail,
      runtimeVersion: this.runtimeVersion,
      capabilities: this.runtime?.capabilities ?? DEFAULT_CAPABILITIES,
      cwd: this.cwd,
      gitBranch: this.gitBranch,
      state: state
        ? {
            model: state.model,
            thinkingLevel: state.thinkingLevel,
            isStreaming: state.isStreaming,
            isCompacting: state.isCompacting,
            persisted: state.persisted,
            sessionId: state.sessionId,
            sessionName: state.sessionName,
            autoCompactionEnabled: state.autoCompactionEnabled,
            messageCount: state.messageCount,
            pendingMessageCount: state.pendingMessageCount,
          }
        : null,
    };
  }

  listDiagnostics(): string[] {
    return [...this.diagnostics];
  }

  async start(
    options: {
      cwd?: string | null;
      sessionRef?: string | null;
    } = {},
  ): Promise<RuntimeSnapshot> {
    if (this.runtime) await this.stop();
    const settings = this.settings.current;
    const cwd = options.cwd ?? settings.cwd ?? process.cwd();
    const config: RuntimeLaunchConfig = {
      cwd,
      sessionRef: options.sessionRef ?? null,
      projectTrust: settings.projectTrust,
      customSkillDirectories: settings.customSkillDirectories,
      customPromptDirectories: settings.customPromptDirectories,
    };

    this.runtimeVersion = null;
    this.cwd = cwd;
    this.gitBranch = await readGitBranch(cwd);
    const runtime = this.runtimeFactory({
      event: (event) => this.handleEvent(event),
      status: (status, detail) => this.setStatus(status, detail ?? null),
      diagnostic: (line) => this.addDiagnostic(line),
      auth: (event) => this.broadcast({ type: 'auth', event: authFlowEventSchema.parse(event) }),
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
  async refreshState(touch = false): Promise<RuntimeAgentState | null> {
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

  async nameSession(name: string): Promise<void> {
    if (!this.runtime || !this.state?.sessionId) throw new Error('Runtime is not started');
    const release = this.claimSessionMutation();
    try {
      await this.runtime.nameSession(name);
      await this.refreshState();
    } finally {
      release();
    }
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
          void this.refreshState(true);
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

  /** Poll Pi's authoritative state so a generated first-turn title reaches the UI promptly. */
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
    this.broadcast({ type: 'settings', settings: rendererSettings(this.settings.current) });
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

function describeStartFailure(_config: RuntimeLaunchConfig, error: Error): string {
  return `Failed to start embedded Pi: ${error.message}`;
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

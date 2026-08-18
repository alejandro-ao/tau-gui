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
  private readonly diagnostics: string[] = [];

  constructor(
    private readonly settings: SettingsStore,
    private readonly broadcast: (event: BridgeEvent) => void,
  ) {}

  get kind(): RuntimeKind {
    return this.settings.current.agentRuntime;
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
    const runtimeSettings = settings.runtime[settings.agentRuntime];
    const config: RuntimeLaunchConfig = {
      kind: settings.agentRuntime,
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
    this.runtimeVersion = probe.version;
    if (probe.version) this.addDiagnostic(`${config.kind} ${probe.version}`);

    this.cwd = cwd;
    this.gitBranch = await readGitBranch(cwd);
    const runtime = new JsonlAgentRuntime(settings.agentRuntime, {
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
      this.state = state;
      if (state.sessionId) {
        this.settings.rememberSession(
          {
            id: state.sessionId,
            name: state.sessionName,
            path: state.sessionFile,
            cwd: this.cwd,
            runtime: this.kind,
            lastSeen: Date.now(),
          },
          touch,
        );
        this.broadcast({ type: 'settings', settings: this.settings.current });
      }
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

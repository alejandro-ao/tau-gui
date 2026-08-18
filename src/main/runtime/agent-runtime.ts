import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type {
  AgentEvent,
  AgentMessage,
  AgentState,
  BashResult,
  CommandInfo,
  CompactionResult,
  EntrySnapshot,
  Model,
  ModelCycleResult,
  ModelRef,
  PromptInput,
  RuntimeCapabilities,
  RuntimeKind,
  RuntimeLaunchConfig,
  RuntimeStatus,
  SessionStats,
  ThinkingLevel,
  TreeSnapshot,
} from '../../shared/domain.js';
import { RpcClient, RpcError } from '../rpc/client.js';
import {
  normalizeEntries,
  normalizeEvent,
  normalizeMessages,
  normalizeModel,
  normalizeState,
  normalizeStats,
  normalizeThinkingLevel,
  normalizeTree,
} from './normalize.js';
import { CAPABILITIES, buildLaunchSpec } from './spec.js';

export interface RuntimeSink {
  event(event: AgentEvent): void;
  status(status: RuntimeStatus, detail?: string | null): void;
  diagnostic(line: string): void;
}

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  readonly capabilities: RuntimeCapabilities;
  start(config: RuntimeLaunchConfig): Promise<void>;
  stop(): Promise<void>;
  prompt(input: PromptInput): Promise<void>;
  steer(input: PromptInput): Promise<void>;
  followUp(input: PromptInput): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<AgentState>;
  getMessages(): Promise<AgentMessage[]>;
  getEntries(cursor?: string): Promise<EntrySnapshot>;
  getTree(): Promise<TreeSnapshot>;
  getStats(): Promise<SessionStats>;
  listModels(): Promise<Model[]>;
  setModel(ref: ModelRef): Promise<Model | null>;
  cycleModel(): Promise<ModelCycleResult | null>;
  listThinkingLevels(): Promise<ThinkingLevel[]>;
  setThinking(level: ThinkingLevel): Promise<void>;
  cycleThinking(): Promise<ThinkingLevel | null>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  compact(instructions?: string): Promise<CompactionResult>;
  runShell(command: string, excludeFromContext: boolean): Promise<BashResult>;
  abortShell(): Promise<void>;
  newSession(): Promise<void>;
  switchSession(ref: string): Promise<void>;
  nameSession(name: string): Promise<void>;
  fork(entryId: string): Promise<string>;
  exportHtml(path?: string): Promise<string>;
  listCommands(): Promise<CommandInfo[]>;
}

/** Extension status text may carry terminal colour codes meant for a TUI. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

/** stdout flow-control thresholds (bytes of undecoded backlog). */
export const STDOUT_BACKLOG_LIMIT = 4 * 1024 * 1024;
export const STDOUT_RESUME_LIMIT = 1 * 1024 * 1024;

export interface JsonlRuntimeOptions {
  /** Pause stdout once this many undecoded bytes are queued. */
  stdoutHighWaterMark?: number;
  /** Resume stdout once the backlog falls to this many bytes. */
  stdoutLowWaterMark?: number;
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

/**
 * Shared JSONL runtime adapter. Tau and Pi differ only in launch arguments and
 * capability flags, so a single subprocess implementation serves both.
 */
export class JsonlAgentRuntime implements AgentRuntime {
  readonly capabilities: RuntimeCapabilities;
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: RpcClient | null = null;
  private stopping = false;
  /** Records waiting for stdin to drain, in submission order. */
  private writeQueue: string[] = [];
  private draining = false;
  /** stdout chunks received but not yet decoded, in arrival order. */
  private stdoutQueue: Buffer[] = [];
  private stdoutBacklog = 0;
  private stdoutPaused = false;
  private pumping = false;
  private readonly highWaterMark: number;
  private readonly lowWaterMark: number;
  /** Observable for tests: how often stdout had to be paused. */
  private pauses = 0;

  constructor(
    readonly kind: RuntimeKind,
    private readonly sink: RuntimeSink,
    options: JsonlRuntimeOptions = {},
  ) {
    this.capabilities = CAPABILITIES[kind];
    this.highWaterMark = options.stdoutHighWaterMark ?? STDOUT_BACKLOG_LIMIT;
    this.lowWaterMark = options.stdoutLowWaterMark ?? STDOUT_RESUME_LIMIT;
  }

  get flowControlPauses(): number {
    return this.pauses;
  }

  get running(): boolean {
    return this.child !== null;
  }

  async start(config: RuntimeLaunchConfig): Promise<void> {
    if (this.child) throw new Error('Runtime is already started');
    this.stopping = false;
    this.sink.status('starting');
    const spec = buildLaunchSpec(config);

    let child: ChildProcessWithoutNullStreams;
    try {
      // Argument arrays only: never build a shell command string.
      child = spawn(config.binary, spec.args, {
        cwd: config.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (error) {
      this.sink.status('failed', (error as Error).message);
      throw error;
    }

    this.child = child;
    this.writeQueue = [];
    this.draining = false;
    this.stdoutQueue = [];
    this.stdoutBacklog = 0;
    this.stdoutPaused = false;
    this.pumping = false;
    const client = new RpcClient({
      write: (data) => {
        this.writeToStdin(child, data);
      },
      onEvent: (wire) => {
        if (wire['type'] === 'extension_ui_request') {
          this.handleExtensionUiRequest(wire);
          return;
        }
        const event = normalizeEvent(wire);
        if (event) this.sink.event(event);
        else this.sink.diagnostic(`Ignored unknown runtime event: ${String(wire['type'])}`);
      },
      onDiagnostic: (message) => this.sink.diagnostic(message),
    });
    this.client = client;

    child.stdout.on('data', (chunk: Buffer) => this.enqueueStdout(child, client, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) if (line.trim()) this.sink.diagnostic(line);
    });
    child.on('error', (error) => {
      this.child = null;
      client.handleClose(`Runtime failed to start: ${error.message}`);
      this.sink.status('failed', error.message);
    });
    child.on('exit', (code, signal) => {
      this.child = null;
      // Decode everything already received before rejecting pending requests.
      this.drainStdout(client);
      client.handleClose(`Runtime exited (code ${String(code)}, signal ${String(signal)})`);
      if (this.stopping) {
        this.sink.status('stopped');
      } else {
        this.sink.status(
          'disconnected',
          `Runtime exited unexpectedly (code ${String(code)}, signal ${String(signal)})`,
        );
      }
    });

    // Probe the connection; this also surfaces a missing/broken binary early.
    const state = await this.getState();
    if (spec.deferredSessionRef) await this.switchSession(spec.deferredSessionRef);
    this.sink.status(state.isStreaming ? 'running' : 'idle');
  }

  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.stopping = true;
    // EOF on stdin asks the runtime to shut down cleanly.
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.client = null;
    this.writeQueue = [];
    this.draining = false;
    this.stdoutQueue = [];
    this.stdoutBacklog = 0;
  }

  /**
   * Flow control for stdout: chunks are queued and decoded one per tick, and
   * the pipe is paused while the undecoded backlog exceeds the high-water mark.
   * The queue preserves arrival order, so records are never lost or reordered.
   */
  private enqueueStdout(
    child: ChildProcessWithoutNullStreams,
    client: RpcClient,
    chunk: Buffer,
  ): void {
    this.stdoutQueue.push(chunk);
    this.stdoutBacklog += chunk.length;
    if (!this.stdoutPaused && this.stdoutBacklog > this.highWaterMark) {
      this.stdoutPaused = true;
      this.pauses += 1;
      child.stdout.pause();
    }
    if (this.pumping) return;
    this.pumping = true;
    const step = (): void => {
      const next = this.stdoutQueue.shift();
      if (!next) {
        this.pumping = false;
        return;
      }
      this.stdoutBacklog -= next.length;
      try {
        client.handleChunk(next);
      } finally {
        if (this.stdoutPaused && this.stdoutBacklog <= this.lowWaterMark) {
          this.stdoutPaused = false;
          child.stdout.resume();
        }
        setImmediate(step);
      }
    };
    setImmediate(step);
  }

  /** Decode every queued chunk immediately (used on exit). */
  private drainStdout(client: RpcClient): void {
    const queued = this.stdoutQueue;
    this.stdoutQueue = [];
    this.stdoutBacklog = 0;
    for (const chunk of queued) client.handleChunk(chunk);
  }

  /**
   * Honour stdin backpressure: once `write()` reports a full kernel buffer,
   * later records queue in order and are flushed on `drain`.
   */
  private writeToStdin(child: ChildProcessWithoutNullStreams, data: string): void {
    if (this.draining) {
      this.writeQueue.push(data);
      return;
    }
    if (!child.stdin.write(data)) {
      this.draining = true;
      child.stdin.once('drain', () => this.flushStdin(child));
    }
  }

  private flushStdin(child: ChildProcessWithoutNullStreams): void {
    while (this.writeQueue.length > 0) {
      const next = this.writeQueue.shift() as string;
      if (!child.stdin.write(next)) {
        child.stdin.once('drain', () => this.flushStdin(child));
        return;
      }
    }
    this.draining = false;
  }

  /**
   * Pi extensions can request interactive dialogs on the same stream. Desktop
   * extension dialogs are gated behind `extensionDialogs`, so blocking dialog
   * methods are dismissed immediately instead of hanging the runtime, and
   * fire-and-forget status updates are recorded as diagnostics.
   */
  private handleExtensionUiRequest(wire: Record<string, unknown>): void {
    const method = typeof wire['method'] === 'string' ? wire['method'] : 'unknown';
    const id = wire['id'];
    const blocking =
      method === 'select' || method === 'confirm' || method === 'input' || method === 'editor';
    if (blocking && (typeof id === 'string' || typeof id === 'number')) {
      this.client?.notify({ type: 'extension_ui_response', id, cancelled: true });
      this.sink.diagnostic(
        `Dismissed unsupported extension dialog (${method}); desktop extension dialogs are not available yet`,
      );
      return;
    }
    const text = ['message', 'statusText', 'title', 'text']
      .map((key) => (typeof wire[key] === 'string' ? wire[key] : ''))
      .find((value) => value.length > 0);
    this.sink.diagnostic(`extension ${method}${text ? `: ${stripAnsi(text)}` : ''}`);
  }

  private get rpc(): RpcClient {
    if (!this.client) throw new RpcError('Runtime is not started', 'none');
    return this.client;
  }

  prompt(input: PromptInput): Promise<void> {
    return this.rpc.request<void>('prompt', { message: input.text }, 0).then(() => undefined);
  }

  steer(input: PromptInput): Promise<void> {
    return this.rpc
      .request<void>('prompt', { message: input.text, streamingBehavior: 'steer' }, 0)
      .then(() => undefined);
  }

  followUp(input: PromptInput): Promise<void> {
    return this.rpc
      .request<void>('prompt', { message: input.text, streamingBehavior: 'followUp' }, 0)
      .then(() => undefined);
  }

  async abort(): Promise<void> {
    await this.rpc.request('abort');
  }

  async getState(): Promise<AgentState> {
    return normalizeState(await this.rpc.request('get_state', {}, 20_000));
  }

  async getMessages(): Promise<AgentMessage[]> {
    const data = asRecord(await this.rpc.request('get_messages'));
    return normalizeMessages(data['messages']);
  }

  async getEntries(cursor?: string): Promise<EntrySnapshot> {
    const params = cursor ? { since: cursor } : {};
    const data = asRecord(await this.rpc.request('get_entries', params));
    return {
      entries: normalizeEntries(data['entries']),
      leafId: typeof data['leafId'] === 'string' ? data['leafId'] : null,
    };
  }

  async getTree(): Promise<TreeSnapshot> {
    const data = asRecord(await this.rpc.request('get_tree'));
    return {
      tree: normalizeTree(data['tree']),
      leafId: typeof data['leafId'] === 'string' ? data['leafId'] : null,
    };
  }

  async getStats(): Promise<SessionStats> {
    return normalizeStats(await this.rpc.request('get_session_stats'));
  }

  async listModels(): Promise<Model[]> {
    const data = asRecord(await this.rpc.request('get_available_models'));
    const models = Array.isArray(data['models']) ? data['models'] : [];
    return models
      .map(normalizeModel)
      .filter((model): model is Model => model !== null && model.id.length > 0);
  }

  async setModel(ref: ModelRef): Promise<Model | null> {
    const data = await this.rpc.request('set_model', {
      modelId: ref.modelId,
      provider: ref.provider,
    });
    return normalizeModel(data);
  }

  async cycleModel(): Promise<ModelCycleResult | null> {
    const data = await this.rpc.request('cycle_model');
    if (data === null || data === undefined) return null;
    const wire = asRecord(data);
    const model = normalizeModel(wire['model']);
    if (!model) return null;
    return {
      model,
      thinkingLevel: normalizeThinkingLevel(wire['thinkingLevel']),
      isScoped: wire['isScoped'] === true,
    };
  }

  async listThinkingLevels(): Promise<ThinkingLevel[]> {
    const data = asRecord(await this.rpc.request('get_available_thinking_levels'));
    const levels = Array.isArray(data['levels']) ? data['levels'] : [];
    return levels.map((level) => normalizeThinkingLevel(level));
  }

  async setThinking(level: ThinkingLevel): Promise<void> {
    await this.rpc.request('set_thinking_level', { level });
  }

  async cycleThinking(): Promise<ThinkingLevel | null> {
    const data = await this.rpc.request('cycle_thinking_level');
    if (data === null || data === undefined) return null;
    return normalizeThinkingLevel(asRecord(data)['level']);
  }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    await this.rpc.request('set_auto_compaction', { enabled });
  }

  async compact(instructions?: string): Promise<CompactionResult> {
    const params = instructions ? { customInstructions: instructions } : {};
    const data = asRecord(await this.rpc.request('compact', params, 0));
    return {
      summary: typeof data['summary'] === 'string' ? data['summary'] : '',
      firstKeptEntryId:
        typeof data['firstKeptEntryId'] === 'string' ? data['firstKeptEntryId'] : null,
      tokensBefore: typeof data['tokensBefore'] === 'number' ? data['tokensBefore'] : 0,
      estimatedTokensAfter:
        typeof data['estimatedTokensAfter'] === 'number' ? data['estimatedTokensAfter'] : 0,
    };
  }

  async runShell(command: string, excludeFromContext: boolean): Promise<BashResult> {
    const data = asRecord(await this.rpc.request('bash', { command, excludeFromContext }, 0));
    return {
      command,
      output: typeof data['output'] === 'string' ? data['output'] : '',
      exitCode: typeof data['exitCode'] === 'number' ? data['exitCode'] : null,
      cancelled: data['cancelled'] === true,
      truncated: data['truncated'] === true,
    };
  }

  async abortShell(): Promise<void> {
    if (!this.capabilities.abortBash) {
      throw new Error(`${this.kind} does not support cancelling direct shell commands`);
    }
    await this.rpc.request('abort_bash');
  }

  async newSession(): Promise<void> {
    await this.rpc.request('new_session');
  }

  async switchSession(ref: string): Promise<void> {
    // Tau resumes by indexed session id; Pi resumes by session path. Exactly
    // one field is sent so the runtime never has to disambiguate.
    const params = this.kind === 'tau' ? { sessionId: ref } : { sessionPath: ref };
    await this.rpc.request('switch_session', params);
  }

  async nameSession(name: string): Promise<void> {
    await this.rpc.request('set_session_name', { name });
  }

  async fork(entryId: string): Promise<string> {
    const data = asRecord(await this.rpc.request('fork', { entryId }));
    return typeof data['text'] === 'string' ? data['text'] : '';
  }

  async exportHtml(path?: string): Promise<string> {
    const params = path ? { outputPath: path } : {};
    const data = asRecord(await this.rpc.request('export_html', params, 0));
    return typeof data['path'] === 'string' ? data['path'] : '';
  }

  async listCommands(): Promise<CommandInfo[]> {
    const data = asRecord(await this.rpc.request('get_commands'));
    const commands = Array.isArray(data['commands']) ? data['commands'] : [];
    return commands.map((item) => {
      const wire = asRecord(item);
      return {
        name: typeof wire['name'] === 'string' ? wire['name'] : '',
        description: typeof wire['description'] === 'string' ? wire['description'] : '',
        source: 'runtime' as const,
      };
    });
  }
}

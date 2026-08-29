import { createHash, randomUUID } from 'node:crypto';
import { opendir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { utilityProcess } from 'electron';
import {
  EXTENSION_LIMITS,
  extensionHostStatusSchema,
  extensionPolicySchema,
  extensionResourceListSchema,
  extensionUiEventSchema,
  type ExtensionHostStatus,
  type ExtensionPolicy,
  type ExtensionResource,
  type ExtensionUiEvent,
} from '../../shared/extensions.js';

const BLOCKER =
  'Pi 0.84.2 binds extensions directly to in-process AgentSession objects; no public serializable extension-host adapter exists. Third-party execution remains disabled.';

interface HostProcess {
  stderr?: { on(event: 'data', listener: (data: Buffer) => void): unknown } | null;
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  kill(): boolean;
}

type SpawnHost = (path: string) => HostProcess;

interface PendingDialog {
  extensionId: string;
  timer: ReturnType<typeof setTimeout>;
}

/** App-owned utility-process supervisor and fail-closed extension UI broker. */
export class ExtensionHostService {
  private policy: ExtensionPolicy = {
    userEnabled: false,
    projectEnabled: false,
    executionAvailable: false,
    blocker: BLOCKER,
  };
  private host: HostProcess | null = null;
  private status: ExtensionHostStatus = { status: 'stopped', crashes: 0, detail: 'Not started' };
  private pendingReady: {
    nonce: string;
    resolve: () => void;
    reject: (error: Error) => void;
  } | null = null;
  private readonly dialogs = new Map<string, PendingDialog>();
  private stopping = false;

  constructor(
    private readonly options: {
      agentDir: string;
      policyPath: string;
      workerPath: string;
      broadcast: (event: ExtensionUiEvent) => void;
      spawn?: SpawnHost;
    },
  ) {}

  async load(): Promise<void> {
    try {
      const parsed = extensionPolicySchema.safeParse(
        JSON.parse(await readFile(this.options.policyPath, 'utf8')),
      );
      if (parsed.success)
        this.policy = { ...parsed.data, executionAvailable: false, blocker: BLOCKER };
    } catch {
      // Missing/malformed policy is the secure disabled default.
    }
  }

  getPolicy(): ExtensionPolicy {
    return { ...this.policy, executionAvailable: false, blocker: BLOCKER };
  }

  async updatePolicy(patch: {
    userEnabled?: boolean;
    projectEnabled?: boolean;
  }): Promise<ExtensionPolicy> {
    this.policy = extensionPolicySchema.parse({
      ...this.policy,
      ...patch,
      executionAvailable: false,
      blocker: BLOCKER,
    });
    await writeFile(this.options.policyPath, `${JSON.stringify(this.policy, null, 2)}\n`, {
      mode: 0o600,
    });
    return this.getPolicy();
  }

  async list(cwd: string | null, projectTrusted: boolean): Promise<ExtensionResource[]> {
    const user = await discover(
      join(this.options.agentDir, 'extensions'),
      'user',
      true,
      this.policy.userEnabled,
    );
    const project = cwd
      ? await discover(
          join(cwd, '.pi', 'extensions'),
          'project',
          projectTrusted,
          this.policy.projectEnabled,
        )
      : [];
    return extensionResourceListSchema.parse(
      [...user, ...project].slice(0, EXTENSION_LIMITS.resources),
    );
  }

  getStatus(): ExtensionHostStatus {
    return extensionHostStatusSchema.parse(this.status);
  }

  async probe(): Promise<ExtensionHostStatus> {
    if (this.host && this.status.status === 'ready') return this.getStatus();
    await this.startHost();
    return this.getStatus();
  }

  respondDialog(requestId: string, value: string | boolean | null): void {
    const pending = this.dialogs.get(requestId);
    if (!pending || !this.host) throw new Error('Extension dialog is no longer active');
    clearTimeout(pending.timer);
    this.dialogs.delete(requestId);
    this.host.postMessage({ type: 'dialog_response', requestId, value: boundedResponse(value) });
    this.options.broadcast({
      type: 'dialog_closed',
      requestId,
      reason: value === null ? 'cancelled' : 'answered',
    });
  }

  stop(): void {
    this.stopping = true;
    this.pendingReady?.reject(new Error('Extension host stopped'));
    this.pendingReady = null;
    this.closeDialogs('crash');
    this.host?.postMessage({ type: 'shutdown' });
    this.host?.kill();
    this.host = null;
    this.setStatus('stopped', 'Stopped');
  }

  private async startHost(): Promise<void> {
    this.stopping = false;
    this.setStatus('starting', 'Starting isolated utility process');
    const spawn =
      this.options.spawn ??
      ((path) =>
        utilityProcess.fork(path, [], {
          serviceName: 'Tau Extension Host',
          stdio: 'pipe',
        }));
    const host = spawn(this.options.workerPath);
    host.stderr?.on('data', (data: Buffer) => {
      // Utility stderr is main-only and intentionally not forwarded to renderer.
      console.error(`Extension host failed (${data.byteLength} diagnostic bytes)`);
    });
    this.host = host;
    host.on('message', (message) => this.handleMessage(message));
    host.once('exit', (code) => this.handleExit(code));
    const nonce = randomUUID();
    await new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        if (this.pendingReady?.nonce === nonce) this.pendingReady = null;
        rejectReady(new Error('Extension host startup timed out'));
        host.kill();
      }, 5_000);
      this.pendingReady = {
        nonce,
        resolve: () => {
          clearTimeout(timer);
          resolveReady();
        },
        reject: (error) => {
          clearTimeout(timer);
          rejectReady(error);
        },
      };
      host.postMessage({ type: 'ping', nonce });
    });
    this.setStatus('ready', 'Isolation boundary ready; third-party execution blocked');
  }

  private handleMessage(raw: unknown): void {
    if (serializedBytes(raw) > EXTENSION_LIMITS.messageBytes) {
      this.host?.kill();
      return;
    }
    const pendingReady = this.pendingReady;
    if (
      isRecord(raw) &&
      pendingReady &&
      raw['type'] === 'ready' &&
      raw['nonce'] === pendingReady.nonce
    ) {
      this.pendingReady = null;
      pendingReady.resolve();
      return;
    }
    if (!isRecord(raw) || raw['type'] !== 'ui') return;
    const parsed = extensionUiEventSchema.safeParse(raw['event']);
    if (!parsed.success) {
      this.host?.kill();
      return;
    }
    const event = parsed.data;
    if (event.type === 'dialog') this.trackDialog(event);
    this.options.broadcast(event);
  }

  private trackDialog(event: Extract<ExtensionUiEvent, { type: 'dialog' }>): void {
    if (this.dialogs.has(event.dialog.requestId)) return;
    const timer = setTimeout(() => {
      this.dialogs.delete(event.dialog.requestId);
      this.host?.postMessage({
        type: 'dialog_response',
        requestId: event.dialog.requestId,
        value: null,
      });
      this.options.broadcast({
        type: 'dialog_closed',
        requestId: event.dialog.requestId,
        reason: 'timeout',
      });
    }, event.dialog.timeoutMs);
    this.dialogs.set(event.dialog.requestId, { extensionId: event.dialog.extensionId, timer });
  }

  private handleExit(code: number): void {
    this.host = null;
    this.pendingReady?.reject(new Error('Extension host exited'));
    this.pendingReady = null;
    this.closeDialogs('crash');
    if (this.stopping) return;
    const crashes = Math.min(3, this.status.crashes + 1);
    this.status = { status: 'crashed', crashes, detail: `Utility process exited (${code})` };
    this.options.broadcast({ type: 'host', status: 'crashed', detail: this.status.detail });
    if (crashes < 3) {
      setTimeout(() => void this.startHost().catch(() => undefined), crashes * 100);
    } else {
      this.setStatus('blocked', 'Extension host crash limit reached');
    }
  }

  private closeDialogs(reason: 'crash'): void {
    for (const [requestId, pending] of this.dialogs) {
      clearTimeout(pending.timer);
      this.options.broadcast({ type: 'dialog_closed', requestId, reason });
    }
    this.dialogs.clear();
  }

  private setStatus(status: ExtensionHostStatus['status'], detail: string): void {
    this.status = { status, crashes: this.status.crashes, detail: detail.slice(0, 1_000) };
    this.options.broadcast({ type: 'host', status, detail: this.status.detail });
  }
}

async function discover(
  directory: string,
  scope: 'user' | 'project',
  trusted: boolean,
  enabledRequested: boolean,
): Promise<ExtensionResource[]> {
  let handle;
  try {
    handle = await opendir(directory);
    const resources: ExtensionResource[] = [];
    for await (const entry of handle) {
      if (resources.length >= EXTENSION_LIMITS.resources) break;
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      if (entry.isFile() && !/\.[cm]?[jt]s$/i.test(entry.name)) continue;
      const name = entry.isDirectory()
        ? entry.name
        : basename(entry.name, join('', entry.name).slice(entry.name.lastIndexOf('.')));
      const path = resolve(directory, entry.name);
      resources.push({
        id: deterministicUuid(path),
        name: sanitize(name, 200),
        scope,
        enabledRequested,
        trusted,
        execution: 'blocked',
        reason: trusted ? BLOCKER : 'Project extension is not trusted',
      });
    }
    return resources;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function deterministicUuid(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 32);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

function sanitize(value: string, max: number): string {
  return (
    [...value]
      .map((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code <= 0x1f || code === 0x7f ? ' ' : character;
      })
      .join('')
      .trim()
      .slice(0, max) || 'extension'
  );
}

function boundedResponse(value: string | boolean | null): string | boolean | null {
  return typeof value === 'string' ? value.slice(0, EXTENSION_LIMITS.editorText) : value;
}

function serializedBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

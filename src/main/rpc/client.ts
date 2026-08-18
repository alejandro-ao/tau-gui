import { JsonlDecoder, encodeRecord } from './jsonl.js';

export interface RpcClientOptions {
  /** Writes one framed record to the runtime's stdin. */
  write: (data: string) => void;
  /** Receives every non-response record (asynchronous runtime events). */
  onEvent: (record: Record<string, unknown>) => void;
  /** Receives protocol-level problems that are not tied to a request. */
  onDiagnostic: (message: string) => void;
  /** Default request timeout in milliseconds. */
  timeoutMs?: number;
  maxRecordBytes?: number;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly command: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface Pending {
  command: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Correlated JSONL request client. Transport-agnostic: the owner feeds stdout
 * chunks in and supplies a stdin writer.
 */
export class RpcClient {
  private readonly decoder: JsonlDecoder;
  private readonly pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly options: RpcClientOptions) {
    this.decoder = options.maxRecordBytes
      ? new JsonlDecoder({ maxRecordBytes: options.maxRecordBytes })
      : new JsonlDecoder();
  }

  request<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.options.timeoutMs ?? 120_000,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new RpcError('Runtime connection is closed', command));
    }
    const id = `r${this.nextId++}`;
    const record = { id, type: command, ...params };
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RpcError(`Request timed out after ${timeoutMs}ms`, command));
            }, timeoutMs)
          : null;
      this.pending.set(id, {
        command,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.options.write(encodeRecord(record));
      } catch (error) {
        this.settle(id, () => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
  }

  handleChunk(chunk: Uint8Array | string): void {
    for (const result of this.decoder.push(chunk)) this.handleRecord(result);
  }

  /** Called when the runtime's stdout ends. Rejects everything outstanding. */
  handleClose(reason = 'Runtime process exited'): void {
    for (const result of this.decoder.flush()) this.handleRecord(result);
    this.closed = true;
    for (const [id, entry] of [...this.pending]) {
      this.settle(id, () => entry.reject(new RpcError(reason, entry.command)));
    }
  }

  private handleRecord(result: ReturnType<JsonlDecoder['push']>[number]): void {
    if (!result.ok) {
      this.options.onDiagnostic(result.error);
      return;
    }
    const record = result.value;
    if (record['type'] === 'response') {
      this.handleResponse(record);
      return;
    }
    this.options.onEvent(record);
  }

  private handleResponse(record: Record<string, unknown>): void {
    const command = typeof record['command'] === 'string' ? record['command'] : 'unknown';
    const id = record['id'];
    if (typeof id !== 'string' || !this.pending.has(id)) {
      const error = typeof record['error'] === 'string' ? record['error'] : null;
      this.options.onDiagnostic(
        error
          ? `Uncorrelated runtime error (${command}): ${error}`
          : `Uncorrelated runtime response (${command})`,
      );
      return;
    }
    const entry = this.pending.get(id) as Pending;
    this.settle(id, () => {
      if (record['success'] === true) {
        entry.resolve(record['data']);
      } else {
        const message =
          typeof record['error'] === 'string' ? record['error'] : 'Runtime request failed';
        entry.reject(new RpcError(message, command));
      }
    });
  }

  private settle(id: string, action: () => void): void {
    const entry = this.pending.get(id);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(id);
    action();
  }
}

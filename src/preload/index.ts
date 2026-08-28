import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BridgeEvent,
  IpcAction,
  IpcResponse,
  IpcResult,
  SessionTarget,
} from '../shared/ipc.js';
import {
  bridgeEventSchema,
  contextFilesSchema,
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  resourceCatalogSchema,
  parseSessionIpcResult,
} from '../shared/ipc.js';

/**
 * Narrow, context-isolated bridge. The renderer gets exactly two capabilities:
 * a validated request/response call and a subscription to domain events.
 */
export interface TauBridge {
  /**
   * `session` binds the call to one transcript. The main process routes the
   * command to that session's runtime instead of the selected one, so a
   * session switch in flight can never redirect a prompt or a read.
   */
  invoke<A extends IpcAction>(
    action: A,
    payload?: Record<string, unknown>,
    session?: SessionTarget,
  ): Promise<IpcResult<A>>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  /** Filesystem path of a dropped file; empty when Electron withholds it. */
  pathForFile(file: File): string;
  platform: string;
}

const bridge: TauBridge = {
  async invoke(action, payload, session) {
    const request: Record<string, unknown> = { action };
    if (payload !== undefined) request['payload'] = payload;
    if (session !== undefined) request['session'] = session;
    const response = (await ipcRenderer.invoke(IPC_INVOKE_CHANNEL, request)) as IpcResponse;
    if (!response || typeof response !== 'object' || !('ok' in response)) {
      throw new Error('Malformed IPC response');
    }
    if (!response.ok) {
      if (typeof response.error !== 'string' || response.error.length > 1_000) {
        throw new Error('Malformed IPC error');
      }
      throw new Error(response.error);
    }
    if (action === 'resources.list') {
      return resourceCatalogSchema.parse(response.value) as IpcResult<typeof action>;
    }
    if (action === 'context.list') {
      return contextFilesSchema.parse(response.value) as IpcResult<typeof action>;
    }
    return parseSessionIpcResult(action, response.value) as IpcResult<typeof action>;
  },
  subscribe(listener) {
    const handler = (_event: unknown, payload: unknown): void => {
      const parsed = bridgeEventSchema.safeParse(payload);
      if (parsed.success) listener(parsed.data);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler);
    };
  },
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('tau', bridge);
